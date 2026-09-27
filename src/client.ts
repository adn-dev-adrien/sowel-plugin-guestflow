import { createHash, createHmac } from "node:crypto";
import type { GateKey, GateResult } from "./types.js";

// ============================================================
// The signed calls to guestFlow. guestFlow holds no credential on the house:
// Sowel pulls the list and pushes the results back.
//
//   Authorization: Bearer <api key>
//   X-Gate-Timestamp: <unix ms>
//   X-Gate-Signature: hex HMAC-SHA256(secret, METHOD\npath?query\ntimestamp\nsha256(body))
// ============================================================

const BASE_PATH = "/public/v1/gate";
const REQUEST_TIMEOUT_MS = 20_000;
/** guestFlow refuses a batch above this. */
export const MAX_RESULTS_PER_POST = 500;

export class GuestFlowError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GuestFlowError";
  }
}

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
  signingSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function signRequest(
  secret: string,
  method: string,
  pathAndQuery: string,
  timestamp: number,
  body: string,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = `${method.toUpperCase()}\n${pathAndQuery}\n${timestamp}\n${bodyHash}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export class GuestFlowClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: ClientConfig) {
    this.base = new URL(config.baseUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  async keys(): Promise<GateKey[]> {
    const body = await this.request("GET", "/keys");
    const keys = (body as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) throw new GuestFlowError("guestFlow answered without keys[]", 200);
    return keys.filter(isGateKey);
  }

  async results(results: GateResult[]): Promise<void> {
    for (let i = 0; i < results.length; i += MAX_RESULTS_PER_POST) {
      await this.request("POST", "/results", { results: results.slice(i, i + MAX_RESULTS_PER_POST) });
    }
  }

  private async request(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
    // Keep a base path the owner may have put in front of guestFlow.
    const prefix = this.base.pathname.replace(/\/+$/, "");
    const pathAndQuery = `${prefix}${BASE_PATH}${path}`;
    const url = new URL(pathAndQuery, this.base.origin);
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = this.now();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-Gate-Timestamp": String(timestamp),
      "X-Gate-Signature": signRequest(this.config.signingSecret, method, pathAndQuery, timestamp, body),
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: payload === undefined ? undefined : body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new GuestFlowError(
        `guestFlow cannot be reached: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const reason =
        res.status === 401 || res.status === 403
          ? "guestFlow refused the key or the signature"
          : `guestFlow answered ${res.status}`;
      throw new GuestFlowError(`${reason} on ${method} ${path}`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new GuestFlowError(`guestFlow answered ${method} ${path} with no JSON`, res.status);
    }
  }
}

function isGateKey(value: unknown): value is GateKey {
  if (!value || typeof value !== "object") return false;
  const k = value as Record<string, unknown>;
  return (
    typeof k.reservationId === "string" &&
    k.reservationId.length > 0 &&
    (k.action === "create" || k.action === "revoke") &&
    typeof k.label === "string" &&
    typeof k.startsAt === "string" &&
    typeof k.endsAt === "string"
  );
}
