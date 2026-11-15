import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createPlugin } from "../src/index.js";
import { signResponse } from "../src/client.js";
import { BACKOFF_MAX_MS, BRIDGE_ID } from "../src/home.js";
import type { DeviceManager, DiscoveredDevice, PluginDeps } from "../src/types.js";

// Spec 002 — the home bridge. The plugin carries; it never decides nor acts.

const NOW = "2026-10-07T12:00:00+02:00";
const stayKey = (propertyId: number, arrival: string, departure: string) => ({
  reservationId: `r${propertyId}`,
  action: "create",
  label: "L",
  startsAt: arrival,
  endsAt: departure,
  stay: { propertyId, propertyName: `P${propertyId}`, arrival, departure },
});
/** Property 1 occupied now, property 2 arrives tomorrow. */
const KEYS = [
  stayKey(1, "2026-10-06T16:00:00+02:00", "2026-10-09T10:00:00+02:00"),
  stayKey(2, "2026-10-08T16:00:00+02:00", "2026-10-10T10:00:00+02:00"),
];

type Call = { method: string; path: string; body: unknown };

/** guestFlow, signed with the plugin's secret "s". `commands` answers one batch per poll. */
function guestFlow(opts: { commands?: unknown[][]; down?: boolean; selection?: unknown[] } = {}) {
  const calls: Call[] = [];
  const batches = [...(opts.commands ?? [])];
  let down = opts.down ?? false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      const u = new URL(String(url));
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method: String(init.method), path: `${u.pathname}${u.search}`, body });
      if (down) return new Response("{}", { status: 503 });
      const reqSig = (init.headers as Record<string, string>)["X-Gate-Signature"];
      const answer = (json: unknown) => {
        const text = JSON.stringify(json);
        return new Response(text, { status: 200, headers: { "X-Gate-Response-Signature": signResponse("s", reqSig, text) } });
      };
      if (u.pathname.endsWith("/gate/keys")) return answer({ keys: KEYS });
      if (u.pathname.endsWith("/home/catalog")) return answer({ selection: opts.selection ?? [{ equipmentId: "eq1", alias: "temperature" }] });
      if (u.pathname.endsWith("/home/commands")) return answer({ commands: batches.shift() ?? [] });
      return answer({ stored: 1, dropped: 0 });
    }),
  );
  return { calls, setDown: (v: boolean) => void (down = v) };
}

/** Sowel's device manager — and nothing else: a plugin that tried to command an equipment would have to reach past it. */
function build(opts: { configured?: boolean; dataDir?: string } = {}) {
  const settings = new Map<string, string>();
  if (opts.configured !== false) {
    settings.set("integration.guestflow.base_url", "https://gf.example.org");
    settings.set("integration.guestflow.api_key", "k");
    settings.set("integration.guestflow.signing_secret", "s");
  }
  const discovered = new Map<string, DiscoveredDevice>();
  const writes: { id: string; payload: Record<string, unknown> }[] = [];
  const status = new Map<string, string>();
  const manager: DeviceManager = {
    upsertFromDiscovery: (_i, _s, d) => void discovered.set(d.friendlyName, d),
    updateDeviceData: (_i, id, payload) => void writes.push({ id, payload }),
    updateDeviceStatus: (_i, id, s) => void status.set(id, s),
  };
  const touched = new Set<string>();
  const watched = new Proxy(manager, {
    get(target, prop) {
      touched.add(String(prop));
      return Reflect.get(target, prop);
    },
  });
  const noop = () => {};
  const deps: PluginDeps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    eventBus: { emit: noop },
    settingsManager: { get: (k) => settings.get(k), set: (k, v) => void settings.set(k, v) },
    deviceManager: watched,
    pluginDir: "/tmp",
    dataDir: opts.dataDir,
    sharedAccess: { profiles: () => [], upsert: (id) => ({ id, code: "C", invitationUrl: "U" }), revoke: noop, list: () => [] },
  };
  const bridgeWrites = (key: string) => writes.filter((w) => w.id === BRIDGE_ID && key in w.payload).map((w) => w.payload[key]);
  return { plugin: createPlugin(deps), discovered, writes, status, touched, bridgeWrites };
}

const BRIDGE = { sourceDeviceId: BRIDGE_ID };
const catalog = (name = "Salon") =>
  JSON.stringify([{ id: "eq1", name, zonePath: "Gîte › Salon", type: "sensor", readings: [{ alias: "temperature", category: "temperature", unit: "°C" }] }]);
const command = (id: number, propertyId: number) => ({
  id,
  propertyId,
  equipmentId: "light1",
  value: "on",
  issuedAt: "2026-10-07T09:59:55Z",
});
const homeCalls = (calls: Call[], path: string) => calls.filter((c) => c.path.includes(`/home/${path}`));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the home bridge device", () => {
  it("declares home-bridge with the four text orders and three data, online while running", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    guestFlow();
    const { plugin, discovered, status } = build();
    await plugin.start();
    const bridge = discovered.get(BRIDGE_ID)!;
    expect(bridge.model).toBe("Domotique GuestFlow");
    expect(bridge.orders.map((o) => `${o.key}:${o.type}`)).toEqual([
      "home_catalog:text",
      "home_readings:text",
      "home_series:text",
      "home_result:text",
    ]);
    expect(bridge.data.map((d) => `${d.key}:${d.type}`)).toEqual([
      "home_selection:text",
      "home_command:text",
      "home_command_seq:number",
    ]);
    expect(status.get(BRIDGE_ID)).toBe("online");
    await plugin.stop();
    expect(status.get(BRIDGE_ID)).toBe("offline");
  });

  it("never polls nor declares anything when not configured", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    const { calls } = guestFlow();
    const { plugin, discovered } = build({ configured: false });
    await plugin.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
    expect(discovered.has(BRIDGE_ID)).toBe(false);
  });

  it("refuses an order for another device, an unknown order and unreadable JSON", async () => {
    guestFlow();
    const { plugin } = build();
    await expect(plugin.executeOrder({ sourceDeviceId: "property-1" }, "home_catalog", "[]")).rejects.toThrow(/takes no order/);
    await expect(plugin.executeOrder(BRIDGE, "state", "ON")).rejects.toThrow(/Unsupported order/);
    await expect(plugin.executeOrder(BRIDGE, "home_catalog", "not json")).rejects.toThrow(/Unreadable/);
    await expect(plugin.executeOrder(BRIDGE, "home_readings", "{}")).rejects.toThrow(/Unreadable/);
  });
});

describe("catalogue, readings, series and results are relayed", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("puts the catalogue, publishes the selection, dedupes an identical list within the hour, and resends hourly", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    const { calls } = guestFlow({ selection: [{ equipmentId: "eq1", alias: "temperature" }] });
    const { plugin, bridgeWrites } = build();
    await plugin.start();
    await plugin.executeOrder(BRIDGE, "home_catalog", catalog());
    await plugin.executeOrder(BRIDGE, { orderKey: "home_catalog" }, catalog());
    expect(homeCalls(calls, "catalog")).toHaveLength(1);
    expect(homeCalls(calls, "catalog")[0]).toMatchObject({ method: "PUT", body: { equipments: JSON.parse(catalog()) } });
    expect(bridgeWrites("home_selection")).toEqual([JSON.stringify([{ equipmentId: "eq1", alias: "temperature" }])]);

    await plugin.executeOrder(BRIDGE, "home_catalog", catalog("Séjour"));
    expect(homeCalls(calls, "catalog")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(homeCalls(calls, "catalog")).toHaveLength(3);
    expect(homeCalls(calls, "catalog")[2].body).toEqual({ equipments: JSON.parse(catalog("Séjour")) });
    await plugin.stop();
  });

  it("a catalogue guestFlow did not take is tried again on the next identical order", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    const gf = guestFlow({ down: true });
    const { plugin, bridgeWrites } = build();
    await plugin.executeOrder(BRIDGE, "home_catalog", catalog());
    gf.setDown(false);
    await plugin.executeOrder(BRIDGE, "home_catalog", catalog());
    expect(homeCalls(gf.calls, "catalog")).toHaveLength(2);
    expect(bridgeWrites("home_selection")).toHaveLength(1);
  });

  it("sends the remembered catalogue at start, before the recipe speaks", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    dir = mkdtempSync(join(tmpdir(), "gf-home-"));
    guestFlow();
    const first = build({ dataDir: dir });
    await first.plugin.executeOrder(BRIDGE, "home_catalog", catalog());
    const { calls } = guestFlow();
    const second = build({ dataDir: dir });
    await second.plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(homeCalls(calls, "catalog")[0]?.body).toEqual({ equipments: JSON.parse(catalog()) });
    await second.plugin.stop();
  });

  it("posts readings, series and results as received; a failure is dropped, never queued", async () => {
    const gf = guestFlow();
    const { plugin } = build();
    const readings = [{ equipmentId: "eq1", alias: "temperature", value: 21.4, unit: "°C", measuredAt: NOW }];
    const series = [{ equipmentId: "eq2", alias: "rain_1h", buckets: [{ time: NOW, value: 0.4 }] }];
    await plugin.executeOrder(BRIDGE, "home_readings", JSON.stringify(readings));
    await plugin.executeOrder(BRIDGE, "home_series", JSON.stringify(series));
    await plugin.executeOrder(BRIDGE, "home_result", JSON.stringify({ id: 4, ok: false, reason: "too_old" }));
    expect(homeCalls(gf.calls, "readings")[0].body).toEqual({ readings });
    expect(homeCalls(gf.calls, "series")[0].body).toEqual({ series });
    expect(homeCalls(gf.calls, "commands/results")[0].body).toEqual({ results: [{ id: 4, ok: false, reason: "too_old" }] });

    gf.setDown(true);
    await expect(plugin.executeOrder(BRIDGE, "home_readings", JSON.stringify(readings))).resolves.toBeUndefined();
    gf.setDown(false);
    await plugin.executeOrder(BRIDGE, "home_readings", JSON.stringify([{ ...readings[0], value: 21.5 }]));
    const sent = homeCalls(gf.calls, "readings").map((c) => (c.body as { readings: { value: number }[] }).readings[0].value);
    expect(sent).toEqual([21.4, 21.4, 21.5]);
  });
});

describe("the commands long poll", () => {
  it("polls again at once after an answer, and backs off 5 s → 5 min after errors", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    const gf = guestFlow({ commands: [[command(1, 1)], [command(2, 1)]] });
    const { plugin } = build();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    // Two answers with a command, then one empty answer: three polls without waiting.
    expect(homeCalls(gf.calls, "commands?wait=25")).toHaveLength(3);
    expect(homeCalls(gf.calls, "commands?wait=25")[0].path).toBe("/public/v1/home/commands?wait=25");

    gf.setDown(true);
    await vi.advanceTimersByTimeAsync(5_000);
    const failedAt = homeCalls(gf.calls, "commands?wait=25").length;
    const polls = () => homeCalls(gf.calls, "commands?wait=25").length - failedAt;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(polls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(polls()).toBe(3);
    // Capped: from here on, one try every 5 minutes.
    await vi.advanceTimersByTimeAsync(40_000 + 80_000 + 160_000);
    const capped = polls();
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS - 1);
    expect(polls()).toBe(capped);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(capped + 1);

    gf.setDown(false);
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    const back = polls();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls()).toBe(back + 1); // backoff reset: the empty-answer pace again
    await plugin.stop();
    const after = gf.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(gf.calls.length).toBe(after);
  });

  it("publishes a command for an occupied property: the command, then a counter that only goes up", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    guestFlow({ commands: [[], [command(1, 1), command(2, 1)]] });
    const { plugin, bridgeWrites, writes } = build();
    await plugin.refresh!(); // the stays
    await plugin.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bridgeWrites("home_command").map((c) => JSON.parse(String(c)).id)).toEqual([1, 2]);
    const seqs = bridgeWrites("home_command_seq") as number[];
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBe(seqs[0] + 1);
    const bridge = writes.filter((w) => w.id === BRIDGE_ID && !("home_selection" in w.payload));
    expect(bridge.map((w) => Object.keys(w.payload)[0])).toEqual([
      "home_command",
      "home_command_seq",
      "home_command",
      "home_command_seq",
    ]);
    await plugin.stop();
  });

  it("answers not_occupied for a property that is not occupied now, and never publishes it", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    const gf = guestFlow({ commands: [[command(7, 2), command(8, 99)]] });
    const { plugin, bridgeWrites } = build();
    await plugin.refresh!();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridgeWrites("home_command")).toEqual([]);
    expect(bridgeWrites("home_command_seq")).toEqual([]);
    expect(homeCalls(gf.calls, "commands/results").map((c) => c.body)).toEqual([
      { results: [{ id: 7, ok: false, reason: "not_occupied" }] },
      { results: [{ id: 8, ok: false, reason: "not_occupied" }] },
    ]);
    await plugin.stop();
  });

  it("re-reads the stays once before refusing: a stay booked since the hourly read is not refused", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    const gf = guestFlow({ commands: [[command(1, 1)]] });
    const { plugin, bridgeWrites } = build();
    await plugin.start(); // no stays read yet
    await vi.advanceTimersByTimeAsync(0);
    expect(gf.calls.some((c) => c.path.endsWith("/gate/keys"))).toBe(true);
    expect(bridgeWrites("home_command").map((c) => JSON.parse(String(c)).id)).toEqual([1]);
    expect(homeCalls(gf.calls, "commands/results")).toEqual([]);
    await plugin.stop();
  });

  it("answers invalid_command for an unusable command whose id it can read", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    const gf = guestFlow({ commands: [[{ ...command(9, 1), value: "blink" }]] });
    const { plugin, bridgeWrites } = build();
    await plugin.refresh!();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(bridgeWrites("home_command")).toEqual([]);
    expect(homeCalls(gf.calls, "commands/results").map((c) => c.body)).toEqual([
      { results: [{ id: 9, ok: false, reason: "invalid_command" }] },
    ]);
    await plugin.stop();
  });

  it("a start right after a stop leaves one loop, and the stop returns", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    const gf = guestFlow();
    const { plugin, status } = build();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = plugin.stop();
    await plugin.start();
    await stopping;
    expect(status.get(BRIDGE_ID)).toBe("online");
    const before = homeCalls(gf.calls, "commands?wait=25").length;
    await vi.advanceTimersByTimeAsync(5_000);
    // One loop: one empty answer, one poll per 5 s.
    expect(homeCalls(gf.calls, "commands?wait=25").length - before).toBe(1);
    await plugin.stop();
  });

  it("sends no order to any equipment: it only declares and updates its own devices", async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    guestFlow({ commands: [[command(1, 1)], [command(2, 2)]] });
    const { plugin, touched } = build();
    await plugin.refresh!();
    await plugin.start();
    await plugin.executeOrder(BRIDGE, "home_catalog", catalog());
    await plugin.executeOrder(BRIDGE, "home_result", JSON.stringify({ id: 1, ok: true }));
    await vi.advanceTimersByTimeAsync(10_000);
    await plugin.stop();
    expect([...touched].sort()).toEqual(["updateDeviceData", "updateDeviceStatus", "upsertFromDiscovery"]);
  });
});
