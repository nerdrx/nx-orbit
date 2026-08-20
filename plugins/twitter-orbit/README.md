# twitter-orbit

A tiny standalone Node CLI (ES modules, **zero dependencies**) that feeds your
X / Twitter half of [NX Orbit](../../SPEC.md).

It ingests **only the accounts you follow**, read from **your own data** — an X
data export or your own API token — and POSTs them to Orbit's loopback ingest
endpoint as `Person` upserts plus `bio`/`nick` change observations. It never
scrapes strangers, never crawls the firehose, and never touches an account you
don't follow. (X exposes little presence, so this is mostly a **roster + bio /
name-change** source — that's fine and by design.)

## Get your following list the compliant way

Point `--following` at a JSON file that is **yours**. Two compliant routes:

1. **Your own API token** — call your following endpoint and save the response
   body verbatim:

   ```
   GET https://api.twitter.com/2/users/:your_id/following?user.fields=description,profile_image_url
   Authorization: Bearer <YOUR OWN X API token>
   ```

   Save the JSON to `following.json`. (Shape: `{ "data": [ { id, username, name,
   description, profile_image_url }, … ] }`.)

2. **Your X data export** — request your archive in X Settings → *Your account →
   Download an archive of your data*. The `following` list it contains can be
   converted to the same JSON shape.

Accepted file shapes (auto-detected):

- **API v2**: `{ "data": [ { id, username, name, description, profile_image_url } ] }`
- **API v1.1**: `{ "users": [ { id_str, screen_name, name, description, profile_image_url_https } ] }`
- a plain **array** of either object

A ready sample lives at [`following.sample.json`](following.sample.json).

> It only ever reads accounts **you follow**, from **your own** data/token.
> There is no scraping path, no search, no "expand the graph." If a datum needed
> more than "I follow this account, using my own credentials," it isn't emitted.

## Usage

```bash
# Dry run — print the batch, POST nothing, touch no snapshot (repeatable):
node index.js --dry-run --following following.sample.json

# Real run — POST to Orbit on the default port 8477:
node index.js --following following.json

# With an explicit token and port:
node index.js --following following.json --port 8477 --token nxo_live_…
```

Flags:

| flag | meaning |
| --- | --- |
| `--following <file>` | your following list (default `following.json`) |
| `--dry-run` | print the batch to stdout instead of POSTing; snapshot untouched |
| `--port N` | loopback ingest port (default `8477`) |
| `--token TOKEN` | ingest bearer token (see resolution order below) |
| `-h`, `--help` | usage |

## Configure the token

Resolution order (first hit wins):

1. `--token <TOKEN>` flag
2. `NX_ORBIT_TOKEN` environment variable
3. `~/.config/nx-orbit/ingest.token`

Copy the token from **NX Orbit → Settings → Sources**. Rotating it there
invalidates the old one.

## Change detection (idempotent)

On the first run each followed account is baselined (a `bio` observation for any
non-empty bio). A snapshot is stored at
`~/.config/nx-orbit/twitter-orbit.snapshot.json`. On later runs the tool diffs
against it and emits observations **only for changes**:

- name changed → `nick` observation (`meta.previous` = old name)
- bio changed → `bio` observation (`meta.previous` = old bio)

Re-running with the snapshot intact emits **no** new observations (persons are
re-upserted idempotently). The snapshot only advances on an accepted (`200`)
batch; `--dry-run` never writes it.

## The batch it POSTs

```
POST http://127.0.0.1:8477/ingest
Authorization: Bearer <your Orbit ingest token>
Content-Type: application/json
```

Example body (from `following.sample.json`, first run):

```json
{
  "plugin": "twitter-orbit",
  "version": "1.0.0",
  "emittedAt": 1690000000000,
  "persons": [
    { "source": "twitter", "sourceId": "44196397", "handle": "@elonmusk", "displayName": "Elon Musk", "avatarUrl": "https://pbs.twimg.com/profile_images/…_normal.jpg" },
    { "source": "twitter", "sourceId": "12", "handle": "@jack", "displayName": "jack", "bio": "bitcoin & nostr. block head.", "avatarUrl": "https://pbs.twimg.com/profile_images/…_normal.jpg" },
    { "source": "twitter", "sourceId": "2244994945", "handle": "@TwitterDev", "displayName": "Developers", "bio": "🏖 out of office until the 20th — DMs closed. The X Dev account.", "avatarUrl": "https://pbs.twimg.com/profile_images/…_normal.jpg" }
  ],
  "observations": [
    { "source": "twitter", "sourceId": "12", "kind": "bio", "text": "bitcoin & nostr. block head.", "ts": 1690000000000 },
    { "source": "twitter", "sourceId": "2244994945", "kind": "bio", "text": "🏖 out of office until the 20th — DMs closed. The X Dev account.", "ts": 1690000000000 }
  ]
}
```

The exact `curl` equivalent:

```bash
curl -sS -X POST http://127.0.0.1:8477/ingest \
  -H "Authorization: Bearer $NX_ORBIT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plugin":"twitter-orbit","version":"1.0.0","emittedAt":1690000000000,"persons":[{"source":"twitter","sourceId":"12","handle":"@jack","displayName":"jack","bio":"bitcoin & nostr. block head."}],"observations":[{"source":"twitter","sourceId":"12","kind":"bio","text":"bitcoin & nostr. block head.","ts":1690000000000}]}'
```

## License

MIT © 2026 nerdrx.
