import { afterEach, describe, it, expect, vi } from "vitest";
import { createPlugin } from "../src/index.js";
import { signResponse } from "../src/client.js";
import type { PluginDeps, SharedAccessApi } from "../src/types.js";

function build(opts: { configured?: boolean; sharedAccess?: SharedAccessApi | null } = {}) {
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
  const deps: PluginDeps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    eventBus: { emit: (e) => events.push(e as Record<string, unknown>) },
    settingsManager: { get: (k) => settings.get(k), set: (k, v) => void settings.set(k, v) },
    deviceManager: {},
    pluginDir: "/tmp",
    sharedAccess: opts.sharedAccess === null ? undefined : (opts.sharedAccess ?? api),
  };
  return { plugin: createPlugin(deps), events, upserts };
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
  it("is not configured without its three settings, and in error without shared access", async () => {
    const bare = build({ configured: false });
    await bare.plugin.start();
    expect(bare.plugin.getStatus()).toBe("not_configured");
    const old = build({ sharedAccess: null });
    await old.plugin.start();
    expect(old.plugin.getStatus()).toBe("error");
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
