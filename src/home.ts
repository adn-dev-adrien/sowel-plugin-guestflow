import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuestFlowClient } from "./client.js";
import type {
  DeviceManager,
  DiscoveredDevice,
  HomeCatalogEntry,
  HomeCommand,
  HomeReading,
  HomeResult,
  HomeSeries,
  Logger,
} from "./types.js";

// ============================================================
// Home automation (spec 002): the plugin CARRIES, it never decides nor acts.
//
// A Sowel token cannot be scoped, so guestFlow holds none: the house calls it.
// The `guest-home` recipe — the only part that reads equipments and sends
// orders — hands this bridge what to send (catalogue, readings, series,
// verdicts), and reads from it what guestFlow answered (the selection) and
// asked (the guests' commands). This file sends no order to any equipment.
// ============================================================

export const BRIDGE_ID = "home-bridge";
const PLUGIN_ID = "guestflow";
const HOUR_MS = 60 * 60_000;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** An empty answer faster than this is not a long poll: wait before asking again. */
const MIN_POLL_SPACING_MS = 5_000;
const CATALOG_FILE = "home-catalog.json";

export const BRIDGE_ORDERS = ["home_catalog", "home_readings", "home_series", "home_result"] as const;

export function describeBridge(): DiscoveredDevice {
  return {
    // The core makes the friendly name the device's source id.
    friendlyName: BRIDGE_ID,
    manufacturer: "guestFlow",
    model: "Domotique GuestFlow",
    data: [
      { key: "home_selection", type: "text", category: "generic" },
      { key: "home_command", type: "text", category: "generic" },
      // A counter, never a repeated value: the recipe acts on « strictly greater ».
      { key: "home_command_seq", type: "number", category: "generic" },
    ],
    orders: BRIDGE_ORDERS.map((key) => ({ key, type: "text" as const, category: "generic" })),
  };
}

export interface HomeBridgeDeps {
  logger: Logger;
  deviceManager: DeviceManager;
  /** A client on the current settings. */
  client: () => GuestFlowClient;
  /** From the stays the plugin already holds (spec 001). */
  isOccupied: (propertyId: number, now: number) => boolean;
  dataDir?: string;
}

function parseJson(text: unknown, what: string): unknown {
  if (typeof text !== "string") throw new Error(`Unreadable ${what}: JSON text expected`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Unreadable ${what}: not JSON`);
  }
}

function listOf(text: unknown, what: string, field: string): unknown[] {
  const parsed = parseJson(text, what);
  const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown> | null)?.[field];
  if (!Array.isArray(list)) throw new Error(`Unreadable ${what}: a list is expected`);
  return list;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class HomeBridge {
  private stopped = true;
  private abort: AbortController | null = null;
  private loopDone: Promise<void> | null = null;
  private wakeSleep: (() => void) | null = null;
  private hourly: ReturnType<typeof setInterval> | null = null;
  /** The recipe's last catalogue, and when guestFlow last took it. */
  private catalog: { text: string; sentAt: number | null } | null = null;
  private seq = 0;

  constructor(private readonly deps: HomeBridgeDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Seeded on the clock: after a plugin restart the counter still only goes up.
    this.seq = Date.now();
    try {
      this.deps.deviceManager.upsertFromDiscovery(PLUGIN_ID, PLUGIN_ID, describeBridge());
      this.deps.deviceManager.updateDeviceStatus(PLUGIN_ID, BRIDGE_ID, "online");
    } catch (err) {
      this.deps.logger.warn({ err: errText(err) }, "Home bridge device could not be declared");
    }
    this.restoreCatalog();
    if (this.catalog) void this.sendCatalog(this.catalog.text, true);
    this.hourly = setInterval(() => {
      if (this.catalog) void this.sendCatalog(this.catalog.text, true);
    }, HOUR_MS);
    this.abort = new AbortController();
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.hourly) clearInterval(this.hourly);
    this.hourly = null;
    this.abort?.abort();
    this.wakeSleep?.();
    await this.loopDone?.catch(() => {});
    this.loopDone = null;
    try {
      this.deps.deviceManager.updateDeviceStatus(PLUGIN_ID, BRIDGE_ID, "offline");
    } catch {
      // the core is going down with us
    }
  }

  /** The recipe's four orders. */
  async order(key: string, value: unknown): Promise<void> {
    switch (key) {
      case "home_catalog": {
        listOf(value, "home catalogue", "equipments");
        await this.sendCatalog(value as string, false);
        return;
      }
      case "home_readings": {
        const readings = listOf(value, "home readings", "readings") as HomeReading[];
        if (!readings.length) return;
        await this.relay("readings", () => this.deps.client().homeReadings(readings));
        return;
      }
      case "home_series": {
        const series = listOf(value, "home series", "series") as HomeSeries[];
        if (!series.length) return;
        await this.relay("series", () => this.deps.client().homeSeries(series));
        return;
      }
      case "home_result": {
        const parsed = parseJson(value, "home result");
        const results = (Array.isArray(parsed) ? parsed : [parsed]) as HomeResult[];
        await this.relay("command results", () => this.deps.client().homeResults(results));
        return;
      }
      default:
        throw new Error(`Unsupported order: ${key || "(none)"}`);
    }
  }

  // ── Catalogue ──────────────────────────────────────────────

  /** Identical within the hour → not resent. The hourly timer forces it. */
  private async sendCatalog(text: string, force: boolean): Promise<void> {
    const now = Date.now();
    const same = this.catalog?.text === text;
    if (!force && same && this.catalog?.sentAt != null && now - this.catalog.sentAt < HOUR_MS) return;
    if (!same) {
      this.catalog = { text, sentAt: null };
      this.saveCatalog(text);
    }
    const equipments = JSON.parse(text) as HomeCatalogEntry[] | { equipments: HomeCatalogEntry[] };
    const list = Array.isArray(equipments) ? equipments : equipments.equipments;
    try {
      const selection = await this.deps.client().homeCatalog(list);
      if (this.catalog?.text === text) this.catalog.sentAt = now;
      this.deps.deviceManager.updateDeviceData(PLUGIN_ID, BRIDGE_ID, {
        home_selection: JSON.stringify(selection),
      });
      this.deps.logger.info(
        { equipments: list.length, selected: selection.length },
        "Home catalogue sent to guestFlow",
      );
    } catch (err) {
      // Kept: the hourly send tries again, and an identical order from the recipe too.
      this.deps.logger.warn({ err: errText(err) }, "Home catalogue not sent to guestFlow");
    }
  }

  private restoreCatalog(): void {
    if (this.catalog || !this.deps.dataDir) return;
    try {
      const text = readFileSync(join(this.deps.dataDir, CATALOG_FILE), "utf8");
      const saved = JSON.parse(text) as { catalog?: unknown };
      if (typeof saved.catalog === "string") this.catalog = { text: saved.catalog, sentAt: null };
    } catch {
      // none yet: the recipe sends it at its start
    }
  }

  private saveCatalog(text: string): void {
    if (!this.deps.dataDir) return;
    try {
      mkdirSync(this.deps.dataDir, { recursive: true });
      const target = join(this.deps.dataDir, CATALOG_FILE);
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ savedAt: new Date().toISOString(), catalog: text }));
      renameSync(temp, target);
    } catch (err) {
      this.deps.logger.warn({ err: errText(err) }, "Home catalogue could not be written");
    }
  }

  /** As received: a failure is logged and dropped, the next batch supersedes it. */
  private async relay(what: string, send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (err) {
      this.deps.logger.warn({ err: errText(err) }, `Home ${what} not sent to guestFlow (dropped)`);
    }
  }

  // ── Commands: the long poll ────────────────────────────────

  private async loop(): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    let failing = false;
    while (!this.stopped) {
      const startedAt = Date.now();
      let commands: HomeCommand[];
      try {
        commands = await this.deps.client().homeCommands(this.abort?.signal);
      } catch (err) {
        if (this.stopped) return;
        if (!failing) {
          this.deps.logger.warn({ err: errText(err) }, "guestFlow home commands unreachable: retrying with backoff");
        }
        failing = true;
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        continue;
      }
      if (failing) this.deps.logger.info("guestFlow home commands reachable again");
      failing = false;
      backoff = BACKOFF_MIN_MS;
      for (const command of commands) {
        if (this.stopped) return;
        await this.take(command);
      }
      if (!commands.length && Date.now() - startedAt < MIN_POLL_SPACING_MS) {
        await this.sleep(MIN_POLL_SPACING_MS);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeSleep = () => {
        this.wakeSleep = null;
        done();
      };
    });
  }

  /**
   * gF rule 9, the plugin's guard: a property not occupied now gets no command.
   * A guard against a guestFlow bug, not a compromised guestFlow (it sends the
   * stays): the recipe holds the real boundary.
   */
  private async take(command: HomeCommand): Promise<void> {
    if (!this.deps.isOccupied(command.propertyId, Date.now())) {
      this.deps.logger.warn(
        { command: command.id, propertyId: command.propertyId },
        "Home command refused: the property is not occupied now",
      );
      await this.relay("command results", () =>
        this.deps.client().homeResults([{ id: command.id, ok: false, reason: "not_occupied" }]),
      );
      return;
    }
    this.seq += 1;
    try {
      // The command first, then the counter the recipe triggers on.
      this.deps.deviceManager.updateDeviceData(PLUGIN_ID, BRIDGE_ID, { home_command: JSON.stringify(command) });
      this.deps.deviceManager.updateDeviceData(PLUGIN_ID, BRIDGE_ID, { home_command_seq: this.seq });
    } catch (err) {
      this.deps.logger.warn({ command: command.id, err: errText(err) }, "Home command could not be published");
    }
  }
}
