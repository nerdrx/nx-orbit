# Writing a Vencord plugin that feeds NX Orbit

This is the Discord-specific companion to
[`PLUGIN_GUIDELINES.md`](PLUGIN_GUIDELINES.md). It walks through everything a
Vencord userplugin needs to become an Orbit **source** — the stores it reads,
the events it listens to, how Discord state maps onto Orbit's record model, and
how it delivers batches. The shipped
[`vencord-orbit-bridge`](../plugins/vencord-orbit-bridge/) is the worked
reference; this doc explains *why* it's shaped the way it is so you can write
your own or extend it.

If you read one thing: a Vencord Orbit source may only emit what your own Discord
client already shows you about your own friends — their friend entry, the
presence and custom status they broadcast, name/avatar changes. Never a message,
never a non-friend, never a guess. That constraint is the whole reason Orbit
exists instead of the thing it refuses to be.

---

## 1. The shape of it

A Vencord Orbit source is an **external emitter** (PLUGIN_GUIDELINES §B): it runs
inside Discord, watches the friends you can already see, and **POSTs batches** to
Orbit's loopback REST API. It never touches Orbit's database or process directly.

```
Discord (your client)                      NX Orbit (your machine)
┌───────────────────────────┐             ┌──────────────────────┐
│ RelationshipStore (friends)│            │  POST /api/v1/ingest │
│ PresenceStore  (status)    │  batch ────▶│  127.0.0.1:8477      │
│ UserStore      (name/av)   │  (JSON)     │  Bearer <token>      │
│ FluxDispatcher (events) ───┘             │  validates + writes  │
└───────────────────────────┘             └──────────────────────┘
        you, logged in                     nothing leaves the box
```

Discord runs a strict CSP, but a plain `fetch` to `http://127.0.0.1:8477` works
on Vesktop and most desktop builds. If a build blocks it, the plugin degrades
gracefully (keeps its queue, logs, retries) — it must never throw into Discord.

---

## 2. The five rules, in Discord terms

The general rules (PLUGIN_GUIDELINES) map onto specific Discord APIs. Getting
these right is the difference between a source and a spyware plugin.

| Rule | In Discord | The concrete API discipline |
| --- | --- | --- |
| **Friends-only** | Only accounts where `RelationshipStore.getRelationshipType(id) === FRIEND (1)` | Enumerate `getFriendIDs()`, filter to FRIEND. Re-check `isFriend(id)` on *every* touch — a `PRESENCE_UPDATE` fires for guild members and blocked users too. |
| **Surface-only** | Only what the client already renders | `PresenceStore` (status, activities), `UserStore` (username, global name, avatar). **Never** a `MessageStore`, channel, DM, typing event, or read state. |
| **Observations, not conclusions** | Report the ring/status they set | No "seems active a lot", no online-time prediction, no scoring. The `kind` enum has no room for it — don't route inference through `meta`. |
| **Local delivery** | POST to `127.0.0.1` only | No remote host, ever. The token authorizes *your* Orbit, nothing else. |
| **Verbatim + attributed** | Pass custom-status text exactly | Emoji included, unedited. Every record carries `plugin` + real `ts`. |

The tell (charter §0.4): if a friend saw the records your plugin emitted about
them, they should feel *waved at*, not *watched*. A presence blip and "🏖 on
holiday" pass. Anything derived from their messages does not.

---

## 3. The Vencord scaffolding

Standard `definePlugin`. Settings hold the Orbit connection; the lifecycle
subscribes to Flux events and runs a flush timer.

```ts
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, PresenceStore, RelationshipStore, UserStore } from "@webpack/common";

const settings = definePluginSettings({
    enabled:         { type: OptionType.BOOLEAN, default: true,  description: "Send to NX Orbit" },
    ingestPort:      { type: OptionType.NUMBER,  default: 8477,  description: "Orbit loopback port" },
    ingestToken:     { type: OptionType.STRING,  default: "",    description: "Token from Orbit → Sources" },
    flushIntervalSec:{ type: OptionType.NUMBER,  default: 30,    description: "How often to POST (min 5s)" },
});

export default definePlugin({
    name: "OrbitBridge",
    description: "Feeds your Discord friends' presence to NX Orbit (local only).",
    authors: [{ name: "you", id: 0n }],
    settings,
    start() {
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdate);
        FluxDispatcher.subscribe("PRESENCE_UPDATE",  onPresenceUpdate);
        FluxDispatcher.subscribe("RELATIONSHIP_ADD",    onRelationshipAdd);
        FluxDispatcher.subscribe("RELATIONSHIP_REMOVE", onRelationshipRemove);
        this._timer = setInterval(flush, Math.max(5, settings.store.flushIntervalSec) * 1000);
        void flush(); // best-effort initial push
    },
    stop() {
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresenceUpdate);
        FluxDispatcher.unsubscribe("PRESENCE_UPDATE",  onPresenceUpdate);
        FluxDispatcher.unsubscribe("RELATIONSHIP_ADD",    onRelationshipAdd);
        FluxDispatcher.unsubscribe("RELATIONSHIP_REMOVE", onRelationshipRemove);
        clearInterval(this._timer);
    },
});
```

**Stores you use, and only these:**

- `RelationshipStore` — `getFriendIDs()`, `getRelationshipType(id)`. Your friend
  list. `FRIEND` is relationship type `1`; ignore `2` (blocked), `3`/`4`
  (incoming/outgoing pending).
- `PresenceStore` — `getStatus(id)` (`"online" | "idle" | "dnd" | "offline"`),
  `getActivities(id)` (the custom-status activity lives here).
- `UserStore` — `getUser(id)` → `username`, `globalName`, `avatar`,
  `getAvatarURL(guildId, size)`.
- `FluxDispatcher` — subscribe to the events below.

**Events worth subscribing to:** `PRESENCE_UPDATE`/`PRESENCE_UPDATES` (a friend's
status or custom status changed), `RELATIONSHIP_ADD`/`RELATIONSHIP_REMOVE` (you
gained/lost a friend). Every handler must re-assert `isFriend(id)` before doing
anything — presence events arrive for people who are not your friends.

---

## 4. Mapping Discord → Orbit records

Orbit's vocabulary is people (`Person`) and timestamped observations
(`Observation`), with a **closed** `kind` enum: `presence, status, location, bio,
nick, avatar, friend`. Discord fills a subset:

### Person

```ts
{
  source: "discord",
  sourceId: userId,              // the snowflake — stable, never the username
  handle: user.username,
  displayName: user.globalName || user.username,
  avatarUrl: user.getAvatarURL(undefined, 128),
}
```

### Observations

| Discord state | Orbit observation | Notes |
| --- | --- | --- |
| status is not offline | `{ kind:"presence", status:"online" }` | idle/dnd still count as *online presence* |
| status is offline | `{ kind:"presence", status:"offline" }` | |
| status is `idle` | `{ kind:"status", status:"idle" }` | a true equivalent |
| status is `dnd` | `{ kind:"status", status:"busy" }` | dnd ≈ busy |
| custom status set | `{ kind:"status", text:"🏖 back on the 20th" }` | **verbatim**, emoji + state joined; the "on holiday" surface |
| global/display name changed | `{ kind:"nick", text:newName, meta:{previous} }` | change-only |
| avatar changed | `{ kind:"avatar" }` | change-only, no image re-hosted |
| friend added / removed | `{ kind:"friend", meta:{state:"added"\|"removed"} }` | from RELATIONSHIP events |

**The status-enum trap.** Orbit's status enum is cross-platform:
`online, active, idle, joinme, askme, busy, offline`. `joinme` and `askme` are
**VRChat rings** — they mean nothing on Discord, so a Discord source must **never
emit them**. Where Discord has no true equivalent for a state, omit `status`
rather than mapping to the nearest-looking slot (SPEC §2.2). Mapping idle to
"ask me" would put wrong words on a friend's card, which is exactly the failure
mode Orbit exists to avoid.

Extract the custom status from activities, not from a status field:

```ts
const act = PresenceStore.getActivities(id)?.find(a => a.type === 4 /* CUSTOM */);
const text = act ? `${act.emoji?.name ? act.emoji.name + " " : ""}${act.state ?? ""}`.trim() : "";
```

### Baseline vs change (so you don't spam a false history)

On **first sight** of a friend (seeding), emit their *current* presence and
custom status — that's useful state. But do **not** emit `nick`/`avatar` as
changes on first sight; you have nothing to diff against, so a baseline would
invent a "changed name" event. Keep a per-friend snapshot
(`{status, custom, name, avatar}`) and only emit `nick`/`avatar` when it actually
differs from the snapshot.

---

## 5. Delivering the batch

Queue observations as they happen, flush on a timer. The envelope is SPEC §3:

```ts
const batch = {
    plugin: "vencord-orbit-bridge",   // must match a key in Orbit's PLUGIN_SOURCES
    version: "1.0.0",
    emittedAt: Date.now(),
    persons,        // every friend an observation references must be here or already in Orbit
    observations,   // the queued events
};

const res = await fetch(`http://127.0.0.1:${port}/api/v1/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(batch),
});
```

Handle the responses without ever throwing into Discord:

| Response | Meaning | What to do |
| --- | --- | --- |
| `200 {accepted}` | written (dedup may drop repeats) | clear the queue |
| `422 {rejected:[…]}` | a record broke the schema/consent rules | log the `{index,field,reason}`, **drop** the batch (don't loop), fix the mapping |
| `401` | bad/rotated token | keep the queue, warn the user to paste the current token |
| connection refused / CSP | Orbit down or `fetch` blocked | keep the queue, retry next flush |

**Idempotency (SPEC §3):** Orbit dedups on `(source, sourceId, kind, ts, …)`, so
re-sending the same observation is free. Prefer re-emitting current state over
tracking fragile cursors. Only advance your snapshot after a `200` — otherwise a
transient failure could make you skip a real change.

**Every referenced person must ride along.** If you enqueue an observation about
a friend, make sure that friend's `Person` is in `persons` (or already in Orbit),
or the whole batch is rejected. The reference bridge does this by adding the id
to a `dirtyPersons` set whenever it enqueues an observation about them.

---

## 6. What you must never do

- Read message content, DMs, typing, read states, or anything from a channel.
  There is no `kind` for it and no reason to touch `MessageStore`.
- Emit anything about a non-friend — guild members, blocked users, pending
  requests, or a random id from a `PRESENCE_UPDATE`. Re-check `isFriend` every
  time.
- Emit `joinme`/`askme`, or any inferred/scored/predicted value.
- POST anywhere but `127.0.0.1`. The token is not a passport to a cloud.
- Throw into Discord. Wrap store reads in try/catch; a failed flush retries.

---

## 7. Install & configure

The plugin lives alongside the other NX Vencord plugins and builds with them.

```bash
# from your vencord-nx-plugins checkout
cp -r /path/to/nx-orbit/plugins/vencord-orbit-bridge userplugins/orbitBridge
./install.sh          # builds Vencord + plugins into your live dist
# fully restart Discord / Vesktop (Ctrl+R is not always enough for a new plugin)
```

Then wire the token:

1. In **NX Orbit → Sources**, copy the loopback ingest token (from
   `~/.config/nx-orbit/ingest.token`).
2. In Discord: **Settings → Plugins → OrbitBridge**, paste it into **Ingest
   token**, confirm the port (default `8477`), enable.
3. Within a flush interval, your Discord friends appear in Orbit's roster and
   "Who's around."

Confirm end to end without leaving Discord: `GET http://127.0.0.1:8477/api/v1/health`
should return `{"ok":true}`, and Orbit → Sources will show `vencord-orbit-bridge`
with a recent run and a person count.

---

## 8. Minimal skeleton

Everything above, in the smallest plugin that is still correct:

```ts
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, PresenceStore, RelationshipStore, UserStore } from "@webpack/common";

const SOURCE = "discord";
const FRIEND = 1, CUSTOM = 4;
const OFFLINE = new Set(["offline", "invisible", "unknown"]);
const settings = definePluginSettings({
    enabled:      { type: OptionType.BOOLEAN, default: true,  description: "Send to NX Orbit" },
    ingestPort:   { type: OptionType.NUMBER,  default: 8477,  description: "Orbit port" },
    ingestToken:  { type: OptionType.STRING,  default: "",    description: "Token from Orbit → Sources" },
});

const isFriend = (id: string) => RelationshipStore.getRelationshipType(id) === FRIEND;
const queue: any[] = [];
const persons = new Map<string, any>();

function ringOf(status: string) {                    // NEVER joinme/askme on Discord
    if (status === "dnd") return "busy";
    if (status === "idle") return "idle";
    return undefined;                                 // online/offline live on the presence kind
}
function customOf(id: string) {
    const a = PresenceStore.getActivities(id)?.find((x: any) => x.type === CUSTOM);
    return a ? `${a.emoji?.name ? a.emoji.name + " " : ""}${a.state ?? ""}`.trim() : "";
}
function seePerson(id: string) {
    const u: any = UserStore.getUser(id); if (!u) return;
    persons.set(id, { source: SOURCE, sourceId: id, handle: u.username,
        displayName: u.globalName || u.username, avatarUrl: u.getAvatarURL?.(undefined, 128) });
}
function sync(id: string) {
    if (!isFriend(id)) return;
    seePerson(id);
    const st = PresenceStore.getStatus(id) ?? "offline", now = Date.now();
    queue.push({ source: SOURCE, sourceId: id, kind: "presence",
        status: OFFLINE.has(st) ? "offline" : "online", ts: now });
    const ring = ringOf(st); if (ring) queue.push({ source: SOURCE, sourceId: id, kind: "status", status: ring, ts: now });
    const c = customOf(id); if (c) queue.push({ source: SOURCE, sourceId: id, kind: "status", text: c, ts: now });
}
async function flush() {
    if (!settings.store.enabled || !queue.length) return;
    const token = settings.store.ingestToken?.trim(); if (!token) return;
    const batch = { plugin: "vencord-orbit-bridge", version: "1.0.0", emittedAt: Date.now(),
        persons: [...persons.values()], observations: queue.slice() };
    try {
        const r = await fetch(`http://127.0.0.1:${settings.store.ingestPort}/api/v1/ingest`,
            { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify(batch) });
        if (r.ok) { queue.length = 0; }          // clear only on success; dedup makes re-sends safe
    } catch { /* Orbit down / CSP — keep queue, retry next flush */ }
}
const onPresence = (e: any) => { const id = e?.user?.id ?? e?.userId; if (id && isFriend(id)) sync(id); };

export default definePlugin({
    name: "OrbitBridgeMini", description: "Minimal NX Orbit source.", authors: [{ name: "you", id: 0n }], settings,
    start() {
        (RelationshipStore.getFriendIDs() ?? []).forEach(sync);   // seed
        FluxDispatcher.subscribe("PRESENCE_UPDATE", onPresence);
        this._t = setInterval(flush, 30_000); void flush();
    },
    stop() { FluxDispatcher.unsubscribe("PRESENCE_UPDATE", onPresence); clearInterval(this._t); },
});
```

That's a complete, charter-respecting Orbit source in ~60 lines. The shipped
[`vencord-orbit-bridge`](../plugins/vencord-orbit-bridge/index.ts) adds
change-detection snapshots, nick/avatar diffing, friend add/remove events,
richer settings, and careful error handling — read it next.
