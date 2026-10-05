import type { GateKey, GateResult, SharedAccessApi } from "./types.js";

// ============================================================
// One stay, one key. A guestFlow reservation becomes the external access
// `gf:<reservationId>` on the default profile: guestFlow never names a gate,
// the owner chose them on that profile. The core ends the access with the stay
// on its own, even when this plugin or guestFlow is down.
// ============================================================

export const EXTERNAL_PREFIX = "gf:";
/**
 * Longer than this, a key is refused whatever the list says: it bounds what a
 * guestFlow in the wrong hands could ask the house for.
 */
export const MAX_STAY_MS = 31 * 24 * 60 * 60_000;

export function externalIdOf(reservationId: string): string {
  return `${EXTERNAL_PREFIX}${reservationId}`;
}

/** Why a span is refused, or null. Unreadable dates are left to the core. */
export function spanRefusal(from: string, until: string): { error: string; message: string } | null {
  const span = Date.parse(until) - Date.parse(from);
  if (span > MAX_STAY_MS) return { error: "implausible_stay", message: "A stay longer than 31 days is refused" };
  if (span <= 0) return { error: "invalid_stay", message: "A stay whose departure is not after its arrival is refused" };
  return null;
}

/** A key is refused for its own dates, and for its stay's when it carries one. */
export function refusalOf(key: GateKey): { error: string; message: string } | null {
  return (
    spanRefusal(key.startsAt, key.endsAt) ??
    (key.stay ? spanRefusal(key.stay.arrival, key.stay.departure) : null)
  );
}

/** Apply every key of the list; never throws, every key gets a result. */
export function applyKeys(api: SharedAccessApi, keys: GateKey[]): GateResult[] {
  const results: GateResult[] = [];
  for (const key of keys) {
    const externalId = externalIdOf(key.reservationId);
    try {
      if (key.action === "create") {
        const refusal = refusalOf(key);
        if (refusal) {
          results.push({ reservationId: key.reservationId, action: "create", ok: false, ...refusal });
          continue;
        }
        const invitation = api.upsert(externalId, {
          label: key.label,
          from: key.startsAt,
          until: key.endsAt,
        });
        results.push({
          reservationId: key.reservationId,
          action: "create",
          ok: true,
          state: "not_yet", // replaced below, from one read of the list
          code: invitation.code,
          url: invitation.invitationUrl,
        });
      } else {
        api.revoke(externalId);
        results.push({
          reservationId: key.reservationId,
          action: "revoke",
          ok: true,
          state: "revoked",
        });
      }
    } catch (err) {
      // The owner revoked this stay's key in Sowel (or revoked and deleted it):
      // Sowel refuses to bring it back. That is the key's true state, not a
      // failure: guestFlow shows « Révoqué » and offers no code, and nobody is
      // alerted for a decision the owner made.
      if (errorCode(err) === "revoked") {
        results.push({ reservationId: key.reservationId, action: key.action, ok: true, state: "revoked" });
        continue;
      }
      results.push({
        reservationId: key.reservationId,
        action: key.action,
        ok: false,
        error: errorCode(err),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const created = results.filter((r) => r.ok && r.action === "create");
  if (created.length > 0) {
    const states = new Map(api.list().map((a) => [a.externalId, a.state]));
    for (const r of created) {
      if (r.ok) r.state = states.get(externalIdOf(r.reservationId)) ?? r.state;
    }
  }
  return results;
}

/** The core's errors carry a `code` (SharedAccessError); anything else is internal. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "internal_error";
}
