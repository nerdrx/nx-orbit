# vencord-orbit-bridge

A [Vencord](https://vencord.dev) userplugin (**OrbitBridge**) that feeds your
Discord half of [NX Orbit](../../SPEC.md) — the local-first "keep up with the
friends you already have" dashboard.

It emits **only** what your own logged-in Discord client already shows you about
your **own friends**, and POSTs it to Orbit's loopback ingest endpoint. Nothing
leaves your machine.

## What it reads

- **Your friends list** — `RelationshipStore.getFriendIDs()`, filtered to
  `RelationshipType === FRIEND`. For each friend it emits a `Person`
  (`source:"discord"`, snowflake id, username, global display name, CDN avatar).
- **The presence those friends broadcast to you** — `PresenceStore.getStatus`.
  Collapsed to an `online`/`offline` `presence` observation (idle/dnd count as
  online). For a friend on **idle** or **dnd** it additionally emits a `status`
  observation (`idle → idle`, `dnd → busy` — true equivalents). It never emits
  VRChat's `joinme`/`askme` rings, which have no Discord meaning: per SPEC §2.2 a
  plugin omits `status` rather than faking the nearest-looking slot.
- **Custom status text** — the "🏖 back on the 20th" surface — verbatim, emoji
  included, as a `status` observation with `text`. This is what drives Orbit's
  holiday/status board.
- **Display-name and avatar changes** — `nick` / `avatar` observations, emitted
  only on a real change (never as a false "change" the first time it sees you).
- **Friend added/removed** — a `friend` observation on relationship changes.

## What it explicitly does NOT read

- ❌ **Message content / DMs** — never touched. There is no `message` kind in
  Orbit's schema and this plugin never reads a channel.
- ❌ **Servers / guild members** — it only enumerates your friends list.
- ❌ **Non-friends** — blocked users, pending requests, strangers, people you
  merely share a server with. Every read is guarded by an `isFriend()` check.
- ❌ **Anything hidden or inferred** — no scores, no "sleep schedule", no
  guesses. Just timestamped events you could already see in the app.

A friend reading every record this plugin emitted about them would see: "you
were online, you set your status to '🏖 back on the 20th', you renamed to X."
Waved at, not watched.

## Install

Drop it into your NX Vencord plugins checkout and rebuild:

```bash
# from your vencord-nx-plugins checkout
mkdir -p userplugins/orbitBridge
cp /path/to/nx-orbit/plugins/vencord-orbit-bridge/index.ts userplugins/orbitBridge/index.ts
./install.sh          # builds Vencord + plugins, deploys to ~/.config/Vencord/dist
# fully restart Discord (or Ctrl+R)
```

Then enable **OrbitBridge** under Vencord → Plugins.

> Note: Discord's renderer CSP can block plain `fetch` to `127.0.0.1` on some
> builds. Vesktop and most Vencord setups allow it; if POSTs are blocked, run
> Orbit and check its ingest log — the plugin logs failures to the console and
> never crashes Discord.

## Configure the token

1. In **NX Orbit → Settings → Sources**, copy the ingest token.
2. In **Vencord → Plugins → OrbitBridge**, paste it into **ingestToken**.
3. Leave **ingestPort** at `8477` unless you changed it in Orbit.
4. **flushIntervalSec** (default 30) controls how often batches are POSTed.

Rotating the token in Orbit invalidates the old one — repaste it here.

## The batch it POSTs

```
POST http://127.0.0.1:8477/ingest
Authorization: Bearer <your Orbit ingest token>
Content-Type: application/json
```

Example body (a friend who just came online, is on DND, set a holiday status,
and renamed):

```json
{
  "plugin": "vencord-orbit-bridge",
  "version": "1.0.0",
  "emittedAt": 1690000000000,
  "persons": [
    {
      "source": "discord",
      "sourceId": "228534106599948289",
      "handle": "friend",
      "displayName": "NewName",
      "avatarUrl": "https://cdn.discordapp.com/avatars/228534106599948289/abc.png"
    }
  ],
  "observations": [
    { "source": "discord", "sourceId": "228534106599948289", "kind": "presence", "status": "online", "ts": 1690000000000 },
    { "source": "discord", "sourceId": "228534106599948289", "kind": "status", "status": "busy", "ts": 1690000000000 },
    { "source": "discord", "sourceId": "228534106599948289", "kind": "status", "text": "🏖 back on the 20th", "ts": 1690000000000 },
    { "source": "discord", "sourceId": "228534106599948289", "kind": "nick", "text": "NewName", "meta": { "previous": "Friend" }, "ts": 1690000000000 }
  ]
}
```

The exact `curl` equivalent:

```bash
curl -sS -X POST http://127.0.0.1:8477/ingest \
  -H "Authorization: Bearer $NX_ORBIT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plugin":"vencord-orbit-bridge","version":"1.0.0","emittedAt":1690000000000,"persons":[{"source":"discord","sourceId":"228534106599948289","handle":"friend","displayName":"NewName","avatarUrl":"https://cdn.discordapp.com/avatars/228534106599948289/abc.png"}],"observations":[{"source":"discord","sourceId":"228534106599948289","kind":"presence","status":"online","ts":1690000000000},{"source":"discord","sourceId":"228534106599948289","kind":"status","status":"busy","ts":1690000000000},{"source":"discord","sourceId":"228534106599948289","kind":"status","text":"🏖 back on the 20th","ts":1690000000000},{"source":"discord","sourceId":"228534106599948289","kind":"nick","text":"NewName","meta":{"previous":"Friend"},"ts":1690000000000}]}'
```

## License

GPL-3.0-or-later (matches its Vencord host).
