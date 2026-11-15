import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  GateKey,
  GateResult,
  HomeCatalogEntry,
  HomeCommand,
  HomeReading,
  HomeResult,
  HomeSelectionPair,
  HomeSeries,
  Stay,
} from "./types.js";

// ============================================================
// The signed calls to guestFlow. guestFlow holds no credential on the house:
// Sowel pulls the list and pushes the results back.
//
//   Authorization: Bearer <api key>
//   X-Gate-Timestamp: <unix ms>
//   X-Gate-Signature: hex HMAC-SHA256(secret, METHOD\npath?query\ntimestamp\nsha256(body))
//
// And guestFlow proves every answer is its own: a server posing as guestFlow
// must not make the house create keys, nor collect their codes and links.
//
//   X-Gate-Response-Signature: hex HMAC-SHA256(secret, "response\n" + <our
//                              X-Gate-Signature> + "\n" + sha256(response body))
//
// Bound to this request's own signature, an old answer replayed is worthless.
// Nothing from an answer that fails the check is used.
// ============================================================

/** The two trees of guestFlow's connector: same key, same signature, same signed answers. */
const TREES = { gate: "/public/v1/gate", home: "/public/v1/home" } as const;
type Tree = keyof typeof TREES;
const REQUEST_TIMEOUT_MS = 20_000;
/** guestFlow holds a long poll at most this long (homeController MAX_WAIT_S). */
export const HOME_WAIT_S = 25;
/** guestFlow refuses a batch above this. */
export const MAX_RESULTS_PER_POST = 500;

export class GuestFlowError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** The answer did not come from guestFlow: wrong or missing response signature. */
    readonly impostor = false,
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

export function signResponse(secret: string, requestSignature: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`response\n${requestSignature}\n${bodyHash}`).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Codes and links travel in the results: never in clear, except to this machine itself. */
export function checkBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  throw new GuestFlowError("guestFlow must be reached over https", null);
}

export class GuestFlowClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: ClientConfig) {
    this.base = checkBaseUrl(config.baseUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  async keys(): Promise<GateKey[]> {
    const body = await this.request("gate", "GET", "/keys");
    const keys = (body as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) throw new GuestFlowError("guestFlow answered without keys[]", 200);
    return keys.filter(isGateKey).map(withStay);
  }

  async results(results: GateResult[]): Promise<void> {
    for (let i = 0; i < results.length; i += MAX_RESULTS_PER_POST) {
      await this.request("gate", "POST", "/results", { results: results.slice(i, i + MAX_RESULTS_PER_POST) });
    }
  }

  // ── Home automation (spec 002) ─────────────────────────────

  /** The catalogue, answered with the pairs guestFlow wants values for. */
  async homeCatalog(equipments: HomeCatalogEntry[]): Promise<HomeSelectionPair[]> {
    const body = await this.request("home", "PUT", "/catalog", { equipments });
    const selection = (body as { selection?: unknown }).selection;
    if (!Array.isArray(selection)) throw new GuestFlowError("guestFlow answered without selection[]", 200);
    return selection
      .filter(
        (p): p is HomeSelectionPair =>
          !!p &&
          typeof (p as HomeSelectionPair).equipmentId === "string" &&
          typeof (p as HomeSelectionPair).alias === "string",
      )
      .map((p) => ({ equipmentId: p.equipmentId, alias: p.alias }));
  }

  async homeReadings(readings: HomeReading[]): Promise<void> {
    await this.request("home", "POST", "/readings", { readings });
  }

  async homeSeries(series: HomeSeries[]): Promise<void> {
    await this.request("home", "POST", "/series", { series });
  }

  /**
   * The long poll: guestFlow answers at once with a command, or empty after `wait` seconds.
   * `invalid` is the id of each unusable command whose id could be read, to be answered.
   */
  async homeCommands(
    signal?: AbortSignal,
    wait = HOME_WAIT_S,
  ): Promise<{ commands: HomeCommand[]; invalid: number[] }> {
    const body = await this.request("home", "GET", `/commands?wait=${wait}`, undefined, {
      timeoutMs: (wait + 15) * 1000,
      signal,
    });
    const commands = (body as { commands?: unknown }).commands;
    if (!Array.isArray(commands)) throw new GuestFlowError("guestFlow answered without commands[]", 200);
    const invalid = commands
      .filter((c) => !isHomeCommand(c))
      .map((c) => (c as { id?: unknown } | null)?.id)
      .filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0);
    return {
      commands: commands.filter(isHomeCommand).map((c) => ({
        id: c.id,
        propertyId: c.propertyId,
        equipmentId: c.equipmentId,
        value: c.value,
        issuedAt: c.issuedAt,
      })),
      invalid,
    };
  }

  async homeResults(results: HomeResult[]): Promise<void> {
    for (let i = 0; i < results.length; i += MAX_RESULTS_PER_POST) {
      await this.request("home", "POST", "/commands/results", { results: results.slice(i, i + MAX_RESULTS_PER_POST) });
    }
  }

  private async request(
    tree: Tree,
    method: "GET" | "POST" | "PUT",
    path: string,
    payload?: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    // Keep a base path the owner may have put in front of guestFlow.
    const prefix = this.base.pathname.replace(/\/+$/, "");
    const pathAndQuery = `${prefix}${TREES[tree]}${path}`;
    const url = new URL(pathAndQuery, this.base.origin);
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = this.now();
    const signature = signRequest(this.config.signingSecret, method, pathAndQuery, timestamp, body);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-Gate-Timestamp": String(timestamp),
      "X-Gate-Signature": signature,
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: payload === undefined ? undefined : body,
        signal: controller.signal,
        // A redirect would carry the key and the results somewhere else.
        redirect: "error",
      });
    } catch (err) {
      throw new GuestFlowError(
        `guestFlow cannot be reached: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (!res.ok) {
      const reason =
        res.status === 401 || res.status === 403
          ? "guestFlow refused the key or the signature"
          : `guestFlow answered ${res.status}`;
      throw new GuestFlowError(`${reason} on ${method} ${path}`, res.status);
    }
    const text = await res.text();
    const claimed = res.headers.get("X-Gate-Response-Signature") ?? "";
    if (!sameHex(claimed, signResponse(this.config.signingSecret, signature, text))) {
      throw new GuestFlowError(
        `the answer to ${method} ${path} is not signed by guestFlow`,
        res.status,
        true,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GuestFlowError(`guestFlow answered ${method} ${path} with no JSON`, res.status);
    }
  }
}

function isHomeCommand(value: unknown): value is HomeCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(c.id) &&
    (c.id as number) > 0 &&
    Number.isSafeInteger(c.propertyId) &&
    typeof c.equipmentId === "string" &&
    c.equipmentId.length > 0 &&
    (c.value === "on" || c.value === "off") &&
    typeof c.issuedAt === "string"
  );
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

/**
 * Keep the key's own fields, and its `stay` only when it is well formed: a
 * malformed stay never costs the key, it only stays off the devices.
 */
function withStay(key: GateKey): GateKey {
  const { reservationId, action, label, startsAt, endsAt } = key;
  const stay = parseStay((key as { stay?: unknown }).stay);
  return stay ? { reservationId, action, label, startsAt, endsAt, stay } : { reservationId, action, label, startsAt, endsAt };
}

export function parseStay(value: unknown): Stay | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Record<string, unknown>;
  if (typeof s.propertyId !== "number" || !Number.isSafeInteger(s.propertyId)) return undefined;
  if (typeof s.propertyName !== "string" || !s.propertyName.trim()) return undefined;
  if (typeof s.arrival !== "string" || Number.isNaN(Date.parse(s.arrival))) return undefined;
  if (typeof s.departure !== "string" || Number.isNaN(Date.parse(s.departure))) return undefined;
  return {
    propertyId: s.propertyId,
    propertyName: s.propertyName.trim(),
    arrival: s.arrival,
    departure: s.departure,
  };
}
