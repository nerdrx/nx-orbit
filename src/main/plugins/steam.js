// NX Orbit — Steam in-process source reader.
//
// The easy, no-terminal path for Steam: the operator pastes their Steam Web API
// key and their profile link into the Sources UI, and Orbit reads their own
// friends list on the scheduler, exactly like the VRCX reader. The standalone
// `plugins/steam-orbit` CLI stays for remote/headless use; this reader is the
// in-app one.
//
// It reuses the SAME fetch + map logic the CLI uses (imported from
// plugins/steam-orbit/index.js) so the two can never drift on the consent rules
// (SPEC §0 / PLUGIN_GUIDELINES): friends-only, first-person; a private profile
// yields no invented presence; joinme/askme are never faked; the reserved
// `self` person is emitted for the operator only; realname/timecreated dropped.
//
// The Web API returns a SNAPSHOT, not history, so every observation is stamped
// `now` — run on the scheduler and the overlap heatmap fills in over repeated
// runs, one snapshot at a time (SPEC §5).
//
// See SPEC.md §0 (charter, esp. §0.2 credentials in a 0600 file), §2 (records),
// §3 (batch), §6 (sources.configure/test), §7 (this file is [steam]).

import * as credentials from '../credentials.js';
import {
  apiUrl,
  apiGet as defaultApiGet,
  explainSteamError,
  extractFriends,
  extractPlayers,
  fetchLive,
  buildBatch,
} from '../../../plugins/steam-orbit/index.js';

export const meta = { name: 'steam', version: '1.0.0', source: 'steam' };

// The plugin name the ingest validator knows (ingest.js PLUGIN_SOURCES declares
// `steam-orbit → [steam]`). The in-process reader and the CLI both write the
// `steam` source, so both emit batches stamped with this plugin name — the core
// does not care which path a batch arrived by (SPEC §1).
const BATCH_PLUGIN = 'steam-orbit';

// The exact, actionable fix for the single most common failure: the Web API
// returns nothing for GetFriendList unless the operator's own friends list is
// public. Both the empty-list and the 401/403 cases resolve to this.
const PUBLIC_FRIENDS_MSG =
  'Steam did not return your friends list. Steam only shares it when your own ' +
  '"My Friends List" privacy is set to Public. Fix it here, then test again: ' +
  'Steam → Profile → Edit Profile → Privacy Settings → My Friends List → Public.';

// ---------------------------------------------------------------------------
// Profile-link resolution — the operator should be able to paste a profile URL
// or a vanity name, not hunt down their 17-digit SteamID64. What we STORE is
// always a resolved SteamID64.
//
//   steamcommunity.com/profiles/7656…  → the 64-bit id, extracted directly
//   a bare 17-digit string             → used as-is
//   steamcommunity.com/id/<vanity>     → ISteamUser/ResolveVanityURL/v1
//   a bare vanity name                 → ISteamUser/ResolveVanityURL/v1
//
// `apiGet` is injectable so tests can resolve a vanity from a fixture without
// touching the network.
// ---------------------------------------------------------------------------
export async function resolveSteamId(input, apiKey, deps = {}) {
  const apiGet = deps.apiGet || defaultApiGet;
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // Full profile URL carrying the numeric id.
  let m = raw.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (m) return m[1];

  // A bare SteamID64.
  if (/^\d{17}$/.test(raw)) return raw;

  // A vanity URL, or a bare vanity name.
  let vanity = null;
  m = raw.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (m) vanity = decodeURIComponent(m[1]);
  else if (!raw.includes('/') && !raw.includes(' ') && !/steamcommunity\.com/i.test(raw)) vanity = raw;
  if (!vanity) return null;

  const res = await apiGet(
    apiUrl('/ISteamUser/ResolveVanityURL/v1/', { key: apiKey, vanityurl: vanity }),
    'ResolveVanityURL'
  );
  const r = res && res.response;
  if (r && Number(r.success) === 1 && /^\d{17}$/.test(String(r.steamid))) return String(r.steamid);
  return null; // success 42 (no match) or anything unexpected → "not found"
}

// ---------------------------------------------------------------------------
// validate() — used by sources.test (dry run) and sources.configure (before
// saving). Resolves the profile, confirms the key works via GetPlayerSummaries
// for the operator (→ their persona name = "account"), and confirms the friends
// list is reachable via GetFriendList (→ friendCount). Maps every Steam failure
// through explainSteamError, with the private-friends-list case given the exact
// actionable step. Returns { ok, account, friendCount, steamId } or
// { ok:false, reason }. Never saves anything.
// ---------------------------------------------------------------------------
export async function validate(cfg = {}, deps = {}) {
  const apiGet = deps.apiGet || defaultApiGet;
  const key = String(cfg.apiKey ?? '').trim();
  if (!key) return { ok: false, reason: 'Enter your Steam Web API key first.' };
  if (!String(cfg.steamId ?? '').trim()) return { ok: false, reason: 'Paste your Steam profile link (or your SteamID64).' };

  // 1) Resolve whatever they pasted into a SteamID64.
  let steamId;
  try {
    steamId = await resolveSteamId(cfg.steamId, key, { apiGet });
  } catch (e) {
    return { ok: false, reason: explainSteamError(e) };
  }
  if (!steamId) {
    return {
      ok: false,
      reason:
        "That doesn't look like a Steam profile. Paste your profile link " +
        '(e.g. https://steamcommunity.com/id/yourname), your vanity name, or your 17-digit SteamID64.',
    };
  }

  // 2) The key must work, and it identifies the operator (their persona name).
  let account = null;
  try {
    const summary = await apiGet(
      apiUrl('/ISteamUser/GetPlayerSummaries/v2/', { key, steamids: steamId }),
      'GetPlayerSummaries'
    );
    const players = extractPlayers(summary) || [];
    const me = players.find((p) => String(p.steamid) === steamId);
    account = me && typeof me.personaname === 'string' && me.personaname.trim() ? me.personaname.trim() : null;
    if (!account) {
      return { ok: false, reason: 'Steam returned no public profile for that ID — double-check your profile link.' };
    }
  } catch (e) {
    return { ok: false, reason: explainSteamError(e) };
  }

  // 3) The friends list must be reachable — this is the Public-friends-list gate.
  let friendCount;
  try {
    const fl = await apiGet(
      apiUrl('/ISteamUser/GetFriendList/v1/', { key, steamid: steamId, relationship: 'friend' }),
      'GetFriendList'
    );
    const friends = extractFriends(fl);
    if (!friends || friends.length === 0) return { ok: false, reason: PUBLIC_FRIENDS_MSG };
    friendCount = friends.length;
  } catch (e) {
    // 401/403 here is almost always the private-friends-list case; give the fix.
    if (e && (e.status === 401 || e.status === 403)) return { ok: false, reason: PUBLIC_FRIENDS_MSG };
    return { ok: false, reason: explainSteamError(e) };
  }

  return { ok: true, account, friendCount, steamId };
}

// ---------------------------------------------------------------------------
// collect() — the scheduled entry point (SPEC §8). Returns a Batch (SPEC §3).
// Idle (empty batch) until the operator connects Steam in the Sources UI.
// ---------------------------------------------------------------------------
export async function collect(ctx = {}) {
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const emptyBatch = () => ({
    plugin: BATCH_PLUGIN,
    version: meta.version,
    emittedAt: Date.now(),
    persons: [],
    observations: [],
  });

  const cfg = credentials.getSourceConfig('steam');
  const apiKey = cfg && typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  const steamId = cfg && typeof cfg.steamId === 'string' ? cfg.steamId.trim() : '';
  if (!apiKey || !steamId) {
    // Unconfigured is not an error — the source is simply idle.
    return emptyBatch();
  }

  // `ctx.fetchLive` is a test seam: the scheduler never sets it, so live runs use
  // the real Steam transport, while a fixture test can drive collect() end-to-end
  // (reads config → fetch → buildBatch → batch) without touching the network.
  const fetch = typeof ctx.fetchLive === 'function' ? ctx.fetchLive : fetchLive;
  let friends, players;
  try {
    ({ friends, players } = await fetch(apiKey, steamId));
  } catch (e) {
    // A transient Steam outage / a since-privated friends list must not take the
    // scheduler down — log and emit nothing, like the VRCX reader does on error.
    log(`steam: fetch failed: ${explainSteamError(e)}`);
    return emptyBatch();
  }

  // Stateless per run: an empty snapshot each time, so the reader re-scans fully
  // and stays idempotent (SPEC §3 dedup). Presence/status/location are stamped
  // `now` — the heatmap fills in across scheduled runs. `friend:added` is stamped
  // with Steam's real friend_since and dedups on re-emit, so a friend row is
  // written exactly once regardless of how often we run.
  const { batch } = buildBatch({ friends, players, steamid: steamId, snapshot: {}, now: Date.now() });
  log(`steam: emitting ${batch.persons.length} persons, ${batch.observations.length} observations`);
  return batch;
}

export default { meta, collect, validate, resolveSteamId };
