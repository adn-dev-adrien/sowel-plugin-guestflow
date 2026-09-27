import { createHash, createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { GuestFlowClient, GuestFlowError, MAX_RESULTS_PER_POST } from "../src/client.js";
import type { GateResult } from "../src/types.js";

/** Verifies a request the way guestFlow's requireGateConnector does. */
function guestFlowVerifies(req: { method: string; url: URL; headers: Record<string, string>; body: string }) {
  const hash = createHash("sha256").update(req.body).digest("hex");
  const canonical = `${req.method}\n${req.url.pathname}${req.url.search}\n${req.headers["X-Gate-Timestamp"]}\n${hash}`;
  const expected = createHmac("sha256", "s3cret").update(canonical).digest("hex");
  return req.headers.Authorization === "Bearer k3y" && req.headers["X-Gate-Signature"] === expected;
}

function fakeFetch(respond: (req: { method: string; url: URL; body: string }) => { status: number; json?: unknown }) {
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
    return new Response(r.json === undefined ? "" : JSON.stringify(r.json), { status: r.status });
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
