# NX Orbit — SPEC (contract, v1)

**A local-first dashboard for keeping up with the friends you already have.**
Birthdays, "who's around when I'm around" heatmaps, holiday/status notes, and a
gentle activity feed — built **only** from data your accounts already show you,
kept **only** on your machine. This file is the frozen contract between the core
and its plugins. Change it in the main loop, never from an agent.

**Electron 40** (ships Node 24 — required: the datastore is the built-in
`node:sqlite`, which Electron 31's Node 20 does **not** have), ES modules, no
framework, no bundler, no TypeScript in the app (plugins that live in other
codebases — Vencord — are TS because that host is). Node built-ins preferred, so
there are zero native dependencies. All logic in the main process; sandboxed
renderer behind `window.orbit` (contextBridge) — note the preload is the one
deliberate CommonJS file (`preload.cjs`), because Electron loads sandboxed
preloads with a CJS loader. MIT, © 2026 nerdrx. Matches the NX design language
(liquid glass on deep space; tokens vendored in `src/renderer/tokens.css`).

---

## 0. The charter (read this first — it is a spec, not a footer)

NX Orbit is the **consent-based inverse** of a people-profiler. Every rule below
is a hard constraint the code enforces, not an aspiration.

1. **Only first-person data.** Orbit ingests exactly what *your own* logged-in
   accounts already surface to you as a normal user: your friends list, the
   presence/status they broadcast to friends, birthdays they chose to share.
   No scraping of people who aren't your mutuals. No public-firehose collection.
   No buying, joining, or correlating third-party datasets. If obtaining a datum
   required more access than "I am this person's friend, logged in as myself,"
   it does not belong in Orbit.
2. **Local only.** The database lives on your disk. Orbit has **no server, no
   sync, no telemetry, no outbound network except**: (a) fetching a friend's
   own avatar image from the platform CDN for display, (b) a plugin's read of
   its own already-local source, and (c) a source reading the platform **you
   are a first-person member of, with your own credentials** — your Steam API
   key listing your own friends, your own Mastodon token listing who you follow.
   That last is still first-person by construction: it returns exactly what the
   platform already shows *you*, logged in as *yourself*. There is no "upload
   profile" path, because there is no profile to upload. Credentials you enter
   (a Steam API key, a token) are stored in a **0600 file in `~/.config/nx-orbit/`,
   never in `orbit.sqlite3`** (so copying your database never leaks a secret) and
   are never sent to the renderer in full.
3. **No inference about people.** Orbit does not run AI/ML over anyone. It does
   arithmetic on timestamps you already have (counts, histograms, "next
   birthday"). It never predicts, scores, ranks-by-desirability, infers
   location beyond the world/server name the person themselves published, or
   guesses anything a person didn't state. "Who's on when I'm on" is a
   histogram of overlap, not a prediction of anyone's schedule.
4. **Subject-first framing.** The unit is a *friend you keep up with*, not a
   *target you monitor*. No feature is built to surveil someone who would object
   to it. The tell: if a person seeing their own Orbit card would feel *creeped
   out* rather than *waved at*, it's the wrong feature. Notes are for "met at
   Framework's world, likes DnB," not dossiers.
5. **Forgetting is a feature.** A `retentionDays` setting prunes raw events on a
   rolling window (default 365). "Delete this person" hard-deletes every row
   keyed to them across all plugins, immediately.
6. **The operator is the only subject who matters.** There is exactly one user:
   you. Orbit never multi-tenants, never builds profiles "for" anyone else,
   never exposes an API for a third party to query your friends.

A plugin that cannot honor §0 is rejected at review. See
[`docs/PLUGIN_GUIDELINES.md`](docs/PLUGIN_GUIDELINES.md) for the enforced form.

---

## 1. Architecture

```
                  ┌─────────────────── your machine ───────────────────┐
  data you can    │                                                   │
  already see     │   sources                     core (Electron)     │
  ────────────    │   ┌───────────────┐           ┌────────────────┐  │
  VRCX.sqlite3 ───┼──▶│ vrcx (in-proc │  Batch    │ ingest.js      │  │
  (your friends)  │   │ reader)       │──────────▶│ validates §3   │  │
                  │   ├───────────────┤           │ + §0 consent   │  │
  Discord ────────┼──▶│ vencord bridge│           │ dedups, all-or-│  │
  Steam ──────────┼──▶│ steam-orbit   │  POST     │ nothing        │  │
  .vcf/.ics ──────┼──▶│ contacts-orbit│ /api/v1/  │                │  │
  Mastodon ───────┼──▶│ mastodon-orbit│  ingest   ├────────────────┤  │
  Matrix ─────────┼──▶│ matrix-orbit  │──────────▶│ orbit.sqlite3  │  │
  Last.fm ────────┼──▶│ lastfm-orbit  │           │ (local only)   │  │
  X/Twitter ──────┼──▶│ twitter-orbit │           └───────┬────────┘  │
  anything else ──┼──▶│ YOUR source   │ (REST, any lang)  │           │
  keyboard ───────┼──▶│ manual (UI)   │                   ▼           │
                  │   └───────────────┘         digest.js (§5)        │
                  │                                       │           │
                  │        renderer ◀── window.orbit ──────┘           │
                  │   (no network, no SQL, no fs)                      │
                  └───────────────────────────────────────────────────┘
        nothing leaves this box — the REST API accepts writes and returns
        no person data, by design (§0.6)
```

Two ingest paths, one schema:

- **In-process readers** (`src/main/plugins/*.js`) — for sources already on
  disk. The VRCX reader is one. They run in Orbit's main process on a timer and
  call `ingest.submit(batch)` directly.
- **External emitters** (`plugins/*`, or any program in any language) — for
  sources that live in another app (a Vencord userplugin) or need their own auth
  (Steam, Mastodon, Matrix, Last.fm, Twitter). They POST a batch to the
  **loopback REST API** (`127.0.0.1:{port}`, default 8477, bearer token in
  `~/.config/nx-orbit/ingest.token`). Bound to loopback only, no CORS,
  Host-header checked. Full surface: [`docs/REST_API.md`](docs/REST_API.md).

  The REST API is **write-only on purpose**: it accepts batches, exposes the
  schema so a source can self-validate, and offers a dry-run validator — but it
  has **no endpoint that returns person data**. Per §0.6 Orbit never exposes an
  API for a third party to query your friends, so sources push in and nothing
  reads out. That omission is a design decision, not a gap to fill later.

Both submit the **exact same batch envelope** (§3). The core does not care where
a batch came from; it validates every batch against the same schema and consent
rules regardless of path.

---

## 2. The record model (frozen — the vocabulary every plugin speaks)

Orbit knows about **people** and **observations about people**. That's it.

### 2.1 `Person` (identity, one row per platform identity)

```js
{
  // required. Open registry, closed at runtime: every source must be declared
  // by a plugin in ingest.js `PLUGIN_SOURCES`, so a plugin can only write the
  // source(s) it owns. Adding a source = adding a registry entry + a SPEC line.
  source:      "vrcx" | "discord" | "twitter" | "steam" | "contacts"
             | "mastodon" | "lastfm" | "matrix" | "manual" | "self",
  sourceId:    string,   // stable id WITHIN that source (vrc usr_…, discord snowflake) — required
  handle:      string,   // @name / login, may change
  displayName: string,   // shown name
  avatarUrl:   string?,  // platform CDN url, display-only; never re-hosted
  // Optional shared-by-them fields — omit if the person didn't publish them:
  birthday:    "MM-DD" | "YYYY-MM-DD" | null,  // NO year unless they stated it
  pronouns:    string?,
  bio:         string?,  // their own bio text, verbatim, as shown to you
  note:        string?,  // YOUR private note about them (manual/CRM), never inferred
  links:       [{ source, sourceId }]  // operator-asserted "same human across platforms"
}
```

`(source, sourceId)` is the primary key of a person. `links` lets *you* say
"this Discord user is the same human as this VRChat user"; Orbit never guesses
that automatically (§0.3).

**Identity clusters.** A link is an operator-asserted, **symmetric** edge between
two platform identities. Links are also **transitive**: if you link Steam↔Discord
and Discord↔VRChat, all three are one person, and the cluster is the transitive
closure over `person_link`. A person's card shows the whole cluster as one human
— their birthday/pronouns/note taken from whichever identity carries them, and
their timeline and per-person heatmap taken as the **union across every identity
in the cluster** (so linking a friend's Steam to their VRChat combines both
sources' presence into one "when are we both online").

**Suggestions are candidates, never conclusions.** Orbit may *offer* likely
same-human matches — other-source identities whose normalized handle or display
name is similar (lowercased, stripped of decoration) — but it presents them for
the operator to confirm one by one and **never links automatically**. String
similarity offered for a human decision is not inference *about* a person; a link
applied without that decision would be. The distinction is the charter (§0.3).
The `self` person is never a link candidate and cannot be linked.

**The reserved `self` person.** `(source:"self", sourceId:"me")` is *you* — the
operator. It exists because the overlap heatmap (§5) needs a "me" axis: your own
online history, so "hours we were both online" is computable. It is the one
person row that is not a friend, it is written only by a source that can observe
your own presence (the VRCX reader emits it from your gamelog), and it is never
rendered in the roster as a friend. **Any plugin may emit `self` records only
about the operator** — emitting a `self` person that is not the operator is a
charter violation (§0.6). Validation therefore allows `source:"self"` from any
plugin but requires `sourceId === "me"`.

It is a **presence anchor, not a display identity.** Because every source that
can see the operator emits it, honouring its cosmetic fields would make the
operator's own row flap between their Mastodon handle, their Last.fm name and
their Matrix ID depending on which timer fired last. So ingest accepts a `self`
person but writes only `(source, sourceId)`, dropping `handle`, `displayName`,
`avatarUrl`, `bio`, `note`, `birthday` and `pronouns`. Plugins may keep sending
them (it isn't an error); they are simply not stored. The operator names
themselves, if they want to, through the UI.

### 2.2 `Observation` (a timestamped thing they did that you could already see)

```js
{
  source:   string,       // required, matches a Person.source
  sourceId: string,       // required, the person it's about
  kind:     ObsKind,      // required, closed enum below
  ts:       number,       // required, epoch ms, when it happened (not when ingested)
  // kind-specific, all optional:
  status:   "online"|"active"|"idle"|"joinme"|"askme"|"busy"|"offline"?,  // presence/status kinds
  text:     string?,      // status_description / holiday note / status message, verbatim
  place:    string?,      // world name / server name / instance — as THEY published it
  meta:     object?       // small kind-specific bag; no free-form dumping ground
}
```

**`ObsKind` (closed enum — a plugin may not invent kinds):**

| kind | meaning | drives |
| --- | --- | --- |
| `presence` | online/offline transition | the overlap heatmap, "who's on now" |
| `status` | status ring / status text changed (incl. "on holiday 🏖") | status feed, holiday board |
| `location` | entered a world/server they broadcast to friends | "where they hang out" (counts only) |
| `bio` | their own bio text changed | change feed |
| `nick` | display name / handle changed | change feed |
| `avatar` | avatar image changed | change feed (thumbnail only) |
| `friend` | became / stopped being your friend | roster changes |

There is deliberately **no** `message`, `dm`, `keystroke`, `location_precise`,
`sentiment`, or `score` kind. Those would cross §0. The enum is the enforcement.

**Status values are cross-platform and must not be faked.** `idle` covers
Discord idle / "away"-style states; `busy` covers Discord DND and VRChat busy;
`joinme`/`askme` are VRChat-specific rings. A plugin that lacks a true equivalent
**omits `status`** rather than mapping to the nearest-looking slot — a friend
shown as "ask me" because their Discord went idle is wrong data, and wrong data
about people is exactly what this project exists not to produce.

### 2.3 What "on holiday" looks like (no AI, per your call)

A friend on holiday sets their VRChat status text or Discord custom status to
something like "🏖 away till the 20th". That arrives as an `Observation{kind:
"status", text: "🏖 away till the 20th"}`. Orbit **shows that text verbatim** on
their card and on a "Status board." It does **not** parse, classify, or infer
"this person is on holiday" — you read the words they wrote, exactly as you would
in the app. The holiday board is just "friends whose current status text is
non-empty," newest first. Zero analysis.

---

## 3. The batch envelope (frozen — the wire format for BOTH ingest paths)

```js
{
  plugin:  string,        // "vrcx" | "vencord-orbit-bridge" | "twitter-orbit" | "manual"
  version: string,        // plugin's own semver, for the audit log
  emittedAt: number,      // epoch ms
  persons:  Person[],     // upserts (may be empty)
  observations: Observation[]  // appended, deduped by (source,sourceId,kind,ts) (may be empty)
}
```

- A batch is **all-or-nothing**: if any record fails schema/consent validation,
  the whole batch is rejected with a per-record error list (nothing partially
  written). Plugins fix and resubmit.
- Dedup key for observations: `(source, sourceId, kind, ts, coalesce(text,place,status))`.
  Re-emitting the same history is safe and idempotent — plugins are encouraged to
  re-scan their whole source each run rather than track cursors.
- **Validation rejects, loudly, any batch that:** carries a `kind` outside the
  enum; carries a person whose `source` isn't declared by the plugin; contains
  a field not in this spec (no smuggling extra columns); has an observation
  about a person not present in the DB and not in this batch's `persons`.

---

## 4. Storage (`node:sqlite`, file at `~/.config/nx-orbit/orbit.sqlite3`)

```sql
CREATE TABLE person (
  source TEXT NOT NULL, source_id TEXT NOT NULL,
  handle TEXT, display_name TEXT, avatar_url TEXT,
  birthday TEXT, pronouns TEXT, bio TEXT, note TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (source, source_id)
);
CREATE TABLE person_link (            -- operator-asserted cross-platform identity
  a_source TEXT, a_id TEXT, b_source TEXT, b_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a_source, a_id, b_source, b_id)
);
CREATE TABLE observation (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL, source_id TEXT NOT NULL,
  kind TEXT NOT NULL, ts INTEGER NOT NULL,
  status TEXT, text TEXT, place TEXT, meta TEXT,   -- meta = JSON string
  dedup TEXT NOT NULL UNIQUE,                       -- the §3 dedup key
  FOREIGN KEY (source, source_id) REFERENCES person(source, source_id) ON DELETE CASCADE
);
CREATE INDEX obs_person_ts ON observation(source, source_id, ts);
CREATE INDEX obs_kind_ts   ON observation(kind, ts);
CREATE TABLE ingest_log (             -- audit: every batch, for transparency
  id INTEGER PRIMARY KEY, plugin TEXT, version TEXT,
  received_at INTEGER, n_persons INTEGER, n_obs INTEGER, rejected TEXT
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, settings
```

`ON DELETE CASCADE` is what makes §0.5 "delete this person" one statement.
`retentionDays` pruning is a periodic `DELETE FROM observation WHERE ts < …`.

---

## 5. Derivations (the read side — pure SQL/arithmetic, no inference)

Living in `src/main/digest.js`, exposed over IPC. Each is a documented query:

- **`whoIsOnNow()`** — latest `presence` per person; those whose latest is
  online. Count + list.
- **`overlapHeatmap(personId?)`** → `{grid: number[7][24], max, windowDays,
  metric, selfHours, friendsConsidered}`. If `personId` is omitted, aggregates
  across all friends = "when is my circle around." **This is a histogram of past
  overlap. It is labeled as such and predicts nothing.**

  **Presence observations are *events*, so this derivation works on intervals,
  never on event timestamps.** Bucketing the timestamps would mean a friend
  online 20:00–02:00 lit only the 20:00 cell, and the grid would silently be
  measuring "we happened to transition in the same weekday-hour" — coincidence,
  not shared time. Build intervals first:

  - `{online, active, joinme, askme, busy}` **opens**; `offline` **closes**;
    `idle` is neither (it doesn't start a session and doesn't end one).
  - Consecutive opens don't stack (earliest wins), unless the later open is
    beyond the session cap — that means a close was lost, so cut and restart.
  - A close with no open is **ignored**: inventing a start is inference (§0.3).
  - A dangling open ends at `min(now, open + MAX_SESSION_MS)`.
  - **`MAX_SESSION_MS` (12h) caps every interval, closed ones included.** Real
    data contains closed intervals of 200+ hours — a friend goes online, the
    client is off for a week, and the `offline` is recorded late. Honouring
    those blankets that friend's whole grid with overlap that never happened.
    The cap makes the rules self-consistent and errs toward under-counting:
    Orbit would rather miss a real hour than claim an unbacked one.
  - Expand an interval into buckets by walking **local** hour boundaries, not by
    adding 3600000ms — a 30-minute DST shift (Lord Howe) desynchronises the
    whole grid otherwise.

  **Cell metric** (returned as `metric`, so the UI can label it truthfully): for
  one friend, cell(weekday, hour) = the number of **distinct calendar dates** on
  which both you and that friend were online at some point in that local
  weekday-hour, within the retention window. Aggregate = that summed over
  friends ("friend-days of overlap in this hour").

  Your own presence is the reserved `(self, "me")` person (§2.1) — the VRCX
  reader derives it from your gamelog session durations. Implementations must
  read all presence rows in **one ordered scan** and group in memory; a
  per-friend query is O(friends) round trips and was ~17× slower.
- **`upcomingBirthdays(withinDays=30)`** — people with a `birthday`, sorted by
  next occurrence. The one feature that needs no event history.
- **`statusBoard()`** — each friend's latest `status` observation with non-empty
  `text`, newest first. This is the "who's on holiday / what's everyone up to"
  board — verbatim text, no parsing.
- **`changeFeed(sinceTs)`** — merged `bio`/`nick`/`avatar`/`friend`
  observations, reverse-chron. "What changed while I was away."
- **`personTimeline(personId)`** — one friend's observations, reverse-chron,
  **unioned across their linked identity cluster** (§2.1) so a person you've
  linked shows one merged history across Steam, Discord and VRChat.
- **`linkSuggestions(personId?)`** — for a person (or across the roster), other
  identities on *different* sources whose normalized handle/display name is
  similar, scored and reason-tagged, for the operator to confirm. Pure string
  comparison; it applies nothing.

Every derivation is a function whose entire body is a SQL query + shaping. If a
derivation ever needs a model, it doesn't belong in Orbit.

---

## 6. IPC surface (`window.orbit`, the only thing the renderer can touch)

```
orbit.digest.whoIsOnNow()            → { count, people[] }
orbit.digest.heatmap(personId?)      → { grid:number[7][24], max, windowDays }
orbit.digest.birthdays(withinDays?)  → [{ person, nextDate, daysAway }]
orbit.digest.statusBoard()           → [{ person, status, text, ts }]
orbit.digest.changeFeed(sinceTs?)    → [{ person, kind, ... , ts }]
orbit.people.list(filter?)           → Person[]
orbit.people.get(id)                 → { person, identities[], timeline }  // identities = the linked cluster (incl. self id)
orbit.people.setNote(id, text)       → ok        // your CRM note
orbit.people.link(idA, idB)          → ok        // assert same-human (symmetric, transitive)
orbit.people.unlink(idA, idB)        → ok        // remove one asserted edge
orbit.people.linkSuggestions(id?)    → [{ a, b, person, candidate, score, reason }]  // candidates to CONFIRM, never auto-applied
orbit.people.forget(id)              → ok        // §0.5 hard delete, cascades
orbit.sources.status()               → [{ plugin, lastRun, lastOk, nPersons, configurable, connected, account }]  // account/secret REDACTED
orbit.sources.runNow(plugin)         → triggers an in-process reader
orbit.sources.configure(plugin, cfg) → store a source's config/credentials (0600 file); { ok, connected }
orbit.sources.test(plugin, cfg)      → dry-run validate creds WITHOUT saving → { ok, account, friendCount } | { ok:false, reason }
orbit.sources.disconnect(plugin)     → forget a source's credentials (does not delete already-ingested people)
orbit.settings.get() / .set(patch)   → { retentionDays, ingestPort, sources{} }
```

No `eval`, no arbitrary SQL, no raw-file, no network from the renderer. The
preload whitelists exactly these channels.

---

## 7. Ownership map (for agents — own ONLY your bracket)

- `src/main/index.js` — bootstrap, window, scheduler, ingest HTTP server. **[core]**
- `src/main/db.js` — schema init, migrations, the only module that opens SQLite. **[core]**
- `src/main/ingest.js` — §3 validation + §0 consent enforcement + upsert/dedup. **[core]**
- `src/main/digest.js` — §5 derivations. **[core]**
- `src/main/ipc.js` + `src/main/preload.cjs` — §6 surface. **[core]**
- `src/main/plugins/vrcx.js` — in-process VRCX reader (§8). **[vrcx]**
- `src/main/plugins/steam.js` — in-process Steam reader, configured from the
  Sources UI (key + steamid in the 0600 credentials file); reuses the fetch/map
  logic the `steam-orbit` CLI also uses. The CLI stays for remote/headless use;
  the in-process reader is the easy path. **[steam]**
- `src/main/credentials.js` — the only reader/writer of the 0600 credentials
  file; secrets never touch `orbit.sqlite3` or the renderer. **[core]**
- `src/renderer/**` — UI: index.html, app.js, styles.css, tokens.css. **[ui]**
- `src/main/ingest-server.js` — the loopback REST API (§3, `docs/REST_API.md`). **[core]**
- `plugins/vencord-orbit-bridge/**` — Vencord userplugin emitter (TS). **[vencord]**
- `plugins/twitter-orbit/**`, `plugins/steam-orbit/**`,
  `plugins/contacts-orbit/**`, `plugins/mastodon-orbit/**`,
  `plugins/matrix-orbit/**`, `plugins/lastfm-orbit/**` — standalone Node CLI
  emitters, zero deps, one directory each. **[plugins]**
- `docs/**`, `README.md`, `scripts/**`, `test/**`. **[docs]/[core]**

Agents own only their bracket. No frameworks, no bundlers, no TypeScript in the
Electron app. Deps via `npm i` only if a Node built-in truly can't do it.

## 8. The VRCX reader (reference in-process plugin — proves the model)

Reads `~/.config/VRCX/VRCX.sqlite3` **read-only**. Derives the operator's user id
from a `configs` key matching `config:friendloginit_usr_<uuid>` → table prefix
`usr<hex>` (uuid dashes stripped). Then, per §2/§3, emits:

| Orbit record | from VRCX |
| --- | --- |
| `Person{source:"vrcx"}` | `…_friend_log_current` (user_id, display_name, trust_level→meta) |
| `Observation{presence}` | `…_feed_online_offline` (type Online/Offline→status, time→ts, world_name→place) |
| `Observation{status}` | `…_feed_status` (status, status_description→text) |
| `Observation{location}` | `…_feed_online_offline` rows with world_name (counts only) |
| `Observation{bio}` | `…_feed_bio` (bio, previous_bio) |
| `Person.note` | `…_notes` (note) — YOUR notes, already yours |
| your own presence | `gamelog_location` / `gamelog_join_leave` (self) for the heatmap's "me" axis |

Birthdays: VRChat's API doesn't expose friends' birthdays, so `birthday` for vrcx
persons stays null unless you add it via the manual/CRM path. That's correct —
Orbit won't invent a datum the platform never gave you.

The reader opens the DB read-only, wraps every query in try/catch (VRCX may hold
a write lock), and re-scans fully each run (idempotent per §3). It never writes to
VRCX's database.
