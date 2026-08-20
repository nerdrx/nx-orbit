# lastfm-orbit

A tiny standalone Node CLI (ES modules, **zero dependencies**) that feeds your
Last.fm half of [NX Orbit](../../SPEC.md).

It uses the **official Last.fm API** with **your own API key**, reads **your own
friends list**, and turns what each friend is broadcasting right now — their
now-playing track — into a verbatim `status` observation. That is the
"what's everyone up to" surface, and it's the whole point of this source.

## What it does NOT provide: presence

**Scrobbles are not presence, and this plugin never pretends otherwise.**

Last.fm publishes no online/offline state. It publishes *what you are playing*.
Those are different facts about a person, and turning one into the other —
"aria scrobbled a track, therefore aria is online" — is exactly the inference
[SPEC §0.3](../../SPEC.md) forbids. Someone can be listening on a phone in a
tunnel; someone can be very much around with the music off.

So: **zero `presence` observations**, from any code path, including for
yourself. This source never contributes to "who's on now" or to the overlap
heatmap. It contributes to the **status board** and the **roster**. Anything
more would be Orbit guessing about people, which is the thing Orbit exists not
to do.

There is also **no taste analysis**: no top-artists, no genres, no
compatibility score, no ranking, no "you two both like…". The track text is
passed through and that is the end of it. Orbit is not a recommender.

## What it reads (and why each field is first-person-visible)

| call | why it is yours to read |
| --- | --- |
| `user.getInfo` (you) | your own profile |
| `user.getFriends` (you, paginated) | the people **you added as friends** on Last.fm |
| `user.getRecentTracks` (each friend, `limit=1`) | the now-playing/last track their own profile page shows |

Nothing else. No charts, no tag pages, no `user.getNeighbours` / "similar
users", no library crawling, no account you did not friend.

Per friend:

| Orbit field | from Last.fm |
| --- | --- |
| `sourceId`, `handle` | `name` (their username) |
| `displayName` | `realname` if they set one, otherwise `name` |
| `avatarUrl` | the largest non-empty entry of `image` (display-only, never re-hosted) |

And per friend, at most one observation:

| situation | observation |
| --- | --- |
| `@attr.nowplaying === "true"` | `status`, `text: "♪ <Artist> — <Track>"`, `ts` = now — they are broadcasting it *right now* |
| most recent track has `date.uts` | `status`, same text, `ts` = that scrobble's own published time |
| neither | **nothing** — there is no honest timestamp to attach |

A friend with a private or empty recent-tracks feed still gets a `Person` row
and simply no status. Failures there are logged as notes, not errors.

## Rate limiting

Last.fm's terms ask for **no more than ~5 requests/second** averaged over five
minutes. This plugin sleeps **250 ms between per-friend calls** (≈4 req/s, with
margin) — see `--delay-ms` to change it, though raising it above 5/s is a good
way to get your key throttled.

With a large friends list that adds up: 200 friends ≈ 50 seconds. Use
`--max-friends N` to cap how many friends get a track lookup per run.

## Get an API key the compliant way

Create one at <https://www.last.fm/api/account/create>. It's a read key for your
own use; no OAuth, no write scope, no session needed for any call this plugin
makes.

Pass it with `--api-key`, export `$LASTFM_API_KEY`, or write it to a file so it
stays out of your shell history:

```bash
install -m 600 /dev/null ~/.config/nx-orbit/lastfm.key
# paste the key into that file
```

## Usage

```bash
# Offline dry run against the bundled fixture — no network, no POST, no snapshot:
node index.js --from-fixture fixture.sample.json --dry-run

# Dry run against the real API:
node index.js --user yourname --dry-run

# Real run — POST to Orbit on the default port 8477:
node index.js --user yourname

# Big friends list: only look up the first 25, and slow the calls down:
node index.js --user yourname --max-friends 25 --delay-ms 400
```

Flags:

| flag | meaning |
| --- | --- |
| `--user NAME` | your own Last.fm username (or `$LASTFM_USER`) |
| `--api-key KEY` | your own API key (or `$LASTFM_API_KEY`, or `~/.config/nx-orbit/lastfm.key`) |
| `--max-friends N` | only look up the first N friends' recent track (default: all) |
| `--delay-ms N` | delay between per-friend calls (default `250`) |
| `--from-fixture FILE` | read canned API responses from a file instead of the network |
| `--dry-run` | print the batch to stdout instead of POSTing; snapshot untouched |
| `--port N` | loopback ingest port (default `8477`) |
| `--token TOKEN` | Orbit ingest bearer token (see resolution order below) |
| `-h`, `--help` | usage |

Exit codes: `0` success (or a successful dry run), `1` any error — bad API key,
unreachable API, unreadable fixture, or a batch the core rejected.

## Configure the Orbit ingest token

Resolution order (first hit wins):

1. `--token <TOKEN>` flag
2. `NX_ORBIT_TOKEN` environment variable
3. `~/.config/nx-orbit/ingest.token`

Copy the token from **NX Orbit → Settings → Sources**. Rotating it there
invalidates the old one.

## Change detection (idempotent)

State lives in `~/.config/nx-orbit/lastfm-orbit.snapshot.json` (with
`--from-fixture` it is `…snapshot.fixture.json`, so testing never disturbs your
real state). Each run diffs against it:

| change | observation |
| --- | --- |
| the track differs from the one last emitted | `status` |
| `realname` differs | `nick` (`meta.previous` = old name) |
| avatar URL differs | `avatar` (`meta.previous` = old URL) |
| friend appeared | `friend` (`meta.state: "friended"`) |
| friend disappeared | `friend` (`meta.state: "unfriended"`) |

The track gate matters: polling every five minutes while a friend keeps the same
song on would otherwise write a fresh `status` row each poll, because a
now-playing track is stamped with the *poll* time. Gating on the text means one
row per song. A finished scrobble keeps its own `date.uts`, so re-emitting it is
naturally deduped by the core ([SPEC §3](../../SPEC.md)) as well.

**The first run emits no `friend` events** — with no snapshot there is no honest
"you friended them at" timestamp, and stamping the whole list with `Date.now()`
would be fabricated history. Re-running with the snapshot intact emits nothing;
persons are re-upserted idempotently. The snapshot only advances on an accepted
(`200`) batch, and `--dry-run` never writes it.

An *unfriended* user's `Person` row is re-sent alongside its `friend`
observation, so the batch always carries its own subjects and validates
standalone.

## Offline testing

[`fixture.sample.json`](fixture.sample.json) mirrors real API response bodies,
keyed by method name. It covers a now-playing friend, a friend whose last track
is a finished scrobble with `date.uts`, a friend with an empty track list, a
friend whose feed is unavailable, two pages of `user.getFriends`, and the
API quirk where a single-element list arrives as a bare object.

```bash
node index.js --from-fixture fixture.sample.json --dry-run
```

Tests live in [`../../test/lastfm-orbit.test.js`](../../test/lastfm-orbit.test.js)
and push the emitted batch through the real `src/main/ingest.js` validator.

## The batch it POSTs

```
POST http://127.0.0.1:8477/ingest
Authorization: Bearer <your Orbit ingest token>
Content-Type: application/json
```

Example body (from `fixture.sample.json`, first run, "now" fixed at
`1690000000000` for readability):

```json
{
  "plugin": "lastfm-orbit",
  "version": "1.0.0",
  "emittedAt": 1690000000000,
  "persons": [
    {
      "source": "self",
      "sourceId": "me",
      "handle": "nerdrx",
      "displayName": "nerdrx",
      "avatarUrl": "https://lastfm.freetls.fastly.net/i/u/300x300/self.png"
    },
    {
      "source": "lastfm",
      "sourceId": "ariaplays",
      "handle": "ariaplays",
      "displayName": "Aria",
      "avatarUrl": "https://lastfm.freetls.fastly.net/i/u/300x300/aria.png"
    },
    {
      "source": "lastfm",
      "sourceId": "kazmusic",
      "handle": "kazmusic",
      "displayName": "kazmusic",
      "avatarUrl": "https://lastfm.freetls.fastly.net/i/u/174s/kaz.png"
    },
    {
      "source": "lastfm",
      "sourceId": "quietlistener",
      "handle": "quietlistener",
      "displayName": "June"
    },
    {
      "source": "lastfm",
      "sourceId": "privatepete",
      "handle": "privatepete",
      "displayName": "Pete",
      "avatarUrl": "https://lastfm.freetls.fastly.net/i/u/174s/pete.png"
    }
  ],
  "observations": [
    {
      "source": "self",
      "sourceId": "me",
      "kind": "status",
      "text": "♪ Boards of Canada — Roygbiv",
      "ts": 1690000000000
    },
    {
      "source": "lastfm",
      "sourceId": "ariaplays",
      "kind": "status",
      "text": "♪ Alix Perez — Forsaken",
      "ts": 1690000000000
    },
    {
      "source": "lastfm",
      "sourceId": "kazmusic",
      "kind": "status",
      "text": "♪ Fishmans — Long Season",
      "ts": 1755630000000
    }
  ]
}
```

Note what is **absent**: no `presence`, and no `status` field on any observation
— Last.fm publishes no presence ring, so there is no slot to map onto and none
is faked. `quietlistener` and `privatepete` appear as people with nothing to
report, which is the correct answer, not an omission.

## The `self` person

Your own account gets the reserved `{source:"self", sourceId:"me"}` person
([SPEC §2.1](../../SPEC.md)) and, when you're playing something, a `status`
observation — you're part of "what's everyone up to" too. Still **no presence
for you either**: the rule doesn't bend for the operator.

## License

MIT © 2026 nerdrx.
