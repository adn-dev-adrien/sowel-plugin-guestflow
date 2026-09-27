# Sowel Plugin: guestFlow gate keys

Gives each [guestFlow](https://github.com/adn-dev-adrien/guestFlow) stay its own key to the gate,
using Sowel's **shared access** (spec 181). One stay, one key: created seven days before the
arrival, valid from three hours before check-in to two hours after check-out, and ended by Sowel
with the stay — even if guestFlow or this plugin is down.

guestFlow holds **no credential on the house**. The plugin runs inside Sowel and:

1. reads guestFlow's list of keys to create (every hour, and on the plugin's **Refresh** button);
2. makes each stay the shared access `gf:<reservationId>` on the **default profile** — the owner
   picks the gates there, guestFlow never names one; a cancelled stay is revoked;
3. reports every result back: the code and link for the guest emails, or the failure and its
   reason, which guestFlow shows on its dashboard and pushes to its admins.

If guestFlow cannot be reached or refuses the signature, or a key cannot be created, a Sowel alarm
is raised once and cleared when it passes. guestFlow alerts on its side when the list has not been
read for three hours.

## Setup

1. In Sowel, turn **Shared access** on (Settings) and set its public address.
2. Install this plugin (Administration → Plugins → personal source
   `adn-dev-adrien/sowel-plugin-guestflow`).
3. Fill its three settings with what guestFlow shows in **Réglages → Intégrations** (admins only):
   guestFlow's address (https), `GATE_API_KEY` and `GATE_SIGNING_SECRET`.
4. In **Shared access → Profiles**, grant the **Default** profile to **guestFlow** and tick the gates
   it opens. Until then every key fails with `unknown_profile`.

## Security

- **Nobody can pose as guestFlow.** Every answer from guestFlow carries
  `X-Gate-Response-Signature` = hex HMAC-SHA256(`GATE_SIGNING_SECRET`,
  `response\n<the request's X-Gate-Signature>\n<sha256 of the answer body>`). An answer that fails
  the check is not used: no key is created, no result is sent, and an alarm is raised. Bound to the
  request's own signature, an old answer replayed is worthless.
- **https only** (plain http only to `localhost`), and redirects are refused: codes and links never
  travel in clear or to another host.
- **A key never lasts more than 31 days**, whatever the list says (`implausible_stay`): it bounds
  what a guestFlow in the wrong hands could ask the house for. Keys only open the gates of the
  default profile, chosen by the owner in Sowel.

## Wire contract

Signed with `Authorization: Bearer <GATE_API_KEY>`, `X-Gate-Timestamp` (ms) and
`X-Gate-Signature` = hex HMAC-SHA256 of `METHOD\npath?query\ntimestamp\nsha256(body)`.

- `GET /public/v1/gate/keys` → `{ now, keys: [{ reservationId, action: "create"|"revoke", label, startsAt, endsAt }] }`
- `POST /public/v1/gate/results` ← `{ results: [{ reservationId, action, ok: true, state, code, url } | { reservationId, action, ok: false, error, message }] }`

## Development

```bash
npm ci
npm run typecheck && npm test && npm run build
```

A `v*` tag builds the release tarball Sowel installs.

## License

AGPL-3.0
