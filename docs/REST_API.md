# NX Orbit — the local REST API (v1)

**Write a source plugin in any language.** Orbit runs a tiny HTTP server on
`127.0.0.1` that accepts batches of records about *your own friends*, from any
process on your machine that can speak HTTP and JSON. Python, Go, Rust, a shell
script with `curl` — nothing about this API is JavaScript-specific.

```
base url   http://127.0.0.1:8477          (port configurable in Settings → Sources)
auth       Authorization: Bearer <token>  (~/.config/nx-orbit/ingest.token, mode 0600)
body       application/json, max 8 MiB
```

This document is the contract. The consent rules that decide whether your
plugin is *allowed* to send a given record live in
[`PLUGIN_GUIDELINES.md`](PLUGIN_GUIDELINES.md), and the data model lives in
[`SPEC.md`](../SPEC.md) §2–§3. **A REST source is held to exactly the same five
rules as any other plugin** — friends-only/first-person, surface-only,
observations-not-conclusions, local-delivery-only, verbatim-and-attributed.
Speaking HTTP instead of importing a JS module changes nothing about that.

---

## Why there is no read API

**Every endpoint here is write-only. There is no endpoint that returns person
data — not one, and this is not an oversight or a "v2 thing."**

SPEC §0.6: *"There is exactly one user: you. Orbit never multi-tenants, never
builds profiles 'for' anyone else, **never exposes an API for a third party to
query your friends**."*

An ingest API and a query API are morally different objects. An ingest API lets
a tool you installed hand Orbit something *you could already see yourself*. A
query API turns your friends into a queryable dataset that any process on your
box — or, one XSS away, any web page — can pull down in one request. The whole
point of Orbit is that your friends' data has exactly one reader: you, in the
Orbit window. So:

- `GET /api/v1/people` does not exist. Nor does `/persons`, `/observations`,
  `/search`, or a filter/query parameter anywhere. They return `404`.
- The one endpoint that reports *anything* about what has been ingested,
  `GET /api/v1/sources`, reports on **plugins**, not people: which source last
  ran, when, and how many records it sent. Counts and plugin names, no rows.
- Error bodies name a **record index and a field**, never a value. Post a batch
  with a bad `source` and you get `{"part":"persons","index":0,"field":"source",
  …}` — never the person's name, handle, or bio echoed back. The server also
  redacts, as a second line of defense, any person-authored string from your own
  batch that would otherwise appear in an error reason.
- Reading your data is what the app window is for. If you want it out, it's
  SQLite at `~/.config/nx-orbit/orbit.sqlite3`, on your disk, and it's yours.

### And why the API is hostile to browsers

Two related defenses, both deliberate, both tested:

**No CORS.** Orbit never sends `Access-Control-Allow-Origin`, and an `OPTIONS`
preflight gets `405`, not a permissive `204`. A web page therefore cannot read
any response from this API, and cannot send a JSON `POST` to it at all (a
`Content-Type: application/json` cross-origin POST requires a preflight the
server refuses). Enabling CORS "just for localhost tools" would make every open
browser tab a potential client of your ingest endpoint. Native processes — your
Python script, your Go binary, `curl` — are unaffected; nothing outside a
browser has ever cared about CORS.

**Host-header pinning (DNS rebinding).** A page on `evil.example` can point its
own hostname at `127.0.0.1` and then make the browser connect to your loopback
port from inside its own origin. The connection genuinely *is* from `127.0.0.1`,
so checking the peer address cannot catch it. What gives it away is the `Host`
header: the browser sends the name it dialled. Orbit rejects, with `403`, any
request whose `Host` is not `127.0.0.1[:port]`, `localhost[:port]`, or
`[::1][:port]`. Always send a literal loopback `Host` — every HTTP client does
this by default when you connect to `http://127.0.0.1:8477`.

On top of those: the socket binds `127.0.0.1` only (never reachable off-box),
and any peer that somehow isn't loopback is dropped without a response.

---

## Auth

The token is a 64-character hex string generated on Orbit's first run:

```
~/.config/nx-orbit/ingest.token      # mode 0600, one line
```

Send it on every request except the two health endpoints:

```
Authorization: Bearer 4f3c…c1
```

Comparison is constant-time (`crypto.timingSafeEqual`, length-guarded), so a
wrong token leaks nothing through response timing. A missing, malformed,
wrong-length, or wrong token is always a flat `401 {"error":"unauthorized"}`.

**Recommended resolution order for your plugin** (the shipped `twitter-orbit`
CLI does exactly this): `--token` flag → `$NX_ORBIT_TOKEN` → read
`~/.config/nx-orbit/ingest.token`.

```bash
TOKEN=$(cat ~/.config/nx-orbit/ingest.token)
```

**Rotating the token.** Delete the file and restart Orbit (or use Settings →
Sources → rotate). Orbit writes a fresh 0600 token on next start. Every emitter
using the old token starts getting `401` until reconfigured — which is the
intended behavior: rotation is how you revoke a plugin you no longer trust.
Never commit the token, never send it anywhere but `127.0.0.1`, never put it in
a URL query string.

---

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | no | legacy liveness alias — `{"ok":true}` |
| `POST` | `/ingest` | yes | legacy ingest alias (shipped plugins use this) |
| `GET` | `/api/v1/health` | no | liveness + versions |
| `GET` | `/api/v1/schema` | yes | machine-readable contract (enums, fields, limits) |
| `POST` | `/api/v1/validate` | yes | full validation, **writes nothing** |
| `POST` | `/api/v1/ingest` | yes | validate + write |
| `GET` | `/api/v1/sources` | yes | source registry + last-run telemetry |

The unversioned `/health` and `/ingest` are permanent aliases — existing
emitters keep working forever. New plugins should use `/api/v1/*`.

### `GET /api/v1/health`

No auth: this is how a plugin checks Orbit is up before doing any work. It
reveals nothing about you or your friends.

```bash
curl -s http://127.0.0.1:8477/api/v1/health
```

```json
{ "ok": true, "version": "0.1.0", "schemaVersion": 1, "uptimeSec": 4210 }
```

- `version` — Orbit's app version.
- `schemaVersion` — the database schema version (SPEC §4 migration ladder).
- `uptimeSec` — seconds since the ingest server started.

Connection refused = Orbit isn't running. Back off and try later; **never**
queue records to a remote service in the meantime (rule 4).

### `GET /api/v1/schema`

The contract, as data. It is generated from the validator's own constants, so
it can never drift from what `POST /api/v1/ingest` actually enforces. Fetch it
at startup and self-validate before you send anything.

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8477/api/v1/schema
```

```json
{
  "api": "nx-orbit",
  "apiVersion": "v1",
  "writeOnly": true,
  "kinds": ["presence", "status", "location", "bio", "nick", "avatar", "friend"],
  "statuses": ["online", "active", "idle", "joinme", "askme", "busy", "offline"],
  "personFields": ["source", "sourceId", "handle", "displayName", "avatarUrl",
                   "birthday", "pronouns", "bio", "note", "links"],
  "observationFields": ["source", "sourceId", "kind", "ts", "status", "text", "place", "meta"],
  "requiredPersonFields": ["source", "sourceId"],
  "requiredObservationFields": ["source", "sourceId", "kind", "ts"],
  "sources": {
    "vrcx": ["vrcx"],
    "vencord-orbit-bridge": ["discord"],
    "twitter-orbit": ["twitter"],
    "steam-orbit": ["steam"],
    "contacts-orbit": ["contacts"],
    "mastodon-orbit": ["mastodon"],
    "lastfm-orbit": ["lastfm"],
    "matrix-orbit": ["matrix"],
    "manual": ["manual"]
  },
  "self": { "source": "self", "sourceId": "me" },
  "maxBodyBytes": 8388608,
  "batch": {
    "plugin": "string (a key of `sources`)",
    "version": "string (your plugin semver)",
    "emittedAt": "number (epoch ms)",
    "persons": "Person[] (upserts, may be empty)",
    "observations": "Observation[] (appended, deduped, may be empty)"
  },
  "dedupKey": ["source", "sourceId", "kind", "ts", "coalesce(text, place, status)"],
  "allOrNothing": true
}
```

`sources` is the **registry**: it maps each registered `plugin` name to the
`Person.source` values that plugin is permitted to write. Your batch's `plugin`
must be a key of this map, and every person you send must carry a `source` from
its list (plus `self`, see below). The live endpoint is authoritative — the
listing above is a snapshot. **Adding a new plugin/source pair means adding a
registry entry in the core and a SPEC line; it is a core change, not something
a plugin can do at runtime.** If your source isn't there yet, open a PR.

### `POST /api/v1/validate`

Identical body to `/api/v1/ingest`, identical validation — and **nothing is
written**: no person row, no observation, not even an audit-log entry. It is
the same code path as the real ingest with a dry-run flag, so it can't tell you
"valid" and then have the real thing reject you.

```bash
curl -s -X POST http://127.0.0.1:8477/api/v1/validate \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @batch.json
```

```json
{ "valid": true, "would": { "persons": 2, "observations": 5 } }
```

`would.observations` counts what you submitted. A real ingest may report fewer
`accepted.observations` because duplicates are silently dropped — that's dedup
working, not an error.

Failure (`422`):

```json
{
  "valid": false,
  "rejected": [
    { "part": "observations", "index": 3, "field": "kind", "reason": "kind \"message\" not in enum" }
  ]
}
```

Use this endpoint while developing: it lets you iterate on your record shapes
against the real validator without putting a single bad row in the database.

### `POST /api/v1/ingest` (and legacy `POST /ingest`)

```bash
curl -s -X POST http://127.0.0.1:8477/api/v1/ingest \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @batch.json
```

Success (`200`):

```json
{ "accepted": { "persons": 2, "observations": 4 } }
```

Failure (`422`) — **the entire batch was refused; nothing was written**:

```json
{
  "rejected": [
    { "part": "persons", "index": 0, "field": "source",
      "reason": "source \"discord\" not declared by plugin \"twitter-orbit\"" },
    { "part": "observations", "index": 7, "field": "ts", "reason": "missing/invalid ts" }
  ]
}
```

Every rejection is `{part, index, field, reason}`. `index` is the position in
your `persons` / `observations` array (`-1` for envelope-level problems, where
`part` is `"batch"`). Fix and resubmit the whole batch.

The only behavioral difference between the two paths: legacy `/ingest` reports
malformed JSON as `422 {"rejected":[…"invalid JSON"]}` (its historical shape,
kept so shipped emitters see no change), while `/api/v1/ingest` reports it as
`400 {"error":"invalid JSON"}`.

### `GET /api/v1/sources`

Operational telemetry about **sources**, with zero person data in it.

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8477/api/v1/sources
```

```json
{
  "sources": { "vrcx": ["vrcx"], "twitter-orbit": ["twitter"], "…": ["…"] },
  "self": { "source": "self", "sourceId": "me" },
  "lastRun": [
    { "plugin": "twitter-orbit", "version": "1.0.0",
      "receivedAt": 1755690000000, "nPersons": 143, "nObs": 512 },
    { "plugin": "vrcx", "version": "1.0.0",
      "receivedAt": 1755690600000, "nPersons": 88, "nObs": 2044 }
  ]
}
```

`lastRun` is the newest audit-log row per plugin (SPEC §4 `ingest_log`). Use it
to answer "did my last run land?" — never to discover anything about people,
because there is nothing about people in it.

---

## The batch envelope

One JSON object, both ingest paths, both endpoints (SPEC §3):

```json
{
  "plugin": "twitter-orbit",
  "version": "1.0.0",
  "emittedAt": 1755690000000,
  "persons": [],
  "observations": []
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `plugin` | string | must be a key of `schema.sources` |
| `version` | string | your plugin's own semver, recorded in the audit log |
| `emittedAt` | number | epoch **milliseconds**, when you built the batch |
| `persons` | array | upserts, may be `[]` |
| `observations` | array | appended + deduped, may be `[]` |

### `Person`

```json
{
  "source": "twitter",
  "sourceId": "1425867",
  "handle": "friend",
  "displayName": "Friend",
  "avatarUrl": "https://pbs.twimg.com/…",
  "birthday": "03-14",
  "pronouns": "they/them",
  "bio": "their own bio text, verbatim",
  "note": null,
  "links": [{ "source": "discord", "sourceId": "2285…" }]
}
```

- `(source, sourceId)` is the primary key. `sourceId` must be stable across
  runs — an internal id, not a handle (handles change).
- **Required:** `source`, `sourceId`. Everything else is optional; **omit what
  you don't have.** Never send `""`, `"unknown"`, or a guessed value. Omitted
  fields never overwrite what's already stored.
- `birthday` is `"MM-DD"` or `"YYYY-MM-DD"` — **no year unless the person
  actually stated the year.**
- `note` is the *operator's* private note. A source plugin should send `null`;
  it belongs to the manual/CRM path.
- `links` are operator-asserted "same human across platforms." Don't guess
  these — Orbit never infers identity links (SPEC §0.3).
- Any field not in `personFields` is rejected as column smuggling.

### `Observation`

```json
{
  "source": "twitter",
  "sourceId": "1425867",
  "kind": "status",
  "ts": 1755689000000,
  "status": null,
  "text": "🏖 away till the 20th",
  "place": null,
  "meta": { "previous": "back monday" }
}
```

- **Required:** `source`, `sourceId`, `kind`, `ts`.
- `ts` is epoch **ms of when the thing happened**, not when you scraped it. If
  your source only tells you "now," you may only emit records about now.
- The person must exist: either already in Orbit's DB, or in this same batch's
  `persons`. Otherwise the batch is rejected.
- `meta` is a small kind-specific bag. **It is not an escape hatch** — no
  scores, no inferences, no free-form dumps (rule 3).

**`kind` (closed enum):**

| kind | meaning |
| --- | --- |
| `presence` | online/offline transition |
| `status` | status ring/text changed (incl. "on holiday 🏖") |
| `location` | entered a world/server they broadcast to friends |
| `bio` | their own bio text changed |
| `nick` | display name / handle changed |
| `avatar` | avatar image changed |
| `friend` | became / stopped being your friend |

There is deliberately no `message`, `dm`, `sentiment`, `score`, or
`location_precise`. Inventing one is a `422`, by design.

**`status` (closed enum):** `online`, `active`, `idle`, `joinme`, `askme`,
`busy`, `offline`.

> If your platform has no true equivalent for a slot, **omit `status`**. Do not
> map Discord idle onto VRChat's `askme` because they look similar. A friend
> shown as "ask me" because their Discord went idle is wrong data about a
> person, which is the exact thing this project exists not to produce.

### The reserved `self` person

`{"source":"self","sourceId":"me"}` is *you*, the operator. Any plugin may emit
it — the overlap heatmap needs a "me" presence axis — but `sourceId` **must** be
exactly `"me"`, and it must describe only the operator. Emit it only if your
source can see the operator's own online history. A `self` record about anyone
else is a charter violation (SPEC §0.6), and validation rejects any `sourceId`
other than `"me"`.

It is a **presence anchor, not a display identity.** Ingest stores only
`(source, sourceId)` for it and ignores `handle`, `displayName`, `avatarUrl` and
the rest — otherwise the operator's own row would flap between their Mastodon
handle, their Last.fm name and their Matrix ID depending on which source ran
last. Sending those fields is accepted, not an error; they're simply not stored.

### Worked example — a complete, valid batch

```json
{
  "plugin": "twitter-orbit",
  "version": "1.0.0",
  "emittedAt": 1755690000000,
  "persons": [
    {
      "source": "twitter",
      "sourceId": "1425867",
      "handle": "kestrel",
      "displayName": "Kestrel",
      "avatarUrl": "https://pbs.twimg.com/profile_images/1425867/av.jpg",
      "pronouns": "she/her",
      "bio": "drum & bass, bad at plants"
    },
    {
      "source": "twitter",
      "sourceId": "990211",
      "handle": "toaster",
      "displayName": "toaster",
      "birthday": "03-14"
    }
  ],
  "observations": [
    { "source": "twitter", "sourceId": "1425867", "kind": "friend",
      "ts": 1712000000000, "meta": { "state": "following" } },
    { "source": "twitter", "sourceId": "1425867", "kind": "bio",
      "ts": 1755600000000, "text": "drum & bass, bad at plants" },
    { "source": "twitter", "sourceId": "1425867", "kind": "nick",
      "ts": 1755610000000, "text": "Kestrel", "meta": { "previous": "kes" } },
    { "source": "twitter", "sourceId": "990211", "kind": "status",
      "ts": 1755689000000, "text": "🏖 away till the 20th" }
  ]
}
```

```json
{ "accepted": { "persons": 2, "observations": 4 } }
```

Note what is *not* in there: no tweet bodies, no follower counts, no
"engagement," no sentiment, no location beyond what the person published. Only
the surface, only friends, only timestamps.

---

## Idempotency: re-send everything, every run

Observations are deduplicated on
`(source, sourceId, kind, ts, coalesce(text, place, status))`. Sending the same
record twice inserts one row. Persons are upserts keyed on
`(source, sourceId)`, and omitted/`null` fields never clobber stored values —
so a re-scan can't wipe the operator's manual note.

**Therefore: re-scan your entire source every run and send the whole history.
Do not track cursors.** Cursors are the single most common source of silent
data loss in scrapers — one crash between "read" and "save cursor" and the gap
is permanent and invisible. Full re-scan + dedup makes runs crash-safe for
free, and the response tells you exactly what was new:

```
run 1 → {"accepted":{"persons":143,"observations":512}}
run 2 → {"accepted":{"persons":143,"observations":3}}    # same batch + 3 new events
```

`accepted.persons` counts persons submitted; `accepted.observations` counts
rows actually **inserted** (duplicates excluded). A run reporting `0` new
observations means "nothing happened since last time," not "failure."

If a full re-scan exceeds `maxBodyBytes` (8 MiB), split it into several batches
and POST them in sequence. Keep each batch self-consistent: every observation's
person must be in that same batch's `persons` or already stored.

## All-or-nothing

A batch either fully applies or does nothing at all. One bad `kind` in record
#400 means records #1–#399 are **not** written. This is intentional: partial
writes make "what does Orbit actually know?" unanswerable, and a half-applied
batch is worse than no batch. Validate with `/api/v1/validate` while developing,
and treat any `422` as "fix the emitter, then resend the whole thing."

---

## Quickstart — write a source in ~20 lines

### bash + curl (no dependencies)

```bash
#!/usr/bin/env bash
set -euo pipefail
TOKEN=$(cat ~/.config/nx-orbit/ingest.token)
ORBIT=http://127.0.0.1:8477

curl -sf "$ORBIT/api/v1/health" >/dev/null || { echo "Orbit isn't running"; exit 1; }

NOW=$(( $(date +%s) * 1000 ))
cat > /tmp/batch.json <<EOF
{ "plugin": "manual", "version": "1.0.0", "emittedAt": $NOW,
  "persons": [
    { "source": "manual", "sourceId": "sam", "displayName": "Sam", "birthday": "07-02" }
  ],
  "observations": [
    { "source": "manual", "sourceId": "sam", "kind": "status",
      "ts": $NOW, "text": "🏖 away till the 20th" }
  ] }
EOF

# Dry run first — writes nothing.
curl -s -X POST "$ORBIT/api/v1/validate" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @/tmp/batch.json

# Then for real.
curl -s -X POST "$ORBIT/api/v1/ingest" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @/tmp/batch.json
```

### Python 3 (stdlib only, no `requests`)

```python
#!/usr/bin/env python3
import json, os, time, urllib.request, urllib.error

ORBIT = "http://127.0.0.1:8477"
TOKEN = os.environ.get("NX_ORBIT_TOKEN") or open(
    os.path.expanduser("~/.config/nx-orbit/ingest.token")).read().strip()

def call(path, batch=None):
    req = urllib.request.Request(
        ORBIT + path,
        data=json.dumps(batch).encode() if batch is not None else None,
        method="POST" if batch is not None else "GET",
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:      # loopback only; no proxies, no TLS
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)

now = int(time.time() * 1000)
batch = {
    "plugin": "manual", "version": "1.0.0", "emittedAt": now,
    "persons": [{"source": "manual", "sourceId": "sam",
                 "displayName": "Sam", "birthday": "07-02"}],
    "observations": [{"source": "manual", "sourceId": "sam",
                      "kind": "status", "ts": now, "text": "🏖 away till the 20th"}],
}

print(call("/api/v1/health"))                 # (200, {'ok': True, ...})
print(call("/api/v1/validate", batch))        # (200, {'valid': True, 'would': {...}})
print(call("/api/v1/ingest", batch))          # (200, {'accepted': {...}})
```

Both scripts use `plugin: "manual"` / `source: "manual"`, which is registered
out of the box — handy for experimenting. For a real plugin, get your own
`plugin` → `source` pair added to the registry (see `GET /api/v1/schema`).

A Go/Rust version is the same three lines of thought: read the token file,
`POST` JSON with a bearer header to `http://127.0.0.1:8477/api/v1/ingest`,
check for `200`. There is no SDK because there doesn't need to be one.

---

## Errors

| Code | Body | Meaning | What to do |
| --- | --- | --- | --- |
| `200` | `{"accepted":{…}}` / `{"valid":true,…}` | written / would validate | log the counts |
| `400` | `{"error":"invalid JSON"}` | body wasn't parseable JSON | fix your serializer; check you sent bytes, not a string of a string |
| `401` | `{"error":"unauthorized"}` | missing/wrong/rotated bearer token | re-read `~/.config/nx-orbit/ingest.token`; the operator may have rotated it |
| `403` | `{"error":"bad host header"}` | `Host` wasn't a loopback authority | connect to `127.0.0.1`/`localhost` directly; don't route through a proxy or a custom hostname |
| `404` | `{"error":"not found"}` | unknown path — **or a read endpoint you hoped existed** | check the path; note there is no query API by design |
| `405` | `{"error":"method not allowed"}` | wrong verb; `Allow` header names the right one | use the method in `Allow` |
| `413` | `{"error":"payload too large","maxBodyBytes":8388608}` | body over the cap | split the re-scan into several batches |
| `415` | `{"error":"unsupported media type"}` | `Content-Type` isn't `application/json` | set the header (`-H "Content-Type: application/json"`) |
| `422` | `{"rejected":[{part,index,field,reason}]}` | validation failed, **nothing written** | fix the named records; resend the whole batch |
| `500` | `{"error":"ingest failed"}` | unexpected core error | retry once; if it persists, file an issue with the batch shape (not the data) |
| conn refused | — | Orbit isn't running | back off, retry later; never buffer to a remote service |

Error bodies never contain stack traces, internal file paths, or person data.

**Retries.** `401`/`403`/`413`/`415`/`422` are your bug — retrying unchanged
will fail identically. `500` and connection failures are safe to retry: ingest
is idempotent, so re-sending the same batch cannot double-write.

---

## Checklist before you ship a REST source

- [ ] Every person I emit is a mutual/friend/followed account of the operator.
- [ ] Every field came from what the app already showed the logged-in operator.
- [ ] No `kind` outside the enum; no inference smuggled through `meta`.
- [ ] `ts` is when the event happened, not when I scraped it.
- [ ] I re-scan fully each run and rely on dedup — no cursors.
- [ ] I omit fields I don't have instead of inventing placeholders.
- [ ] I never send the token anywhere but `127.0.0.1`, and never log it.
- [ ] My source is read-only; I never write to or alter the source app.
- [ ] `POST /api/v1/validate` is clean before I ever call `/api/v1/ingest`.
- [ ] A friend reading every record I emitted about them would feel *waved at*,
      not *watched*.

See [`PLUGIN_GUIDELINES.md`](PLUGIN_GUIDELINES.md) for the full rules and the PR
checklist, and [`SPEC.md`](../SPEC.md) §0 for the charter these rules come from.
