import { createHash, createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  GuestFlowClient,
  GuestFlowError,
  MAX_RESULTS_PER_POST,
  checkBaseUrl,
  signRequest,
  signResponse,
} from "../src/client.js";
import type { GateResult } from "../src/types.js";

/** Verifies a request the way guestFlow's requireGateConnector does. */
function guestFlowVerifies(req: { method: string; url: URL; headers: Record<string, string>; body: string }) {
  const hash = createHash("sha256").update(req.body).digest("hex");
  const canonical = `${req.method}\n${req.url.pathname}${req.url.search}\n${req.headers["X-Gate-Timestamp"]}\n${hash}`;
  const expected = createHmac("sha256", "s3cret").update(canonical).digest("hex");
  return req.headers.Authorization === "Bearer k3y" && req.headers["X-Gate-Signature"] === expected;
}

type Answer = { status: number; json?: unknown; sign?: "good" | "none" | "other-secret" | "other-request" };

function fakeFetch(respond: (req: { method: string; url: URL; body: string }) => Answer) {
  const seen: { method: string; url: URL; headers: Record<string, string>; body: string; valid: boolean }[] = [];
  const impl = (async (input: URL, init: RequestInit) => {
    const req = {
      method: String(init.method),
      url: new URL(String(input)),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? init.body : "",
    };
    seen.push({ ...req, valid: guestFlowVerifies(req) });
    const r = respond(req);
    const text = r.json === undefined ? "" : JSON.stringify(r.json);
    const headers: Record<string, string> = {};
    const sign = r.sign ?? "good";
    if (sign === "good") headers["X-Gate-Response-Signature"] = signResponse("s3cret", req.headers["X-Gate-Signature"], text);
    if (sign === "other-secret") headers["X-Gate-Response-Signature"] = signResponse("guess", req.headers["X-Gate-Signature"], text);
    if (sign === "other-request") headers["X-Gate-Response-Signature"] = signResponse("s3cret", "an-older-request", text);
    return new Response(text, { status: r.status, headers });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const config = (fetchImpl: typeof fetch, baseUrl = "https://gf.example.org") => ({
  baseUrl,
  apiKey: "k3y",
  signingSecret: "s3cret",
  fetchImpl,
  now: () => 1_790_000_000_000,
});

describe("guestFlow proves its answers (anti-impersonation)", () => {
  it("signs a response the way guestFlow does (pinned vector shared with guestFlow's tests)", () => {
    expect(signResponse("s3cret", "abc", '{"ok":true}')).toBe(
      "12ac7139e4bc81ce30b413a9c7f1880b33b1f055a045affde5d2765dcfb65190",
    );
  });

  it("uses nothing from an answer that is unsigned, signed without the secret, or replayed", async () => {
    for (const sign of ["none", "other-secret", "other-request"] as const) {
      const { impl } = fakeFetch(() => ({
        status: 200,
        sign,
        json: { keys: [{ reservationId: "1", action: "create", label: "A", startsAt: "s", endsAt: "e" }] },
      }));
      await expect(new GuestFlowClient(config(impl)).keys(), sign).rejects.toMatchObject({ impostor: true });
    }
  });

  it("talks https only, except to this machine", () => {
    expect(() => checkBaseUrl("http://guestflow.example.org")).toThrow(GuestFlowError);
    expect(() => checkBaseUrl("http://192.168.0.40:4000")).toThrow(GuestFlowError);
    expect(checkBaseUrl("https://guestflow.example.org").host).toBe("guestflow.example.org");
    expect(checkBaseUrl("http://127.0.0.1:4000").port).toBe("4000");
  });
});

describe("the signed calls to guestFlow", () => {
  it("signs the list read so guestFlow's own check accepts it, and keeps only well-formed keys", async () => {
    const { impl, seen } = fakeFetch(() => ({
      status: 200,
      json: {
        now: "x",
        keys: [
          { reservationId: "1", action: "create", label: "A", startsAt: "s", endsAt: "e" },
          { reservationId: "2", action: "explode", label: "B", startsAt: "s", endsAt: "e" },
          { action: "create" },
        ],
      },
    }));
    const keys = await new GuestFlowClient(config(impl)).keys();
    expect(keys.map((k) => k.reservationId)).toEqual(["1"]);
    expect(seen[0]).toMatchObject({ method: "GET", valid: true });
    expect(seen[0].url.pathname).toBe("/public/v1/gate/keys");
    expect(seen[0].headers["X-Gate-Timestamp"]).toBe("1790000000000");
  });

  it("keeps a well-formed stay, and a key whose stay is absent or malformed with no stay", async () => {
    const base = { action: "create", label: "A", startsAt: "s", endsAt: "e" };
    const stay = { propertyId: 1, propertyName: " Gîte ", arrival: "2026-10-06T16:00:00+02:00", departure: "2026-10-09T10:00:00+02:00" };
    const { impl } = fakeFetch(() => ({
      status: 200,
      json: {
        keys: [
          { ...base, reservationId: "1", stay },
          { ...base, reservationId: "2" },
          { ...base, reservationId: "3", stay: "Gîte" },
          { ...base, reservationId: "4", stay: { ...stay, propertyId: "1" } },
          { ...base, reservationId: "5", stay: { ...stay, propertyName: "" } },
          { ...base, reservationId: "6", stay: { ...stay, arrival: "tomorrow" } },
          { ...base, reservationId: "7", stay: { ...stay, departure: undefined } },
          { ...base, reservationId: "8", stay: null },
        ],
      },
    }));
    const keys = await new GuestFlowClient(config(impl)).keys();
    expect(keys.map((k) => k.reservationId)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(keys[0].stay).toEqual({ ...stay, propertyName: "Gîte" });
    for (const k of keys.slice(1)) expect(k).not.toHaveProperty("stay");
  });

  it("keeps a path the owner put in front of guestFlow, and signs it", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, json: { keys: [] } }));
    await new GuestFlowClient(config(impl, "https://example.org/guestflow/")).keys();
    expect(seen[0].url.pathname).toBe("/guestflow/public/v1/gate/keys");
    expect(seen[0].valid).toBe(true);
  });

  it("posts the results signed over their body, in batches guestFlow accepts", async () => {
    const { impl, seen } = fakeFetch(() => ({ status: 200, json: { stored: 1 } }));
    const results: GateResult[] = Array.from({ length: MAX_RESULTS_PER_POST + 1 }, (_, i) => ({
      reservationId: String(i),
      action: "create",
      ok: true,
      state: "not_yet",
      code: null,
      url: null,
    }));
    await new GuestFlowClient(config(impl)).results(results);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.method === "POST" && s.valid)).toBe(true);
    expect(JSON.parse(seen[1].body).results).toHaveLength(1);
  });

  it("says what went wrong: refused, unreachable, not JSON", async () => {
    const refused = fakeFetch(() => ({ status: 401, json: { error: "bad" } }));
    await expect(new GuestFlowClient(config(refused.impl)).keys()).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("refused the key or the signature"),
    });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(new GuestFlowClient(config(down)).keys()).rejects.toBeInstanceOf(GuestFlowError);
    const html = fakeFetch(() => ({ status: 200 }));
    await expect(new GuestFlowClient(config(html.impl)).keys()).rejects.toMatchObject({
      message: expect.stringContaining("no JSON"),
    });
  });
});

describe("the home calls (spec 002): same channel, same signature", () => {
  it("signs a request the way guestFlow's canonicalString does (pinned vectors)", () => {
    expect(signRequest("s3cret", "GET", "/public/v1/home/commands?wait=25", 1_790_000_000_000, "")).toBe(
      "822f00596e68b7f62d3b133e8cf95845c6406118940eaf5f6b676f0ca88cc908",
    );
    const body = JSON.stringify({ results: [{ id: 7, ok: false, reason: "not_occupied" }] });
    expect(signRequest("s3cret", "POST", "/public/v1/home/commands/results", 1_790_000_000_000, body)).toBe(
      "18ebdbd1f5df923b24ffec9f51a53e7f0f0b4f6c2d7cee1441f1bc5471f9eb8e",
    );
  });

  it("puts the catalogue, posts readings, series and results, long-polls the commands — all signed", async () => {
    const { impl, seen } = fakeFetch((req) => {
      if (req.url.pathname.endsWith("/catalog")) {
        return { status: 200, json: { selection: [{ equipmentId: "eq1", alias: "temperature" }, { bad: 1 }] } };
      }
      if (req.url.pathname.endsWith("/commands")) {
        return {
          status: 200,
          json: {
            commands: [
              { id: 3, propertyId: 1, equipmentId: "eq9", value: "on", issuedAt: "2026-11-15T10:00:00Z" },
              { id: 4, propertyId: 1, equipmentId: "eq9", value: "blink", issuedAt: "2026-11-15T10:00:00Z" },
              { id: "5", propertyId: 1, equipmentId: "eq9", value: "off", issuedAt: "2026-11-15T10:00:00Z" },
            ],
          },
        };
      }
      return { status: 200, json: { stored: 1, dropped: 0 } };
    });
    const client = new GuestFlowClient(config(impl, "https://example.org/gf/"));
    expect(await client.homeCatalog([])).toEqual([{ equipmentId: "eq1", alias: "temperature" }]);
    await client.homeReadings([{ equipmentId: "eq1", alias: "temperature", value: 21.4, unit: "°C", measuredAt: "x" }]);
    await client.homeSeries([{ equipmentId: "eq1", alias: "rain_1h", buckets: [] }]);
    const polled = await client.homeCommands();
    expect(polled.commands.map((c) => c.id)).toEqual([3]);
    // « blink » has a readable id, so it gets its answer; "5" has none.
    expect(polled.invalid).toEqual([4]);
    await client.homeResults([{ id: 3, ok: true }]);
    expect(seen.map((s) => `${s.method} ${s.url.pathname}${s.url.search}`)).toEqual([
      "PUT /gf/public/v1/home/catalog",
      "POST /gf/public/v1/home/readings",
      "POST /gf/public/v1/home/series",
      "GET /gf/public/v1/home/commands?wait=25",
      "POST /gf/public/v1/home/commands/results",
    ]);
    expect(seen.every((s) => s.valid)).toBe(true);
  });

  it("uses no command from an answer guestFlow did not sign", async () => {
    const { impl } = fakeFetch(() => ({
      status: 200,
      sign: "other-secret",
      json: { commands: [{ id: 3, propertyId: 1, equipmentId: "eq9", value: "on", issuedAt: "x" }] },
    }));
    await expect(new GuestFlowClient(config(impl)).homeCommands()).rejects.toMatchObject({ impostor: true });
  });
});
