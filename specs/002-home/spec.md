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
     published — after one re-read of the stays (at most once a minute), since they are otherwise
     read hourly and a stay booked or extended since must not be refused. This protects against a guestFlow bug, not a compromised guestFlow (it sends the
     stays), which is why the recipe holds the real boundary;
   - otherwise `home_command` is set and `home_command_seq` incremented;
   - a command it cannot use but whose `id` it can read is answered `invalid_command`.
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
3. **Readings** — every 60 s (and 2 s after a selection change), the current value, unit and
   last-updated time of each pair in `home_selection` **that the catalogue describes** (a catalogued
   equipment, an alias among its readings, never the bridge), through `home_readings`, 200 pairs at
   most. guestFlow writes the selection, so the selection alone proves nothing (review of
   2026-11-15). A pair whose equipment no longer exists is skipped; the series of a pair no longer
   selected are forgotten.
4. **Series** — at each hour boundary the recipe records, per selected equipment, the previous
   hour's `rain_1h` and `energy_hour` into its state store (persistent), keeps 24 buckets, and sends
   them every 15 min through `home_series`. After a fresh install the series fills over 24 h.
5. **Commands** — on `home_command_seq` strictly greater than the last seen (never on the first
   read after a start, like `guest-gate`), it executes the command only if **all** hold:
   - it is in the whitelist (slot 1) — checked first, so a refusal says nothing of an unknown id;
   - the equipment exists and is a light (the types of 2);
   - `issuedAt` is less than 60 s old;
   - fewer than 20 commands for that **light** in the last hour — `propertyId` is guestFlow's word,
     so a limit keyed on it bounds nothing (review of 2026-11-15);
   - its `id` was not handled in the last hour;
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
on or off, at most 20 times an hour each, and nothing else (gF rule 11, accepted by Adrien on
2026-11-15). Readings of non-selected equipments never leave the house; the catalogue does describe
the whole house's sensors and lights by name and zone, values excluded.

## Implementation notes (2026-11-15)

What the Sowel core imposed or the build settled, beyond the rules above:

1. **Whitelist slot** — core's `type: "equipment", list: true` (a `string[]`). Its filter cannot test a category, so it
   lists every `switch`; validation then refuses one without a `light_state` binding.
2. **Bridge orders** — declared through `upsertFromDiscovery` with `orders: [{ key, type: "text" }]`. Core uses the
   friendly name as the source id: the device is `home-bridge`, « Domotique GuestFlow » is its model.
3. **`invalid_command`** — an extra refusal reason, for an unreadable command or a value other than on/off.
4. **`home_command_seq`** starts from `max(Date.now(), last published + 1)` at plugin start (the last one is kept in
   the data directory), so a restarted plugin — even across a clock stepped back — never publishes a lower number the
   recipe would ignore.
5. **Long poll** — an empty answer that came back in under 5 s waits 5 s before the next poll (no busy loop); the
   client times out at `wait + 15` s. Each run owns its abort signal, so a start right after a stop never leaves two
   loops; an error while handling one command is logged and the loop goes on.
6. **Catalogue** — the plugin keeps the last one in its data directory and resends it at start; the recipe resends it
   hourly and 2 s after a change (equipment, `zone.updated`, `zone.removed`). Core has no binding-change event: a
   rebind is seen at the hourly resend. The bridge equipment is left out of the catalogue.
7. **Series** — hourly aliases `rain_1h`, `energy_hour`, and `sum_rain_1` (guestFlow's `homeRoles` fall-back); a
   bucket is the last sample of the hour that just closed; readings and series also read `computedData`, where core
   keeps `rain_1h` and `energy_hour`.
8. **Rate limit** — counts the commands that passed the whitelist, type and age checks, per light, and survives
   a recipe restart (state store). An `issuedAt` more than 60 s in the future is refused as `too_old`.
9. **Light order** — the `state` order, else category `light_toggle` / `toggle_power`; `true`/`false` for a boolean
   order, the enum's own ON/OFF when it names them; any other order is `order_failed`.
10. **Signature** — two request vectors of the home tree are pinned here and in guestFlow's
    `sowel-home-connector.unit.test.js`.

## Wiring in Sowel (once)

1. Install plugin 0.5.0 — same three settings as before; it publishes the `home-bridge` device.
2. Create an equipment from `home-bridge` with its 7 bindings, aliases left as the keys.
3. Install the recipe from the personal source `adn-dev-adrien/sowel-recipe-guest-home`.
4. Create one instance: its zone, the bridge equipment, and « Lumières confiées aux voyageurs ». Changing the
   whitelist restarts the instance, which resends the catalogue.

## Test counts

Plugin 58 (41 before: +14 `home.test.ts`, +3 client); recipe 20.

## Amendment of 2026-11-17 — recipe `guest-home` v0.2.0 (plugin unchanged)

Wiring Adrien's house showed three defects (guestFlow spec `guest-app-home-automation.md` §3.E, rules 24-29): the
catalogue described **every** equipment of the house; the recipe and guestFlow **computed** figures Sowel already
holds; and every send is a bridge order that Sowel writes, payload included, into its activity feed — an hourly
catalogue and a reading batch a minute drowned it.

1. **Slot « Capteurs partagés »** (`sensors`, `type: "equipment", list: true`, `crossZone: true`, constrained to the
   catalogued types). The catalogue holds only these equipments plus the whitelisted lights. Nothing else is
   described, so a selection naming anything else finds no catalogue entry and sends nothing (recipe rule 3's
   « selected AND described » check, unchanged). An empty slot describes no sensor. This is the reading boundary,
   as « Lumières confiées aux voyageurs » is the acting one.
2. **No computation.** The hourly sampling (`sampleHourly`, the `series` state) is removed. The day's min/max of a
   temperature are Sowel's own `temperature_min_today` / `temperature_max_today` (spec 134, extended to every
   thermometer by `sowel-core` spec 211 R1), read like any computed value through `currentOf`. The 24 hourly buckets
   of rain and energy are read from Sowel's history through `ctx.history` (spec 211 R2). `energy_day` is the
   equipment's computed cumul as before. **Spec 211 is not a prerequisite** (Adrien, 2026-11-17): the recipe
   feature-detects `ctx.history` and each `temperature_*_today` alias, keeps `sowelVersion` at `>=1.71.0`, and without
   them sends no min/max and no series — never an estimate; everything else works in full.
3. **Send on change.** The catalogue is sent at start and when its JSON differs from the last one sent — the hourly
   forced resend is removed (the plugin's own hourly re-PUT of its stored catalogue keeps refreshing the selection
   without any Sowel order). Every 60 s the recipe sends only the pairs whose value changed since the last send, plus
   once an hour a pair that stayed the same (`READING_REFRESH_MS`), so guestFlow never hides a stable value as older
   than 6 h; nothing to send → no order. Series are read once per closed hour. A send
   that failed is retried at the next tick with the same entries.
4. **Readings are unchanged in shape.** The day's min/max travel as ordinary readings of their own aliases
   (`temperature_min_today` / `_max_today`), catalogued with the equipment like any computed value. The plugin
   relays them as it relays everything: no plugin change.

**Tests (recipe):** catalogue = shared sensors + whitelisted lights only; a selection outside it sends nothing; an
unchanged catalogue is not resent; an unchanged reading is not resent, a changed one is sent alone; min/max
are relayed as readings of `temperature_min_today` / `_max_today` when the equipment has them; buckets come from a fake `ctx.history` and are absent when
`ctx.history` is undefined.

**Wiring:** after updating the recipe to 0.2.0, edit the instance and fill « Capteurs partagés » — for Adrien's gîte:
the 7 room thermometers (Chambre Nord, Sud, Sud Est, Grenier, both bathrooms, RdC salle à manger), the outdoor
thermometer, the rain gauge « Pluviomètre », « ConsommationGite » and « EDF ».
