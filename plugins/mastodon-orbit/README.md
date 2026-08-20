# mastodon-orbit

A tiny standalone Node CLI (ES modules, **zero dependencies**) that feeds your
Mastodon half of [NX Orbit](../../SPEC.md).

It logs into **your own instance** with **your own access token**, reads **only
the accounts you follow**, and POSTs them to Orbit's loopback ingest endpoint as
`Person` upserts plus `bio` / `nick` / `avatar` / `friend` change observations.

## What it does NOT provide: presence

**Mastodon has no presence.** There is no online/offline/idle/away signal in the
protocol or the API — not for your follows, not for anyone. So this plugin emits
**zero `presence` observations**, and it will never contribute to Orbit's
"who's on now" panel or the overlap heatmap. Faking presence out of "last posted
at" would be exactly the inference [SPEC §0.3](../../SPEC.md) forbids, so it
isn't done.

What you *do* get from Mastodon is a **roster with real profile detail** —
pronouns and birthdays that people published themselves — and a **change feed**
when someone rewrites their bio, renames, or swaps their avatar. That is the
honest shape of this source.

## What it reads (and why each field is first-person-visible)

Exactly two endpoints, both about you:

| call | why it is yours to read |
| --- | --- |
| `GET /api/v1/accounts/verify_credentials` | your own account — that's the definition of the endpoint |
| `GET /api/v1/accounts/:you/following` | the accounts **you chose to follow**, paginated via the `Link: rel="next"` header |

There is **no** other call. No public/local/federated timeline. No
`/api/v2/search`. No fetching a profile you don't follow. No walking anybody
else's followers or following list. If a person is not on your following list,
this plugin has never heard of them.

Per followed account it maps the profile card the instance already renders to
you:

| Orbit field | from Mastodon |
| --- | --- |
| `sourceId` | `account.id` |
| `handle` | `@acct`, always domain-qualified (a local `alice` becomes `@alice@your.instance`) |
| `displayName` | `display_name` |
| `avatarUrl` | `avatar_static` (display-only, never re-hosted) |
| `bio` | `note`, HTML-stripped to plain text, otherwise verbatim |
| `pronouns` | a profile metadata **field** whose name matches `pronoun`/`pronouns` |
| `birthday` | a profile metadata **field** whose name matches `birthday`/`bday`/`born` |

Pronouns and birthday come from Mastodon's profile metadata `fields` — the four
key/value rows a person fills in on their own profile page and publishes to
everyone. That is precisely the "shared-by-them" category
[SPEC §2.1](../../SPEC.md) permits. No other field name is read: a `Location`
row stays unread, because Orbit has no place to put it and doesn't want one.

### Birthdays: a year is never invented

`parseBirthday` accepts what people actually type and refuses the rest:

| they wrote | Orbit stores |
| --- | --- |
| `1994-05-12` | `1994-05-12` (they stated the year) |
| `May 12`, `12 May`, `3rd of March` | `05-12`, `05-12`, `03-03` — **no year** |
| `May 12th, 1994` | `1994-05-12` |
| `05-12` (dash form = ISO order) | `05-12` |
| `18/07` | `07-18` — 18 can only be a day |
| `03/04` | *nothing* — `DD/MM` and `MM/DD` are indistinguishable, so it is refused |
| `sometime in spring` | *nothing* |

An unparseable value is **omitted**, never stored as a placeholder or a guess.

### Bios are rendered as the person wrote them

`note` arrives as sanitised HTML. The plugin turns `<br>` and block ends into
newlines, drops the remaining markup (so a link keeps its visible text), and
*then* decodes entities — so `&lt;marquee&gt;` that someone literally typed
survives as `<marquee>` instead of vanishing. Nothing is truncated, reworded, or
normalised.

## Get an access token the compliant way

On your own instance: **Preferences → Development → New application**. Give it
only these scopes:

```
read:accounts   read:follows
```

Nothing else is needed, and nothing else should be granted — no `write`, no
`read:statuses`, no `follow`. Copy the application's **access token**.

Then either pass it with `--mastodon-token`, export `$MASTODON_TOKEN`, or (best)
write it to a file so it stays out of your shell history:

```bash
install -m 600 /dev/null ~/.config/nx-orbit/mastodon.token
# paste the token into that file
```

## Usage

```bash
# Offline dry run against the bundled fixture — no network, no POST, no snapshot:
node index.js --from-fixture fixture.sample.json --dry-run

# Dry run against your real instance:
node index.js --instance https://mastodon.social --dry-run

# Real run — POST to Orbit on the default port 8477:
node index.js --instance https://mastodon.social

# Everything explicit:
node index.js --instance https://mastodon.social --mastodon-token abc… \
              --port 8477 --token nxo_live_…
```

Flags:

| flag | meaning |
| --- | --- |
| `--instance URL` | your instance (or `$MASTODON_INSTANCE`) |
| `--mastodon-token TOK` | your access token (or `$MASTODON_TOKEN`, or `~/.config/nx-orbit/mastodon.token`) |
| `--from-fixture FILE` | read canned API responses from a file instead of the network |
| `--dry-run` | print the batch to stdout instead of POSTing; snapshot untouched |
| `--port N` | loopback ingest port (default `8477`) |
| `--token TOKEN` | Orbit ingest bearer token (see resolution order below) |
| `-h`, `--help` | usage |

Exit codes: `0` success (or a successful dry run), `1` any error — bad token,
unreachable instance, unreadable fixture, or a batch the core rejected.

## Configure the Orbit ingest token

Resolution order (first hit wins):

1. `--token <TOKEN>` flag
2. `NX_ORBIT_TOKEN` environment variable
3. `~/.config/nx-orbit/ingest.token`

Copy the token from **NX Orbit → Settings → Sources**. Rotating it there
invalidates the old one.

## Change detection (idempotent)

State lives in `~/.config/nx-orbit/mastodon-orbit.snapshot.json` (with
`--from-fixture` it is `…snapshot.fixture.json`, so testing never disturbs your
real state). On each run the current following list is diffed against it:

| change | observation |
| --- | --- |
| `note` differs | `bio` (`meta.previous` = old bio) |
| `display_name` differs | `nick` (`meta.previous` = old name) |
| `avatar_static` URL differs | `avatar` (`meta.previous` = old URL) |
| account appeared | `friend` (`meta.state: "followed"`) |
| account disappeared | `friend` (`meta.state: "unfollowed"`) |

**The first run emits no `friend` events.** With no snapshot there is no honest
"you followed them at" timestamp, and stamping 400 follows with `Date.now()`
would be fabricated history. The first run just baselines each non-empty bio.

Re-running with the snapshot intact emits **no** observations; persons are
re-upserted idempotently. The snapshot only advances on an accepted (`200`)
batch, and `--dry-run` never writes it.

Note that an *unfollowed* account's `Person` row is re-sent alongside its
`friend` observation, so the batch always carries its own subjects and validates
standalone.

## Offline testing

[`fixture.sample.json`](fixture.sample.json) mirrors real API response shapes —
`verify_credentials` plus three `following_pages`, each carrying the verbatim
`Link` header of that page. The pagination loop and the `rel="next"` parser run
against it for real, so `--from-fixture` exercises the same code path the
network does. It covers a pronouns field, a birthday with and without a year, an
ambiguous date that must be refused, a remote (`user@other.domain`) follow, a
bot with no display name and no bio, and an HTML bio with a link and entities.

```bash
node index.js --from-fixture fixture.sample.json --dry-run
```

Tests live in [`../../test/mastodon-orbit.test.js`](../../test/mastodon-orbit.test.js)
and push the emitted batch through the real `src/main/ingest.js` validator.

## The batch it POSTs

```
POST http://127.0.0.1:8477/ingest
Authorization: Bearer <your Orbit ingest token>
Content-Type: application/json
```

Example body (from `fixture.sample.json`, first run, timestamps fixed for
readability):

```json
{
  "plugin": "mastodon-orbit",
  "version": "1.0.0",
  "emittedAt": 1690000000000,
  "persons": [
    {
      "source": "self",
      "sourceId": "me",
      "handle": "@nerdrx@mastodon.example",
      "displayName": "nerdrx",
      "avatarUrl": "https://files.mastodon.example/accounts/avatars/108/176/original/a1b2c3.png"
    },
    {
      "source": "mastodon",
      "sourceId": "7710",
      "handle": "@aria@mastodon.example",
      "displayName": "Aria ✨",
      "avatarUrl": "https://files.mastodon.example/accounts/avatars/000/007/710/original/aria-v3.png",
      "bio": "Synth builder, DnB enjoyer.\nCommissions: https://aria.example\n\nshe/her & occasionally they/them",
      "pronouns": "she/her",
      "birthday": "1994-05-12"
    },
    {
      "source": "mastodon",
      "sourceId": "7708",
      "handle": "@kaz@fedi.example",
      "displayName": "kaz",
      "avatarUrl": "https://files.mastodon.example/cache/accounts/avatars/000/007/708/original/kaz.jpg",
      "bio": "🏖 away till the 20th — slow replies",
      "pronouns": "he/him",
      "birthday": "03-03"
    },
    {
      "source": "mastodon",
      "sourceId": "7702",
      "handle": "@orbitbot@bots.example",
      "displayName": "@orbitbot@bots.example",
      "avatarUrl": "https://bots.example/avatars/orbitbot.png"
    },
    {
      "source": "mastodon",
      "sourceId": "7690",
      "handle": "@june@mastodon.example",
      "displayName": "June",
      "avatarUrl": "https://files.mastodon.example/accounts/avatars/000/007/690/original/june.png",
      "bio": "zines & bikes",
      "pronouns": "they/them",
      "birthday": "07-18"
    }
  ],
  "observations": [
    {
      "source": "mastodon",
      "sourceId": "7710",
      "kind": "bio",
      "text": "Synth builder, DnB enjoyer.\nCommissions: https://aria.example\n\nshe/her & occasionally they/them",
      "ts": 1690000000000
    },
    {
      "source": "mastodon",
      "sourceId": "7708",
      "kind": "bio",
      "text": "🏖 away till the 20th — slow replies",
      "ts": 1690000000000
    },
    {
      "source": "mastodon",
      "sourceId": "7690",
      "kind": "bio",
      "text": "zines & bikes",
      "ts": 1690000000000
    }
  ]
}
```

Note kaz's bio: it lands on Orbit's **status board** verbatim, exactly as
[SPEC §2.3](../../SPEC.md) describes. Nothing parses it, classifies it, or
concludes "kaz is on holiday" — you read the words kaz wrote.

## The `self` person

`verify_credentials` identifies you, so the plugin emits the reserved
`{source:"self", sourceId:"me"}` person ([SPEC §2.1](../../SPEC.md)) with your
own handle, display name and avatar. It carries **no observations**: Mastodon
gives no presence, not even about yourself, so there is nothing to put on the
heatmap's "me" axis from here. That axis comes from VRCX or matrix-orbit.

## License

MIT © 2026 nerdrx.
