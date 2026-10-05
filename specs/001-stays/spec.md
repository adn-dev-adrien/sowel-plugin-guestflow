# Spec 001 — Stays as Sowel equipment (v0.4.0)

Status: **draft, awaiting Adrien's validation**. Summary: `maquettes/stays.html`.
Companion specs: guestFlow `specs/sowel-stays-in-keys.md` (contract v3),
`sowel-recipe-heater-cap/specs/002-smart-heating/spec.md` (the consumer).

## Why

The gîte's heating recipe needs to know when a property is occupied. guestFlow already sends
Sowel, every hour and over a signed channel, one entry per stay for the gate keys. Rather than a
second API, the same list carries the stay itself (contract v3) and this plugin publishes it.

## What changes

1. **Read** — unchanged: `GET /public/v1/gate/keys`, hourly + Refresh, HMAC request and response
   signatures. A key may now carry `stay: { propertyId, propertyName, arrival, departure }`
   (ISO-8601 with offset). `stay` is optional: keys without it are still valid (`isGateKey`
   unchanged), and an old plugin ignores it.
2. **Gate keys** — unchanged.
3. **Devices** — one device per property, id `property-<propertyId>`, named
   "Séjours <propertyName>", data:
   - `occupied` (boolean),
   - `arrival`, `departure` (ISO-8601 text) of the current stay, else the next one, else empty.
   `occupied` flips at the exact arrival/departure instant on a timer, without waiting for the
   next read. Cancelled (`revoke`) and refused stays are dropped.
4. **Memory** — the last list read is written to `deps.dataDir` and reloaded at start, so a
   Sowel restart while guestFlow is down keeps the stays.
5. **Shared access off** — today the plugin goes to `error` without `sharedAccess`. From v0.4.0
   stays are still published; keys are reported `ok: false, error: "shared_access_off"`.
6. **Refusals** — a stay longer than 31 days or whose departure is not after its arrival is
   ignored for both the gate and the devices, and reported.

No new endpoint, no new secret, no guest name on the device.

## Tests

- `stay` absent / malformed → key still applied, no device change.
- Device values for: before arrival, during, after departure, cancelled, two stays in a row,
  two properties.
- Timer flips `occupied` at the boundary; restart with guestFlow down restores from `dataDir`.
- `sharedAccess` missing → devices published, keys reported.

## Risk

A cancellation made while guestFlow is unreachable is only seen at the next successful read:
at worst an empty property is heated.
