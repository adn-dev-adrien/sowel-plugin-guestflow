import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createPlugin } from "../src/index.js";
import { signResponse } from "../src/client.js";
import type { DeviceManager, DiscoveredDevice, PluginDeps, SharedAccessApi } from "../src/types.js";

/** Sowel's device manager as the plugin sees it: what each device was told last. */
function fakeDevices() {
  const discovered = new Map<string, DiscoveredDevice>();
  const data = new Map<string, Record<string, unknown>>();
  const status = new Map<string, string>();
  const pushes: string[] = [];
  const manager: DeviceManager = {
    upsertFromDiscovery: (_i, _s, d) => void discovered.set(d.friendlyName, d),
    updateDeviceData: (_i, id, payload) => {
      pushes.push(id);
      data.set(id, { ...data.get(id), ...payload });
    },
    updateDeviceStatus: (_i, id, s) => void status.set(id, s),
  };
  return { manager, discovered, data, status, pushes };
}

function build(
  opts: { configured?: boolean; sharedAccess?: SharedAccessApi | null; dataDir?: string } = {},
) {
  const settings = new Map<string, string>();
  if (opts.configured !== false) {
    settings.set("integration.guestflow.base_url", "https://gf.example.org");
    settings.set("integration.guestflow.api_key", "k");
    settings.set("integration.guestflow.signing_secret", "s");
  }
  const events: Record<string, unknown>[] = [];
  const upserts: string[] = [];
  const api: SharedAccessApi = {
    profiles: () => [],
    upsert: (id) => {
      upserts.push(id);
      if (id === "gf:bad") throw Object.assign(new Error("x"), { code: "unknown_profile" });
      return { id, code: "C", invitationUrl: "U" };
    },
    revoke: () => {},
    list: () => [],
  };
  const noop = () => {};
  const devices = fakeDevices();
  const deps: PluginDeps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    eventBus: { emit: (e) => events.push(e as Record<string, unknown>) },
    settingsManager: { get: (k) => settings.get(k), set: (k, v) => void settings.set(k, v) },
    deviceManager: devices.manager,
    pluginDir: "/tmp",
    dataDir: opts.dataDir,
    sharedAccess: opts.sharedAccess === null ? undefined : (opts.sharedAccess ?? api),
  };
  return { plugin: createPlugin(deps), events, upserts, devices };
}

/** guestFlow as it answers: signed with the plugin's secret "s", unless `forged`. */
function serveKeys(keys: unknown[], posted: unknown[] = [], status = 200, forged = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: RequestInit) => {
      if (status !== 200) return new Response("{}", { status });
      const reqSig = (init.headers as Record<string, string>)["X-Gate-Signature"];
      const answer = (json: unknown) => {
        const text = JSON.stringify(json);
        const sig = signResponse(forged ? "not-the-secret" : "s", reqSig, text);
        return new Response(text, { status: 200, headers: { "X-Gate-Response-Signature": sig } });
      };
      if (String(url).endsWith("/keys")) return answer({ keys });
      posted.push(JSON.parse(String(init.body)));
      return answer({ stored: 1 });
    }),
  );
}

const key = (id: string) => ({ reservationId: id, action: "create", label: "L", startsAt: "a", endsAt: "b" });
const alarms = (events: Record<string, unknown>[]) =>
  events.filter((e) => String(e.type).startsWith("system.alarm")).map((e) => `${e.type}:${e.alarmId}`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the guestFlow plugin", () => {
  it("is not configured without its three settings", async () => {
    const bare = build({ configured: false });
    await bare.plugin.start();
    expect(bare.plugin.getStatus()).toBe("not_configured");
  });

  it("reads the list at start and every hour, and reports every result", async () => {
    vi.useFakeTimers();
    const posted: { results: unknown[] }[] = [];
    serveKeys([key("1")], posted);
    const { plugin, upserts } = build();
    await plugin.start();
    expect(plugin.getStatus()).toBe("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(upserts).toEqual(["gf:1"]);
    expect(posted[0].results).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(upserts).toEqual(["gf:1", "gf:1"]);
    await plugin.stop();
  });

  it("reads again on Refresh, and one read at a time", async () => {
    serveKeys([key("1")]);
    const { plugin, upserts } = build();
    await Promise.all([plugin.refresh!(), plugin.refresh!()]);
    expect(upserts).toEqual(["gf:1"]);
  });

  it("raises one alarm for failed keys, not again each hour, and clears it once they pass", async () => {
    serveKeys([key("bad")]);
    const { plugin, events } = build();
    await plugin.refresh!();
    await plugin.refresh!();
    expect(alarms(events)).toEqual(["system.alarm.raised:guestflow:keys"]);
    const raised = events.find((e) => e.alarmId === "guestflow:keys");
    expect(raised?.message).toContain("profil « Par défaut » n'est pas accordé");
    serveKeys([key("1")]);
    await plugin.refresh!();
    expect(alarms(events)).toEqual([
      "system.alarm.raised:guestflow:keys",
      "system.alarm.resolved:guestflow:keys",
    ]);
  });

  it("creates no key and sends nothing to a server posing as guestFlow", async () => {
    const posted: unknown[] = [];
    serveKeys([key("1")], posted, 200, true);
    const { plugin, events, upserts } = build();
    await plugin.refresh!();
    expect(upserts).toEqual([]);
    expect(posted).toEqual([]);
    const raised = events.find((e) => e.alarmId === "guestflow:unreachable");
    expect(String(raised?.message)).toContain("ne vient pas de guestFlow");
  });

  it("refuses to start on a plain http guestFlow address", async () => {
    const { plugin } = build();
    const settings = (plugin as unknown as { settings: { set: (k: string, v: string) => void } }).settings;
    settings.set("integration.guestflow.base_url", "http://guestflow.example.org");
    await plugin.start();
    expect(plugin.getStatus()).toBe("error");
  });

  it("raises an alarm when guestFlow refuses the signature, and stays connected for Refresh", async () => {
    serveKeys([], [], 401);
    const { plugin, events } = build();
    await plugin.start();
    await plugin.refresh!();
    expect(plugin.getStatus()).toBe("connected");
    const raised = events.find((e) => e.alarmId === "guestflow:unreachable");
    expect(raised).toMatchObject({ level: "error" });
    expect(String(raised?.message)).toContain("signature");
    await plugin.stop();
  });
});

// ── Stays ────────────────────────────────────────────────────

const ARR = "2026-10-06T16:00:00+02:00";
const DEP = "2026-10-09T10:00:00+02:00";
const withStay = (id: string, propertyId = 1, propertyName = "Gîte", arrival = ARR, departure = DEP) => ({
  ...key(id),
  startsAt: "2026-10-06T13:00:00+02:00",
  endsAt: "2026-10-09T12:00:00+02:00",
  stay: { propertyId, propertyName, arrival, departure },
});

describe("stays as devices", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("publishes one device per property, with no guest name, and keeps the key unchanged", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-05T12:00:00+02:00") });
    serveKeys([withStay("1"), withStay("2", 2, "Lodge", "2026-10-07T16:00:00+02:00", "2026-10-08T10:00:00+02:00"), key("3")]);
    const { plugin, devices, upserts } = build();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(upserts).toEqual(["gf:1", "gf:2", "gf:3"]);
    expect([...devices.discovered.keys()]).toEqual(["property-1", "property-2"]);
    const gite = devices.discovered.get("property-1")!;
    expect(gite.model).toBe("Séjours Gîte");
    expect(gite.data.map((d) => `${d.key}:${d.type}:${d.category}`)).toEqual([
      "occupied:boolean:generic",
      "arrival:text:generic",
      "departure:text:generic",
    ]);
    expect(JSON.stringify([...devices.discovered.values()])).not.toContain("Julie");
    expect(devices.data.get("property-1")).toEqual({ occupied: false, arrival: ARR, departure: DEP });
    expect(devices.data.get("property-2")).toMatchObject({ occupied: false, arrival: "2026-10-07T16:00:00+02:00" });
    expect(devices.status.get("property-1")).toBe("online");
    await plugin.stop();
    expect(devices.status.get("property-1")).toBe("offline");
  });

  it("flips occupied at the exact arrival and departure, without waiting for a read", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-06T15:30:00+02:00") });
    const posted: unknown[] = [];
    serveKeys([withStay("1")], posted);
    const { plugin, devices } = build();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(devices.data.get("property-1")?.occupied).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(devices.data.get("property-1")?.occupied).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(devices.data.get("property-1")).toEqual({ occupied: true, arrival: ARR, departure: DEP });
    serveKeys([withStay("1")], posted, 500); // guestFlow gone: the flip still happens
    await vi.advanceTimersByTimeAsync(Date.parse(DEP) - Date.now());
    expect(devices.data.get("property-1")).toEqual({ occupied: false, arrival: "", departure: "" });
    await plugin.stop();
    const pushes = devices.pushes.length;
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * 60_000);
    expect(devices.pushes.length).toBe(pushes);
  });

  it("a cancelled stay frees the property; a property gone from the list is reset", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-07T12:00:00+02:00") });
    serveKeys([withStay("1")]);
    const { plugin, devices } = build();
    await plugin.refresh!();
    expect(devices.data.get("property-1")?.occupied).toBe(true);
    serveKeys([{ ...withStay("1"), action: "revoke" }]);
    await plugin.refresh!();
    expect(devices.data.get("property-1")).toEqual({ occupied: false, arrival: "", departure: "" });
    serveKeys([withStay("1")]);
    await plugin.refresh!();
    serveKeys([]);
    await plugin.refresh!();
    expect(devices.data.get("property-1")).toEqual({ occupied: false, arrival: "", departure: "" });
  });

  it("restarts with guestFlow down on the stays remembered in dataDir", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-07T12:00:00+02:00") });
    dir = mkdtempSync(join(tmpdir(), "gf-plugin-"));
    serveKeys([withStay("1")]);
    const first = build({ dataDir: dir });
    await first.plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    await first.plugin.stop();

    serveKeys([], [], 503);
    const second = build({ dataDir: dir });
    await second.plugin.start();
    expect(second.devices.discovered.get("property-1")?.model).toBe("Séjours Gîte");
    expect(second.devices.data.get("property-1")).toEqual({ occupied: true, arrival: ARR, departure: DEP });
    await vi.advanceTimersByTimeAsync(0);
    expect(alarms(second.events)).toEqual(["system.alarm.raised:guestflow:unreachable"]);
    expect(second.devices.data.get("property-1")?.occupied).toBe(true);
    await vi.advanceTimersByTimeAsync(Date.parse(DEP) - Date.now());
    expect(second.devices.data.get("property-1")?.occupied).toBe(false);
    await second.plugin.stop();
  });

  it("without shared access: stays published, keys reported shared_access_off, still connected", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-07T12:00:00+02:00") });
    const posted: { results: Record<string, unknown>[] }[] = [];
    serveKeys([withStay("1")], posted);
    const { plugin, devices, events } = build({ sharedAccess: null });
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.getStatus()).toBe("connected");
    expect(devices.data.get("property-1")?.occupied).toBe(true);
    expect(posted[0].results).toEqual([
      expect.objectContaining({ reservationId: "1", action: "create", ok: false, error: "shared_access_off" }),
    ]);
    const raised = events.find((e) => e.alarmId === "guestflow:keys");
    expect(String(raised?.message)).toContain("accès partagés ne sont pas disponibles");
    await plugin.stop();
  });

  it("a refused stay reaches neither the gate nor the device", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-05T12:00:00+02:00") });
    const posted: { results: Record<string, unknown>[] }[] = [];
    serveKeys([withStay("1", 1, "Gîte", DEP, ARR)], posted);
    const { plugin, devices, upserts } = build();
    await plugin.refresh!();
    expect(upserts).toEqual([]);
    expect(posted[0].results[0]).toMatchObject({ ok: false, error: "invalid_stay" });
    expect(devices.data.get("property-1")).toEqual({ occupied: false, arrival: "", departure: "" });
  });
});
