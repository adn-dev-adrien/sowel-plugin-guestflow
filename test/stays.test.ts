import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  EMPTY_MEMORY,
  loadMemory,
  nextBoundary,
  saveMemory,
  staysFromKeys,
  valuesOf,
} from "../src/stays.js";
import type { GateKey } from "../src/types.js";

const ARR = "2026-10-06T16:00:00+02:00";
const DEP = "2026-10-09T10:00:00+02:00";
const at = (iso: string) => Date.parse(iso);

function key(
  id: string,
  stay: Partial<NonNullable<GateKey["stay"]>> | null = {},
  action: GateKey["action"] = "create",
): GateKey {
  const k: GateKey = { reservationId: id, action, label: `Gîte · R-${id} · Julie`, startsAt: "s", endsAt: "e" };
  if (stay) k.stay = { propertyId: 1, propertyName: "Gîte", arrival: ARR, departure: DEP, ...stay };
  return k;
}

const memoryOf = (keys: GateKey[]) => staysFromKeys(keys, EMPTY_MEMORY).memory;

describe("a property's device values", () => {
  const memory = memoryOf([key("1")]);

  it("before arrival: free, with the coming stay's dates", () => {
    expect(valuesOf(memory, 1, at("2026-10-06T15:59:59+02:00"))).toEqual({ occupied: false, arrival: ARR, departure: DEP });
  });

  it("during the stay, from the arrival instant: occupied", () => {
    expect(valuesOf(memory, 1, at(ARR))).toEqual({ occupied: true, arrival: ARR, departure: DEP });
    expect(valuesOf(memory, 1, at("2026-10-09T09:59:59+02:00")).occupied).toBe(true);
  });

  it("from the departure instant: free and empty", () => {
    expect(valuesOf(memory, 1, at(DEP))).toEqual({ occupied: false, arrival: "", departure: "" });
  });

  it("a cancelled stay is dropped, but its property is known", () => {
    const m = memoryOf([key("1", {}, "revoke")]);
    expect(m.properties).toEqual({ "1": "Gîte" });
    expect(valuesOf(m, 1, at(ARR))).toEqual({ occupied: false, arrival: "", departure: "" });
  });

  it("two stays in a row: the current one, then the next from the departure", () => {
    const next = { arrival: DEP, departure: "2026-10-12T10:00:00+02:00" };
    const m = memoryOf([key("2", next), key("1")]);
    expect(valuesOf(m, 1, at("2026-10-07T12:00:00+02:00"))).toMatchObject({ occupied: true, arrival: ARR });
    expect(valuesOf(m, 1, at(DEP))).toEqual({ occupied: true, ...next });
    expect(valuesOf(m, 1, at("2026-10-01T12:00:00+02:00"))).toMatchObject({ occupied: false, arrival: ARR });
  });

  it("two properties: each its own stays", () => {
    const m = memoryOf([key("1"), key("2", { propertyId: 2, propertyName: "Lodge", arrival: "2026-10-10T16:00:00+02:00", departure: "2026-10-11T10:00:00+02:00" })]);
    expect(m.properties).toEqual({ "1": "Gîte", "2": "Lodge" });
    const now = at("2026-10-07T12:00:00+02:00");
    expect(valuesOf(m, 1, now).occupied).toBe(true);
    expect(valuesOf(m, 2, now)).toEqual({ occupied: false, arrival: "2026-10-10T16:00:00+02:00", departure: "2026-10-11T10:00:00+02:00" });
  });

  it("refused stays (over 31 days, departure not after arrival) are ignored, and said so", () => {
    const { memory: m, ignored } = staysFromKeys(
      [key("1", { departure: ARR }), key("2", { departure: "2026-11-07T16:00:01+02:00" })],
      EMPTY_MEMORY,
    );
    expect(m.stays).toEqual([]);
    expect(ignored).toEqual([
      { reservationId: "1", error: "invalid_stay" },
      { reservationId: "2", error: "implausible_stay" },
    ]);
  });

  it("a key without a stay changes nothing", () => {
    expect(memoryOf([key("1", null)])).toEqual(EMPTY_MEMORY);
  });

  it("a property that leaves the list is kept, free and empty", () => {
    const m = staysFromKeys([], memoryOf([key("1")])).memory;
    expect(m.properties).toEqual({ "1": "Gîte" });
    expect(valuesOf(m, 1, at(ARR))).toEqual({ occupied: false, arrival: "", departure: "" });
  });

  it("the next boundary is the nearest arrival or departure ahead", () => {
    expect(nextBoundary(memory, at("2026-10-01T00:00:00Z"))).toBe(at(ARR));
    expect(nextBoundary(memory, at(ARR))).toBe(at(DEP));
    expect(nextBoundary(memory, at(DEP))).toBeNull();
  });
});

describe("the stays memory on disk", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips, written through a temp file that does not linger", () => {
    dir = mkdtempSync(join(tmpdir(), "gf-stays-"));
    const m = memoryOf([key("1")]);
    expect(loadMemory(dir)).toBeNull();
    saveMemory(join(dir, "sub"), m);
    expect(loadMemory(join(dir, "sub"))).toEqual(m);
    expect(readdirSync(join(dir, "sub"))).toEqual(["stays.json"]);
  });

  it("refuses a malformed file", () => {
    dir = mkdtempSync(join(tmpdir(), "gf-stays-"));
    writeFileSync(join(dir, "stays.json"), "{ nope");
    expect(() => loadMemory(dir)).toThrow();
  });
});
