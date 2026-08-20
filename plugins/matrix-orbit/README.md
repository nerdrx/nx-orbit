# matrix-orbit

A tiny standalone Node CLI (ES modules, **zero dependencies**) that feeds your
Matrix half of [NX Orbit](../../SPEC.md).

It talks to **your own homeserver** with **your own access token**, works out
who your contacts are from **your own `m.direct` account data**, and POSTs them
to Orbit's loopback ingest endpoint as `Person` upserts plus `presence` /
`status` / `nick` / `avatar` / `friend` observations.

Matrix is an open protocol, so this is the one external source here that gives
Orbit real presence — including **your own**, which is the "me" axis the overlap
heatmap ([SPEC §5](../../SPEC.md)) needs.

## How "friends" is defined — honestly

**Matrix has no friends list.** There is no mutual-follow, no contact roster, no
buddy list in the protocol. So this plugin defines a contact as:

> a user you share a **direct-message room** with.

That comes from `m.direct` — the account-data mapping your own clients maintain
when you start a DM. It is genuinely first-person (it's *your* account data,
written by *you*) and it's mutual-ish (a DM has two willing participants).

**What this plugin will never do is enumerate the members of a room.** Joining a
1,200-person public room does not make those 1,200 people your friends, and
harvesting their profiles and presence would be collecting strangers — a
straight violation of [SPEC §0.1](../../SPEC.md). No `/joined_members`, no
`/members`, no `/rooms/{id}/state`, no `/publicRooms`, no user directory search.

It also reads **no messages, ever**: no `/messages`, no `/sync` timeline, no
room events of any kind. Only profiles and presence.

## What it reads

| call | why it is yours to read |
| --- | --- |
| `GET /_matrix/client/v3/account/whoami` | your own MXID — that's the definition of the endpoint |
| `GET /_matrix/client/v3/user/{you}/account_data/m.direct` | **your own** DM mapping |
| `GET /_matrix/client/v3/profile/{userId}` | the display name + avatar Element already shows you next to their name |
| `GET /_matrix/client/v3/presence/{userId}/status` | the presence + status message they broadcast |

Per contact:

| Orbit field | from Matrix |
| --- | --- |
| `sourceId`, `handle` | the full MXID, e.g. `@aria:matrix.example` |
| `displayName` | `profile.displayname` (falls back to the MXID, never a placeholder) |
| `avatarUrl` | `profile.avatar_url` (`mxc://…`) converted to an `https` thumbnail |

`mxc://server/mediaId` becomes
`https://your.homeserver/_matrix/media/v3/thumbnail/server/mediaId?width=96&height=96&method=crop`
— note the fetch goes through **your** homeserver, so displaying a remote
friend's avatar never contacts a third-party server directly.

## Presence: the state → enum mapping

Matrix's presence enum is `online` / `unavailable` / `offline` — that's all of
it. Here is exactly how it lands on [SPEC §2.2](../../SPEC.md):

| Matrix | Orbit emits | note |
| --- | --- | --- |
| `presence: "online"` | `Observation{kind:"presence", status:"online"}` | |
| `presence: "unavailable"` | `Observation{kind:"presence", status:"online"}` **and** `Observation{kind:"status", status:"idle"}` | Element shows this as "Away": still connected, just idle |
| `presence: "offline"` | `Observation{kind:"presence", status:"offline"}` | |
| `status_msg` non-empty | `Observation{kind:"status", text: <verbatim>}` | merged into the `idle` status row when the user is also `unavailable` |
| anything else | **nothing** | an unrecognised state is not mapped to a nearest-looking slot |

**`joinme`, `askme` and `busy` are never emitted.** `joinme`/`askme` are VRChat
instance rings and mean nothing on Matrix. `busy` would need a real
do-not-disturb state, and Matrix has none — Element's "Busy" is a client-side
label, not a protocol presence value. Per SPEC §2.2, a plugin without a true
equivalent **omits `status`** rather than faking the nearest slot, so that's
what happens here.

**Timestamps are truthful.** When the server sends `last_active_ago` (ms since
the person was last active), `ts` is `Date.now() - last_active_ago` — when the
thing actually happened, not when this tool polled. Without it, `ts` is now.

### Many homeservers disable presence — that's fine

Presence is expensive to federate, so a lot of servers turn it off (Synapse's
`use_presence: false`; matrix.org itself serves it only partially). Those
servers answer `/presence` with `403 M_FORBIDDEN` or `404`.

This plugin **degrades gracefully**: it skips presence for those users, prints a
clear note, and still emits the roster —

```
note: this homeserver does not serve presence (every /presence call was refused).
      That is a common server setting, not a failure — emitting the roster without presence.
```

— and exits `0`. A presence-disabled server gives you a Matrix **roster and
change feed**; it just won't feed the heatmap. See
[`fixture.presence-disabled.json`](fixture.presence-disabled.json).

## Get an access token from Element

**Settings → Help & About → Advanced → Access Token** (click to reveal).

> ⚠️ **An access token is as powerful as your password.** It can read your
> rooms, send messages as you, and change your account — until you invalidate it
> by logging that session out. Treat it accordingly:
>
> - **Put it in the token file, not on the command line.** Anything you type as
>   `--matrix-token …` lands in your shell history in plaintext, forever, and in
>   the process list where every local process can read it.
> - Do not paste it into a chat, an issue, or a pastebin — including to ask for
>   help with this tool.
> - Logging that Element session out invalidates the token. Do that if it leaks.
>
> This plugin only ever sends the token to the homeserver you named, over TLS.
> It is never written to the snapshot, never logged, and never included in the
> batch POSTed to Orbit.

```bash
install -m 600 /dev/null ~/.config/nx-orbit/matrix.token
# paste the token into that file
```

`$MATRIX_TOKEN` also works, but an exported env var is visible to every child
process you start — the file is better.

## Usage

```bash
# Offline dry run against the bundled fixture — no network, no POST, no snapshot:
node index.js --from-fixture fixture.sample.json --dry-run

# The presence-disabled homeserver case:
node index.js --from-fixture fixture.presence-disabled.json --dry-run

# Dry run against your real homeserver (token from ~/.config/nx-orbit/matrix.token):
node index.js --homeserver https://matrix.org --dry-run

# Real run — POST to Orbit on the default port 8477:
node index.js --homeserver https://matrix.org
```

Flags:

| flag | meaning |
| --- | --- |
| `--homeserver URL` | your homeserver base URL (or `$MATRIX_HOMESERVER`) |
| `--matrix-token TOK` | your access token (or `$MATRIX_TOKEN`, or `~/.config/nx-orbit/matrix.token` — **prefer the file**) |
| `--from-fixture FILE` | read canned API responses from a file instead of the network |
| `--dry-run` | print the batch to stdout instead of POSTing; snapshot untouched |
| `--port N` | loopback ingest port (default `8477`) |
| `--token TOKEN` | Orbit ingest bearer token (see resolution order below) |
| `-h`, `--help` | usage |

Exit codes: `0` success (or a successful dry run), `1` any error — bad token,
unreachable homeserver, unreadable fixture, or a batch the core rejected.
A presence-disabled homeserver is **not** an error.

## Configure the Orbit ingest token

Resolution order (first hit wins):

1. `--token <TOKEN>` flag
2. `NX_ORBIT_TOKEN` environment variable
3. `~/.config/nx-orbit/ingest.token`

Copy the token from **NX Orbit → Settings → Sources**. Rotating it there
invalidates the old one.

## Change detection (idempotent)

State lives in `~/.config/nx-orbit/matrix-orbit.snapshot.json` (with
`--from-fixture` it is `…snapshot.fixture.json`, so testing never disturbs your
real state). Each run diffs against it:

| change | observation |
| --- | --- |
| presence state or `status_msg` differs | `presence` (+ `status`) |
| `displayname` differs | `nick` (`meta.previous` = old name) |
| avatar differs | `avatar` (`meta.previous` = old URL) |
| DM contact appeared | `friend` (`meta.state: "dm-opened"`) |
| DM contact disappeared | `friend` (`meta.state: "dm-closed"`) |

Presence is emitted **on transition**, not once per poll. Running this on a
five-minute timer therefore records "aria came online at 19:04", not 288
identical rows a day — which is what [SPEC §2.2](../../SPEC.md) means by
"online/offline transition". The first run baselines whatever the current state
is.

**The first run emits no `friend` events** — with no snapshot there is no honest
"this DM opened at" timestamp. Re-running with the snapshot intact and nothing
changed emits nothing; persons are re-upserted idempotently. The snapshot only
advances on an accepted (`200`) batch, and `--dry-run` never writes it.

A *closed*-DM contact's `Person` row is re-sent alongside its `friend`
observation, so the batch always carries its own subjects and validates
standalone.

## Offline testing

[`fixture.sample.json`](fixture.sample.json) mirrors the four endpoints above.
It covers `online`, `unavailable` + `status_msg`, `offline`, a contact whose
presence lookup is refused (403), a note-to-self DM (correctly *not* a contact),
a stale `m.direct` entry with no rooms (ignored), a remote user's `mxc://`
avatar, and a contact with no profile at all.
[`fixture.presence-disabled.json`](fixture.presence-disabled.json) is the
all-refused homeserver.

```bash
node index.js --from-fixture fixture.sample.json --dry-run
node index.js --from-fixture fixture.presence-disabled.json --dry-run
```

Tests live in [`../../test/matrix-orbit.test.js`](../../test/matrix-orbit.test.js)
and push the emitted batch through the real `src/main/ingest.js` validator.

## The batch it POSTs

```
POST http://127.0.0.1:8477/ingest
Authorization: Bearer <your Orbit ingest token>
Content-Type: application/json
```

Example body (from `fixture.sample.json`, first run, "now" fixed at
`1690000000000` so the `last_active_ago` arithmetic is legible):

```json
{
  "plugin": "matrix-orbit",
  "version": "1.0.0",
  "emittedAt": 1690000000000,
  "persons": [
    {
      "source": "self",
      "sourceId": "me",
      "handle": "@nerdrx:matrix.example",
      "displayName": "nerdrx",
      "avatarUrl": "https://matrix.example/_matrix/media/v3/thumbnail/matrix.example/SelfAvatarMediaId01?width=96&height=96&method=crop"
    },
    {
      "source": "matrix",
      "sourceId": "@aria:matrix.example",
      "handle": "@aria:matrix.example",
      "displayName": "Aria ✨",
      "avatarUrl": "https://matrix.example/_matrix/media/v3/thumbnail/matrix.example/AriaAvatarMediaId02?width=96&height=96&method=crop"
    },
    {
      "source": "matrix",
      "sourceId": "@june:matrix.example",
      "handle": "@june:matrix.example",
      "displayName": "June"
    },
    {
      "source": "matrix",
      "sourceId": "@kaz:fedi.example",
      "handle": "@kaz:fedi.example",
      "displayName": "kaz",
      "avatarUrl": "https://matrix.example/_matrix/media/v3/thumbnail/fedi.example/KazAvatarMediaId03?width=96&height=96&method=crop"
    },
    {
      "source": "matrix",
      "sourceId": "@quiet:matrix.example",
      "handle": "@quiet:matrix.example",
      "displayName": "@quiet:matrix.example"
    }
  ],
  "observations": [
    {
      "source": "self",
      "sourceId": "me",
      "kind": "presence",
      "status": "online",
      "ts": 1689999998500
    },
    {
      "source": "matrix",
      "sourceId": "@aria:matrix.example",
      "kind": "presence",
      "status": "online",
      "ts": 1689999958000
    },
    {
      "source": "matrix",
      "sourceId": "@aria:matrix.example",
      "kind": "status",
      "text": "🏖 away till the 20th — slow replies",
      "ts": 1689999958000
    },
    {
      "source": "matrix",
      "sourceId": "@june:matrix.example",
      "kind": "presence",
      "status": "offline",
      "ts": 1689913600000
    },
    {
      "source": "matrix",
      "sourceId": "@kaz:fedi.example",
      "kind": "presence",
      "status": "online",
      "ts": 1689999070000
    },
    {
      "source": "matrix",
      "sourceId": "@kaz:fedi.example",
      "kind": "status",
      "status": "idle",
      "ts": 1689999070000,
      "text": "brb, coffee"
    }
  ]
}
```

Things to read off that: `@quiet` has a person row and **no** observations —
their presence lookup was refused, and Orbit would rather know nothing than
guess. `@kaz` is `unavailable`, so they get `presence: online` plus a status
ring of `idle` — not `askme`, not `busy`. `@aria`'s status text goes to the
status board verbatim ([SPEC §2.3](../../SPEC.md)); nothing parses it or
concludes she is on holiday.

## The `self` person

`whoami` identifies you, so the plugin emits the reserved
`{source:"self", sourceId:"me"}` person ([SPEC §2.1](../../SPEC.md)) **with real
presence observations** — Matrix can see your own presence, and that's the "me"
axis `overlapHeatmap()` needs to compute "hours we were both online". On a
presence-disabled homeserver `self` is identity only, same as everyone else.

## License

MIT © 2026 nerdrx.
