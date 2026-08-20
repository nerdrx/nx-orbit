<div align="center">

# NX Orbit

**Keep up with the friends you already have — not a tool for watching people who didn't ask to be watched.**

Birthdays · a "who's around when I'm around" heatmap · holiday & status notes · a
gentle what-changed feed — assembled **only** from what your own accounts already
show you, kept **only** on your machine.

*Part of the NX suite · Electron · local-first · no cloud, no telemetry, no AI-over-people*

</div>

---

## Why this exists (and what it deliberately isn't)

There's a genre of software that scrapes everyone it can reach, fuses it into
dossiers, and calls it intelligence. NX Orbit is the **opposite of that, on
purpose.** It only ever ingests the things you can *already see as a normal,
logged-in friend* — your VRChat friends' online/offline blips, the custom status
a pal set to "🏖 on holiday", a birthday someone told you — and it keeps every
byte on your own disk.

The design is built around a hard charter (see [`SPEC.md §0`](SPEC.md)):

- **First-person only.** If getting a datum needed more than "I'm this person's
  friend, logged in as me," it isn't in Orbit. No strangers, no firehose, no
  bought data.
- **Local only.** No server, no sync, no telemetry. The one and only subject is
  *you*; there is no profile to upload because there is no profile.
- **No AI about people.** Orbit does arithmetic on timestamps you already have.
  It never predicts, scores, ranks, or infers anything a person didn't state.
- **Subject-first.** The test for every feature: if a friend saw their own Orbit
  card, would they feel *waved at* or *creeped out*? Only the first ships.
- **Forgetting is a feature.** Rolling retention, and one-click "forget this
  person" that hard-deletes every row about them.

## What it shows you

| View | What it is | Source |
| --- | --- | --- |
| **Who's around now** | Friends currently online, across all your sources | presence they broadcast to friends |
| **Overlap heatmap** | A 7×24 histogram of *past* hours where you and a friend were both online — "when do our times line up" | your + their online/offline history |
| **Birthdays** | Upcoming birthdays, soonest first | birthdays friends chose to share, or you noted |
| **Status board** | Everyone's current status text, verbatim ("on holiday", "sleeping", "grinding") | the status they set |
| **What changed** | Name / bio / avatar changes since you last looked | what the app already showed you |
| **Person card** | One friend: your notes, their shared birthday, their timeline | all of the above, per person |

The heatmap is explicitly a **histogram of the past**, labeled as such. It tells
you "our evenings tend to overlap on weekends," the way glancing at a friends
list would — it does **not** predict, alert, or track anyone in real time.

## Sources (plugins)

Orbit is a small core plus **source plugins**, each turning one place you already
have an account into records. Every plugin obeys the same
[contract and consent rules](docs/PLUGIN_GUIDELINES.md).

| Plugin | Reads | How |
| --- | --- | --- |
| **vrcx** | Your VRCX SQLite: your friends, their online/offline & status history, your own notes | in-process, read-only |
| **vencord-orbit-bridge** | Your Discord friends list + the presence/custom-status they show you | Vencord userplugin → REST |
| **steam-orbit** | Your Steam friends, their persona state and the game they're publicly showing | your own API key → REST |
| **contacts-orbit** | **Birthdays** from your own address book (`.vcf` / `.ics` you export) | local file parse → REST |
| **mastodon-orbit** | Accounts *you follow* on your instance: bio, display name, published pronouns/birthday fields | your own token → REST |
| **matrix-orbit** | People you share a **direct message** with: presence + status message | your own token → REST |
| **lastfm-orbit** | Your Last.fm friends and what they're publicly playing right now | your own API key → REST |
| **twitter-orbit** | Accounts *you follow*, from your own data export or token | Node CLI → REST |
| **manual** | People and notes you type in yourself (a plain personal CRM) | the UI |

Note what each source honestly *can't* give you, because Orbit refuses to invent
it: Mastodon and Last.fm have no presence, so they contribute none. VRChat and
Discord don't expose friends' birthdays — which is exactly why `contacts-orbit`
exists, reading the birthdays already sitting in your own address book.

Want to add one? [`docs/PLUGIN_GUIDELINES.md`](docs/PLUGIN_GUIDELINES.md) is the
whole contract. The five rules, short version: friends-only, surface-only,
observations-not-conclusions, local-delivery, verbatim-and-attributed.

### Write a source in any language

Sources don't have to be JavaScript, or live in this repo. Orbit exposes a small
**loopback REST API** — see [`docs/REST_API.md`](docs/REST_API.md) — so a source
can be a Python script, a Go binary, or ten lines of `curl`:

```bash
curl -X POST http://127.0.0.1:8477/api/v1/ingest \
  -H "Authorization: Bearer $(cat ~/.config/nx-orbit/ingest.token)" \
  -H 'Content-Type: application/json' \
  -d '{"plugin":"my-source","version":"1.0.0","emittedAt":1787000000000,
       "persons":[{"source":"manual","sourceId":"a1","displayName":"A Friend"}],
       "observations":[{"source":"manual","sourceId":"a1","kind":"status",
                        "text":"🏖 on holiday","ts":1787000000000}]}'
```

`GET /api/v1/schema` hands you the enums and field allow-lists so you can
validate before you send, and `POST /api/v1/validate` dry-runs a batch without
writing. The API is **write-only by design**: sources push in, and nothing can
query your friends back out (charter §0.6). It binds to loopback, requires a
bearer token, and refuses cross-origin browser access.

## Architecture

```
your accounts ──▶ source plugins ──▶ loopback ingest ──▶ orbit.sqlite3 (local) ──▶ dashboard
                (see only friends)   (validates schema    (cascade-delete       (arithmetic,
                                      + consent rules)      per person)           not inference)
```

- **Electron 40**, ES modules, no framework, no bundler, no TypeScript in the
  app. The built-in `node:sqlite` for storage — **zero native dependencies**.
  Matches the NX design language — liquid glass on deep space.
- One frozen contract: [`SPEC.md`](SPEC.md). Two ingest paths (in-process reader,
  loopback POST), one record schema.

## Status

Working end to end. The Electron app boots, the loopback REST API accepts
batches, and the reference VRCX reader has been validated against a real 5.8 MB
VRCX database (411 friends, ~6,000 observations ingested). The frozen contract is
[`SPEC.md`](SPEC.md); see §7 for the module ownership map.

Not yet done: packaged releases (AppImage / Windows portable), and NX Hub
registry integration.

## Running (dev)

```bash
npm install
npm start
```

Requires Node 22+ (Electron 40 is installed by `npm install`; it ships Node 24,
which provides the built-in `node:sqlite` — Electron 31 does not). On first run
Orbit creates `~/.config/nx-orbit/` with the database and the loopback ingest
token.

## License

MIT © 2026 nerdrx. Part of the NX suite — installable via NX Hub.
