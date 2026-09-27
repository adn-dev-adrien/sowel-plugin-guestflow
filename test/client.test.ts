import { createHash, createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  GuestFlowClient,
  GuestFlowError,
  MAX_RESULTS_PER_POST,
  checkBaseUrl,
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
