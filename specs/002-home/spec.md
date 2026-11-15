# Spec 002 — Home automation for guests: catalogue, readings, lights (plugin v0.5.0 + recipe `guest-home` v0.1.0)

Status: **implemented** (plugin v0.5.0, recipe v0.1.0 — 2026-11-15). Summary: guestFlow
`specs/guest-app-home-automation-maquette.html` (the whole flow, both halves, interactive).
Companion spec: guestFlow `specs/guest-app-home-automation.md` (the source of the rules cited below
as « gF rule n »).

## Why

guestFlow's guest app gets a « Domotique » page: room temperatures, outdoor weather, rain, the
lodging's electricity, and the lights the owner entrusts to guests. A Sowel API token cannot be
scoped, so guestFlow must hold none (gF §1). As for the gate, **the house calls guestFlow**: this
plugin carries the traffic, and a recipe — the only part allowed to read equipments and send
orders — decides and acts. « Rien de ce qui décide ne doit aussi actionner » (guest-gate README).

## What changes — plugin `guestflow` v0.5.0

1. **Same channel, same secrets.** New calls to guestFlow's `/public/v1/home/**`, signed exactly
   like `/public/v1/gate/**` (`GATE_API_KEY`, `GATE_SIGNING_SECRET`, HMAC request and response
   signatures). No new setting. The gate and stays flows are unchanged.
2. **A bridge device**, id `home-bridge`, named « Domotique GuestFlow »:
   - orders (from the recipe): `home_catalog`, `home_readings`, `home_series`, `home_result` —
     text, JSON;
   - data (to the recipe): `home_selection` (JSON list of `{ equipmentId, alias }`),
     `home_command` (JSON of the latest command), `home_command_seq` (number, +1 per command).
3. **Catalogue** — on `home_catalog`, `PUT /public/v1/home/catalog` with the recipe's list
   (deduplicated: an identical list is not resent within the hour), and hourly. The answer's
   `selection` is published on `home_selection`.
4. **Readings / series** — on `home_readings` / `home_series`, `POST` them as received. A failure
   is logged and dropped: the next batch supersedes it (no queue, no replay of stale values).
5. **Commands** — a long-poll loop on `GET /public/v1/home/commands?wait=25`, restarted at once
   after an answer and with backoff (5 s → 5 min) after an error. For each command:
   - **occupancy guard** (gF rule 9): the plugin already holds the stays (spec 001). A command for
     a property that is not occupied now is answered `ok: false, reason: "not_occupied"` and never
     published. This protects against a guestFlow bug, not a compromised guestFlow (it sends the
     stays), which is why the recipe holds the real boundary;
   - otherwise `home_command` is set and `home_command_seq` incremented.
6. **Results** — on `home_result`, `POST /public/v1/home/commands/results`.
7. The plugin **never sends an order** to any equipment.

## What changes — new recipe `sowel-recipe-guest-home` v0.1.0

One instance for the whole house, like `guest-gate`.

1. **Slots**: the zone for its tile; the bridge equipment (bound to `home-bridge`); **« Lumières
   confiées aux voyageurs »**, a multi-select of light equipments — the one setting in Sowel
   (gF rule 9bis), filled once.
2. **Catalogue** — at start and on any equipment created, renamed, moved, deleted or rebound:
   every equipment of type `sensor`, `thermostat`, `weather`, `energy_meter`, `main_energy_meter`,
   `light_onoff`, `light_dimmable`, `light_color`, or `switch` with a light category, with its id,
   name, zone path, type and readable values (alias, category, unit). A light carries
   `guestSwitchable: true` iff it is in the whitelist. No value. Sent through `home_catalog`.
3. **Readings** — every 60 s, the current value, unit and last-updated time of each pair in
   `home_selection` only, through `home_readings`. A pair whose equipment no longer exists is
   skipped.
4. **Series** — at each hour boundary the recipe records, per selected equipment, the previous
   hour's `rain_1h` and `energy_hour` into its state store (persistent), keeps 24 buckets, and sends
   them every 15 min through `home_series`. After a fresh install the series fills over 24 h.
5. **Commands** — on `home_command_seq` strictly greater than the last seen (never on the first
   read after a start, like `guest-gate`), it executes the command only if **all** hold:
   - the equipment exists and is a light (the types of 2);
   - it is in the whitelist (slot 1);
   - `issuedAt` is less than 60 s old;
   - fewer than 20 commands for that `propertyId` in the last hour;
   then `ctx.dispatchOrder` on its `state` order (`"ON"`/`"OFF"` for an enum, `true`/`false` for a
   boolean). No timer: the light stays as switched (gF rule 7).
   It reports `{ id, ok, reason? }` through `home_result` — reasons `not_a_light`,
   `not_entrusted`, `too_old`, `rate_limited`, `order_failed`. Never retried.
6. Every refusal is written to the recipe log with the command id; executions appear in the
   Activity feed (attributed dispatch, spec 101).

## Tests

- Plugin: signature vectors shared with guestFlow (unchanged canonical string); catalogue dedupe;
  selection published; long-poll restart and backoff; unoccupied command refused and never
  published; results posted; no order ever sent by the plugin.
- Recipe: catalogue shape and `guestSwitchable` exactly for whitelisted lights; readings only for
  the selection; hourly buckets and 24-bucket window; command refused for a non-light, a light off
  the whitelist, a 61 s old command, the 21st in an hour; no execution on the first read; ON/OFF and
  boolean lights both driven.

## Risk

The whitelist is the boundary: whoever fully controls guestFlow can switch **the entrusted lights**
on or off, at most 20 times an hour per lodging, and nothing else (gF rule 11, accepted by Adrien on
2026-11-15). Readings of non-selected equipments never leave the house; the catalogue does describe
the whole house's sensors and lights by name and zone, values excluded.

## Implementation notes (2026-11-15)

What the Sowel core imposed or the build settled, beyond the rules above:

1. **Whitelist slot** — core's `type: "equipment", list: true` (a `string[]`). Its filter cannot test a category, so it
   lists every `switch`; validation then refuses one without a `light_state` binding.
2. **Bridge orders** — declared through `upsertFromDiscovery` with `orders: [{ key, type: "text" }]`. Core uses the
   friendly name as the source id: the device is `home-bridge`, « Domotique GuestFlow » is its model.
3. **`invalid_command`** — an extra refusal reason, for an unreadable command or a value other than on/off.
4. **`home_command_seq`** starts from `Date.now()` at plugin start, so a restarted plugin never publishes a lower
   number the recipe would ignore.
5. **Long poll** — an empty answer that came back in under 5 s waits 5 s before the next poll (no busy loop); the
   client times out at `wait + 15` s.
6. **Catalogue** — the plugin keeps the last one in its data directory and resends it at start; the recipe resends it
   hourly and 2 s after a change (equipment, `zone.updated`, `zone.removed`). Core has no binding-change event: a
   rebind is seen at the hourly resend. The bridge equipment is left out of the catalogue.
7. **Series** — hourly aliases `rain_1h`, `energy_hour`, and `sum_rain_1` (guestFlow's `homeRoles` fall-back); a
   bucket is the last sample of the hour that just closed; readings and series also read `computedData`, where core
   keeps `rain_1h` and `energy_hour`.
8. **Rate limit** — counts the commands that passed the type, whitelist and age checks, per `propertyId`, and survives
   a recipe restart (state store). An `issuedAt` more than 60 s in the future is refused as `too_old`.
9. **Light order** — the `state` order, else category `light_toggle` / `toggle_power`; `true`/`false` for a boolean
   order, the enum's own ON/OFF otherwise.
10. **Signature** — two request vectors of the home tree are pinned here and in guestFlow's
    `sowel-home-connector.unit.test.js`.

## Wiring in Sowel (once)

1. Install plugin 0.5.0 — same three settings as before; it publishes the `home-bridge` device.
2. Create an equipment from `home-bridge` with its 7 bindings, aliases left as the keys.
3. Install the recipe from the personal source `adn-dev-adrien/sowel-recipe-guest-home`.
4. Create one instance: its zone, the bridge equipment, and « Lumières confiées aux voyageurs ». Changing the
   whitelist restarts the instance, which resends the catalogue.

## Test counts

Plugin 55 (41 before: +11 `home.test.ts`, +3 client); recipe 15.
