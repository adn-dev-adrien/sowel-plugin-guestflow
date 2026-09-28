import { describe, it, expect } from "vitest";
import { applyKeys, externalIdOf } from "../src/sync.js";
import type { AccessState, GateKey, SharedAccessApi } from "../src/types.js";

function fakeApi(opts: { fail?: Record<string, { code: string; message: string }> } = {}) {
  const accesses = new Map<string, { label: string; from: string | null; until: string; state: AccessState }>();
  const calls: string[] = [];
  const api: SharedAccessApi = {
    profiles: () => [],
    upsert(externalId, input) {
      calls.push(`upsert ${externalId}`);
      const failure = opts.fail?.[externalId];
      if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
      const prev = accesses.get(externalId);
      accesses.set(externalId, { ...input, state: prev?.state ?? "not_yet" });
      return { id: externalId, code: "4K7M-9QT2", invitationUrl: `https://acces/#i=${externalId}` };
    },
    revoke(externalId) {
      calls.push(`revoke ${externalId}`);
      const a = accesses.get(externalId);
      if (a) a.state = "revoked";
    },
    list: () =>
      [...accesses].map(([externalId, a]) => ({ externalId, state: a.state, code: null, invitationUrl: null })),
  };
  return { api, accesses, calls };
}

const stay = (id: string, action: GateKey["action"] = "create"): GateKey => ({
  reservationId: id,
  action,
  label: `Gîte · R-${id} · Marie`,
  startsAt: "2026-10-01T13:00:00.000Z",
  endsAt: "2026-10-04T09:00:00.000Z",
});

describe("applying the list of keys", () => {
  it("makes each stay one access, gf:<reservationId>, with the stay's dates", () => {
    const { api, accesses } = fakeApi();
    const results = applyKeys(api, [stay("41")]);
    expect(accesses.get("gf:41")).toMatchObject({
      label: "Gîte · R-41 · Marie",
      from: "2026-10-01T13:00:00.000Z",
      until: "2026-10-04T09:00:00.000Z",
    });
    expect(results).toEqual([
      {
        reservationId: "41",
        action: "create",
        ok: true,
        state: "not_yet",
        code: "4K7M-9QT2",
        url: "https://acces/#i=gf:41",
      },
    ]);
  });

  it("revokes a cancelled stay and reports it revoked", () => {
    const { api, accesses } = fakeApi();
    applyKeys(api, [stay("41")]);
    const results = applyKeys(api, [stay("41", "revoke")]);
    expect(accesses.get("gf:41")?.state).toBe("revoked");
    expect(results).toEqual([{ reservationId: "41", action: "revoke", ok: true, state: "revoked" }]);
  });

  it("gives every key a result: one failure does not stop the others", () => {
    const { api } = fakeApi({
      fail: { [externalIdOf("42")]: { code: "unknown_profile", message: "not granted" } },
    });
    const results = applyKeys(api, [stay("41"), stay("42"), stay("43")]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]).toEqual({
      reservationId: "42",
      action: "create",
      ok: false,
      error: "unknown_profile",
      message: "not granted",
    });
  });

  it("refuses a key longer than 31 days, whatever the list says", () => {
    const { api, calls } = fakeApi();
    const long = { ...stay("41"), startsAt: "2026-10-01T13:00:00.000Z", endsAt: "2026-11-02T13:00:01.000Z" };
    expect(applyKeys(api, [long])[0]).toMatchObject({ ok: false, error: "implausible_stay" });
    expect(calls).toEqual([]);
  });

  it("reports a stay the owner revoked in Sowel as revoked, not as a failure", () => {
    const { api } = fakeApi({ fail: { [externalIdOf("41")]: { code: "revoked", message: "The owner revoked this stay's access" } } });
    expect(applyKeys(api, [stay("41")])).toEqual([
      { reservationId: "41", action: "create", ok: true, state: "revoked" },
    ]);
  });

  it("reports an error without a code as internal_error", () => {
    const { api } = fakeApi();
    api.upsert = () => {
      throw new Error("boom");
    };
    expect(applyKeys(api, [stay("41")])[0]).toMatchObject({ ok: false, error: "internal_error", message: "boom" });
  });

  it("reads the access list once, whatever the number of keys", () => {
    const { api } = fakeApi();
    let reads = 0;
    const list = api.list;
    api.list = () => {
      reads++;
      return list();
    };
    applyKeys(api, [stay("1"), stay("2"), stay("3")]);
    expect(reads).toBe(1);
  });
});
