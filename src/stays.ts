import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spanRefusal } from "./sync.js";
import type { DiscoveredDevice, GateKey } from "./types.js";

// ============================================================
// Stays as devices. Each property guestFlow names becomes the device
// `property-<id>`: is it occupied now, and the dates of the current stay, or
// of the next one. The list guestFlow sends only holds the stays of the coming
// week, so « next » never looks further than that.
// ============================================================

/** One stay kept for the devices. No guest name: the label is not kept. */
export interface StayEntry {
  reservationId: string;
  propertyId: number;
  arrival: string;
  departure: string;
}

/** What the plugin remembers of the last list read. */
export interface StaysMemory {
  /** Every property ever seen, id → name: one that leaves the list is reset, not forgotten. */
  properties: Record<string, string>;
  stays: StayEntry[];
}

export interface DeviceValues {
  occupied: boolean;
  arrival: string;
  departure: string;
}

export const EMPTY_MEMORY: StaysMemory = { properties: {}, stays: [] };

export function sourceIdOf(propertyId: number | string): string {
  return `property-${propertyId}`;
}

export function discoveredDeviceOf(propertyName: string, propertyId: number | string): DiscoveredDevice {
  return {
    // The core makes the friendly name the device's source id: it must not
    // change when the property is renamed in guestFlow.
    friendlyName: sourceIdOf(propertyId),
    manufacturer: "guestFlow",
    model: `Séjours ${propertyName}`,
    data: [
      { key: "occupied", type: "boolean", category: "generic" },
      { key: "arrival", type: "text", category: "generic" },
      { key: "departure", type: "text", category: "generic" },
    ],
    orders: [],
  };
}

/**
 * The memory after a read: the list's stays, cancelled and refused ones
 * dropped, and the properties it names added to those already known.
 */
export function staysFromKeys(
  keys: GateKey[],
  previous: StaysMemory,
): { memory: StaysMemory; ignored: { reservationId: string; error: string }[] } {
  const properties = { ...previous.properties };
  const stays: StayEntry[] = [];
  const ignored: { reservationId: string; error: string }[] = [];
  for (const key of keys) {
    if (!key.stay) continue;
    properties[String(key.stay.propertyId)] = key.stay.propertyName;
    if (key.action !== "create") continue;
    const refusal = spanRefusal(key.stay.arrival, key.stay.departure);
    if (refusal) {
      ignored.push({ reservationId: key.reservationId, error: refusal.error });
      continue;
    }
    stays.push({
      reservationId: key.reservationId,
      propertyId: key.stay.propertyId,
      arrival: key.stay.arrival,
      departure: key.stay.departure,
    });
  }
  return { memory: { properties, stays }, ignored };
}

/** The current stay if there is one, else the next one, else nothing. */
export function valuesOf(memory: StaysMemory, propertyId: number | string, now: number): DeviceValues {
  const own = memory.stays
    .filter((s) => String(s.propertyId) === String(propertyId))
    .sort((a, b) => Date.parse(a.arrival) - Date.parse(b.arrival));
  const current = own.find((s) => Date.parse(s.arrival) <= now && now < Date.parse(s.departure));
  if (current) return { occupied: true, arrival: current.arrival, departure: current.departure };
  const next = own.find((s) => Date.parse(s.arrival) > now);
  if (next) return { occupied: false, arrival: next.arrival, departure: next.departure };
  return { occupied: false, arrival: "", departure: "" };
}

/** The next arrival or departure after `now`, in ms, or null. */
export function nextBoundary(memory: StaysMemory, now: number): number | null {
  let next: number | null = null;
  for (const s of memory.stays) {
    for (const t of [Date.parse(s.arrival), Date.parse(s.departure)]) {
      if (t > now && (next === null || t < next)) next = t;
    }
  }
  return next;
}

// ── Memory on disk ───────────────────────────────────────────

const FILE = "stays.json";

/** Read the memory; null when there is none or it cannot be read. */
export function loadMemory(dataDir: string): StaysMemory | null {
  let text: string;
  try {
    text = readFileSync(join(dataDir, FILE), "utf8");
  } catch {
    return null;
  }
  const raw = JSON.parse(text) as Partial<StaysMemory>;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.stays) || !raw.properties) {
    throw new Error("stays memory is malformed");
  }
  const properties: Record<string, string> = {};
  for (const [id, name] of Object.entries(raw.properties)) {
    if (typeof name === "string") properties[id] = name;
  }
  const stays = raw.stays.filter(
    (s): s is StayEntry =>
      !!s &&
      typeof s.reservationId === "string" &&
      typeof s.propertyId === "number" &&
      typeof s.arrival === "string" &&
      typeof s.departure === "string",
  );
  return { properties, stays };
}

/** Written whole or not at all: a temp file renamed over the old one. */
export function saveMemory(dataDir: string, memory: StaysMemory): void {
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ savedAt: new Date().toISOString(), ...memory }, null, 2));
  renameSync(temp, target);
}
