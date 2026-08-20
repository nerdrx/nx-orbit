# steam-orbit

A tiny standalone Node CLI (ES modules, **zero dependencies**) that feeds your
Steam half of [NX Orbit](../../SPEC.md).

It reads **your own friends list** and the **persona card Steam already shows
you** for each of those friends — name, avatar, online state, and the game they
are broadcasting — using the **official Steam Web API with your own API key**.
No scraping, no unofficial endpoints, no HTML parsing, no account that isn't
your friend.

This is the highest-value presence source Orbit has after VRChat: it is what
fills in the **overlap heatmap** (SPEC §5) — "hours we were both online."

## What it reads, and why each field is first-person-visible

| Steam Web API | Orbit record | why you already see it |
| --- | --- | --- |
| `ISteamUser/GetFriendList/v1` (`relationship=friend`) | the roster + `friend` observations | it is literally your own friends list |
| `personaname` | `Person.handle` / `Person.displayName` | the name Steam renders next to your friend |
| `avatarfull` | `Person.avatarUrl` (display-only, never re-hosted) | their avatar, as shown in your friends list |
| `personastate` | `Observation{presence}` (+ `status`) | the online/away/busy dot Steam shows friends |
| `gameextrainfo` | `Observation{location, place}` | the game they chose to broadcast to friends |
| `realname`, `timecreated` | **dropped** | SPEC §2.1 has no field for them, and `meta` is not a smuggling channel |

Friends whose profile is private come back **without** a `personastate`. They get
a `Person` row (you can still see their name and avatar) and **no presence
observation at all** — Orbit never guesses "offline" for a datum Steam didn't
give (SPEC §0.3).

Accounts with `relationship != "friend"` (pending requests, blocked) are filtered
out before anything else happens.

## The `personastate` → SPEC §2.2 mapping

Steam's state enum is not Orbit's, so the mapping is explicit and lossy **on
purpose**. SPEC §2.2: *"A plugin that lacks a true equivalent omits `status`
rather than mapping to the nearest-looking slot."*

| `personastate` | Steam meaning | `presence` | extra `status` obs |
| --- | --- | --- | --- |
| `0` | Offline | `offline` | — |
| `1` | Online | `online` | — |
| `2` | Busy | `online` | `busy` |
| `3` | Away | `online` | `idle` |
| `4` | Snooze | `online` | `idle` |
| `5` | Looking to trade | `online` | — (no Orbit equivalent) |
| `6` | Looking to play | `online` | — (no Orbit equivalent) |

`joinme` and `askme` are **VRChat rings**. Steam has nothing that means either,
so steam-orbit never emits them — a friend shown as "join me" because their
Steam said "looking to play" would be wrong data about a person, which is the
one thing this project exists not to produce.

## Steam gives a snapshot, not history

The Web API returns each friend's state **right now**. There is no history
endpoint, and Orbit will not invent one. So:

- `presence`, `status` and `location` observations are stamped `ts = Date.now()`.
- One run = one sample of your circle. **The heatmap fills in as you run it
  repeatedly.** Run it on a timer.
- `friend` observations are the exception: Steam gives you a real
  `friend_since`, so "you became friends" is stamped with the true timestamp.

Re-running is safe and cheap — the core dedups on
`(source, sourceId, kind, ts, …)` (SPEC §3).

### Run it on a timer

systemd user timer (every 15 minutes):

```ini
# ~/.config/systemd/user/steam-orbit.service
[Unit]
Description=NX Orbit — sample my Steam friends' presence

[Service]
Type=oneshot
Environment=STEAM_API_KEY=%h/…  # or use an EnvironmentFile, see below
ExecStart=/usr/bin/node %h/src/nx-orbit/plugins/steam-orbit/index.js --steamid 76561198…
```

```ini
# ~/.config/systemd/user/steam-orbit.timer
[Unit]
Description=Sample Steam presence every 15 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
```

Keep the key out of the unit file — put it in a mode-`600` env file instead:

```ini
# in [Service]
EnvironmentFile=%h/.config/nx-orbit/steam.env     # STEAM_API_KEY=…
```

```bash
systemctl --user enable --now steam-orbit.timer
```

cron equivalent:

```cron
*/15 * * * * STEAM_API_KEY=… /usr/bin/node ~/src/nx-orbit/plugins/steam-orbit/index.js --steamid 76561198… >/dev/null
```

A 15-minute cadence is ~96 calls/day per 100 friends — nowhere near Valve's
~100k/day budget, and enough resolution for an hourly heatmap.

## Get your key and your SteamID64

1. **API key** — <https://steamcommunity.com/dev/apikey>. It is yours; it is a
   secret; never paste it into a shared shell history or a unit file that is in
   version control.
2. **SteamID64** — the 17-digit number in your profile URL
   (`steamcommunity.com/profiles/7656119…`). A vanity URL name (`/id/nerdrx`) is
   **not** a SteamID64; the tool refuses it with a hint rather than guessing.
3. **Friends list privacy** — Steam only answers `GetFriendList` when *your own*
   "My Friends List" is **Public** (Steam → Profile → Edit Profile → Privacy
   Settings). This is a setting on *your* account about *your* list; it does not
   change anything about your friends' privacy.

## Usage

```bash
# Dry run against the bundled fixture — no network, no POST, prints the batch:
node index.js --dry-run --from-fixture fixture.sample.json

# Dry run against the real API — see exactly what would be ingested:
node index.js --dry-run --key "$STEAM_API_KEY" --steamid 76561198000000001

# Real run — POST to Orbit on the default port 8477:
node index.js --key "$STEAM_API_KEY" --steamid 76561198000000001

# Key from the environment, explicit port and token:
STEAM_API_KEY=… node index.js --steamid 7656119… --port 8477 --token nxo_live_…
```

Flags:

| flag | meaning |
| --- | --- |
| `--key <KEY>` | your own Steam Web API key (falls back to `$STEAM_API_KEY`) |
| `--steamid <ID>` | your own 17-digit SteamID64 (falls back to `$STEAM_ID`) |
| `--from-fixture <file>` | read saved API JSON from a file instead of calling Steam |
| `--dry-run` | print the batch to stdout instead of POSTing; snapshot untouched |
| `--port N` | loopback ingest port (default `8477`) |
| `--token TOKEN` | ingest bearer token (see resolution order below) |
| `-h`, `--help` | usage |

`GetPlayerSummaries` is called in batches of **100 steamids**, Valve's documented
per-call limit, so a 400-friend account costs 5 HTTP requests per run.

## Configure the token

Resolution order (first hit wins):

1. `--token <TOKEN>` flag
2. `NX_ORBIT_TOKEN` environment variable
3. `~/.config/nx-orbit/ingest.token`

Copy the token from **NX Orbit → Settings → Sources**. Rotating it there
invalidates the old one.

## Change detection (idempotent)

A snapshot is stored at `~/.config/nx-orbit/steam-orbit.snapshot.json` (name +
avatar + `friend_since` per friend). It only advances on an accepted (`200`)
batch, and `--dry-run` **neither reads nor writes it** — a dry run always shows
the full first-run baseline, so it is repeatable and safe to paste into a bug
report.

| change | emitted |
| --- | --- |
| new friend | `friend` obs, `meta.state = "added"`, `ts` = Steam's `friend_since` |
| friend gone from your list | `friend` obs, `meta.state = "removed"` (their `Person` is re-emitted so the observation has a row to hang off — SPEC §3) |
| persona name changed | `nick` obs with `meta.previous` |
| avatar changed | `avatar` obs |
| presence / game | re-sampled **every** run — that is the heatmap feed |

## The batch it POSTs

```
POST http://127.0.0.1:8477/ingest
Authorization: Bearer <your Orbit ingest token>
Content-Type: application/json
```

Example body, trimmed from `--dry-run --from-fixture fixture.sample.json` (a
first run: every friend is new, so each gets a `friend` observation):

```json
{
  "plugin": "steam-orbit",
  "version": "1.0.0",
  "emittedAt": 1787245667254,
  "persons": [
    { "source": "self", "sourceId": "me", "handle": "you", "displayName": "(you)" },
    { "source": "steam", "sourceId": "76561198000000011", "handle": "online_otter", "displayName": "online_otter", "avatarUrl": "https://avatars.steamstatic.com/…0011_full.jpg" },
    { "source": "steam", "sourceId": "76561198000000012", "handle": "busy_badger", "displayName": "busy_badger", "avatarUrl": "https://avatars.steamstatic.com/…0012_full.jpg" },
    { "source": "steam", "sourceId": "76561198000000013", "handle": "away_axolotl", "displayName": "away_axolotl", "avatarUrl": "https://avatars.steamstatic.com/…0013_full.jpg" }
  ],
  "observations": [
    { "source": "self",  "sourceId": "me",                "kind": "presence", "status": "online", "ts": 1787245667254 },
    { "source": "self",  "sourceId": "me",                "kind": "location", "place": "Half-Life: Alyx", "ts": 1787245667254 },
    { "source": "steam", "sourceId": "76561198000000011", "kind": "presence", "status": "online", "ts": 1787245667254 },
    { "source": "steam", "sourceId": "76561198000000011", "kind": "location", "place": "Deep Rock Galactic", "ts": 1787245667254 },
    { "source": "steam", "sourceId": "76561198000000011", "kind": "friend",   "ts": 1530000000000, "meta": { "state": "added" } },
    { "source": "steam", "sourceId": "76561198000000012", "kind": "presence", "status": "online", "ts": 1787245667254 },
    { "source": "steam", "sourceId": "76561198000000012", "kind": "status",   "status": "busy",   "ts": 1787245667254 },
    { "source": "steam", "sourceId": "76561198000000013", "kind": "presence", "status": "online", "ts": 1787245667254 },
    { "source": "steam", "sourceId": "76561198000000013", "kind": "status",   "status": "idle",   "ts": 1787245667254 }
  ]
}
```

### The `self` person

Your own steamid is included in the `GetPlayerSummaries` call, and your own
presence is emitted as the reserved person `{"source":"self","sourceId":"me"}`
(SPEC §2.1) — the "me" axis the overlap heatmap needs. You are never written as
a `steam` friend row, and `sourceId` is always exactly `"me"`.

## Testing offline

`fixture.sample.json` holds saved `GetFriendList` + `GetPlayerSummaries`
responses covering every `personastate` 0–6, one friend in-game, one private
profile, one pending friend request (which must be ignored), and `realname` /
`timecreated` fields (which must be dropped):

```bash
node index.js --dry-run --from-fixture fixture.sample.json
node --test ../../test/steam-orbit.test.js
```

The test suite validates the emitted batch against a transcription of SPEC §3
*and* against the real `src/main/ingest.js` validator.

## Troubleshooting

| symptom | cause |
| --- | --- |
| `403 … GetFriendList` | your own "My Friends List" privacy is not Public, or the key is wrong |
| `401` from Steam | bad/expired API key |
| `429` from Steam | rate-limited; lower your timer cadence |
| `--steamid must be your own 17-digit SteamID64` | you passed a vanity URL name |
| `connection refused at 127.0.0.1:8477` | NX Orbit isn't running |
| `401 unauthorized` from Orbit | ingest token wrong or rotated in Settings → Sources |
| `422` from Orbit | schema/consent rejection — the response lists the offending records |

## License

MIT © 2026 nerdrx.
