// src/main/sources-status.js — the shape behind `orbit.sources.status()`
// (SPEC §6). Pure arithmetic over timestamps + the §4 `ingest_log` audit table;
// no electron, no SQL, no I/O, so it is unit-testable headless and index.js
// stays a bootstrap file.
//
// WHY THIS EXISTS. Orbit has two ingest paths (SPEC §1) but the Sources view
// only ever knew about one of them: the in-process readers that live in Orbit's
// own process (vrcx, steam) and report through `sourceState`. The *external
// emitters* — the Vencord bridge inside Discord, the standalone CLIs — POST to
// the loopback REST API and were invisible here, so "is my Vencord plugin
// actually delivering?" had no answer inside the app. It does now: every batch
// already writes an `ingest_log` row (SPEC §3/§4), and that row IS the evidence
// of delivery. This module merges the two populations into one list.
//
// It reports on SOURCES, never on people: plugin names, versions, timestamps and
// counts. That is operational telemetry about the operator's own machine, not
// data about anyone (SPEC §0.3/§0.6).

// --- health thresholds ------------------------------------------------------
// An emitter is "live" if a batch landed inside this window. Emitters are
// event-driven (the Vencord bridge re-delivers on presence changes and on its
// own heartbeat), so ten minutes of silence from a running plugin is normal and
// eleven is not yet alarming — hence a soft "idle", never an error.
export const EMITTER_LIVE_MS = 10 * 60 * 1000;

// In-process readers are driven by Orbit's own scheduler (index.js
// SCHEDULE_MINUTES = 15). Judging them on the emitter window would paint a
// perfectly healthy reader "idle" for a third of every cycle, so give them two
// scheduler ticks before the label changes.
export const READER_LIVE_MS = 30 * 60 * 1000;

// health:
//   "live"    — ran/delivered inside its window
//   "idle"    — ran/delivered, but longer ago (entry carries `ageMs`)
//   "waiting" — never ran/delivered (an emitter that has never been installed)
//   "error"   — a reader whose last run failed (lastOk === false). Emitters have
//               no equivalent: a batch that fails validation is rejected at the
//               REST boundary and never becomes a delivery, so the honest thing
//               to say about a broken emitter is "nothing arrived".
export function healthOf({ sourceKind = 'emitter', at = null, lastOk = null, now = Date.now() } = {}) {
  if (sourceKind === 'reader' && lastOk === false) return 'error';
  if (at == null) return 'waiting';
  const live = sourceKind === 'reader' ? READER_LIVE_MS : EMITTER_LIVE_MS;
  return now - at <= live ? 'live' : 'idle';
}

const declaredSources = (pluginSources, name) =>
  Array.isArray(pluginSources[name]) ? pluginSources[name] : [];

// The batch-`plugin` names an in-process reader is responsible for. It is NOT
// always the reader's own name: the Steam reader emits batches stamped
// "steam-orbit" (the name ingest.js declares for the `steam` source, shared with
// the CLI). Match by name first, then by "every source this plugin may write is
// already this reader's source".
function namesOwnedByReader(pluginSources, reader) {
  const out = [];
  for (const name of Object.keys(pluginSources)) {
    if (name === reader.plugin) {
      out.push(name);
      continue;
    }
    const decl = declaredSources(pluginSources, name);
    if (reader.source && decl.length > 0 && decl.every((s) => s === reader.source)) out.push(name);
  }
  return out;
}

/**
 * Merge in-process readers with external emitters into one status list.
 *
 * @param {object}   o
 * @param {object[]} o.readers  — sourceState entries, already carrying
 *   { plugin, source, lastRun, lastOk, nPersons, configurable, connected, account }.
 * @param {object[]} o.deliveries — db.ingestLogSummary() rows.
 * @param {object}   o.personCounts — db.personCountsBySource(), source → count.
 * @param {object}   o.pluginSources — ingest.PLUGIN_SOURCES (name → sources[]).
 * @param {number}   o.now — injectable clock, so health is testable.
 * @returns {object[]} readers first (sourceKind: "reader"), then emitters
 *   (sourceKind: "emitter") — delivering ones newest-first, then the never-seen ones.
 */
export function mergeSourceStatus({
  readers = [],
  deliveries = [],
  personCounts = {},
  pluginSources = {},
  now = Date.now(),
} = {}) {
  const byPlugin = new Map();
  for (const d of deliveries) if (d && d.plugin) byPlugin.set(d.plugin, d);

  const readerNames = new Set(readers.map((r) => r.plugin));
  const readerSources = new Set(readers.map((r) => r.source).filter(Boolean));

  // A registry entry is already covered by a reader card, so it must not also
  // appear as an emitter row — otherwise connecting Steam in the UI would leave
  // a permanent "steam-orbit: waiting for first delivery" nag beside it.
  const coveredByReader = (name) => {
    if (readerNames.has(name)) return true;
    const decl = declaredSources(pluginSources, name);
    return decl.length > 0 && decl.every((s) => readerSources.has(s));
  };

  const out = [];

  for (const r of readers) {
    // A reader's own batches are in ingest_log too — surface them so its card
    // can say what actually landed, not just that the timer fired.
    let d = null;
    for (const name of namesOwnedByReader(pluginSources, r)) {
      const cand = byPlugin.get(name);
      if (cand && (!d || (cand.lastReceivedAt ?? 0) > (d.lastReceivedAt ?? 0))) d = cand;
    }
    out.push({
      ...r,
      sourceKind: 'reader',
      sources: r.source ? [r.source] : [],
      version: d?.version ?? null,
      lastReceivedAt: d?.lastReceivedAt ?? null,
      nObs: d?.nObs ?? 0,
      totalObs: d?.totalObs ?? 0,
      deliveries: d?.deliveries ?? 0,
      ageMs: r.lastRun != null ? Math.max(0, now - r.lastRun) : null,
      health: healthOf({ sourceKind: 'reader', at: r.lastRun ?? null, lastOk: r.lastOk ?? null, now }),
    });
  }

  // Expected-but-never-seen emitters are the whole point: a user who installed
  // the Vencord plugin needs a "waiting for first delivery" row to look at, not
  // silence. `manual` is the in-app CRM path, not an emitter, so it is excluded.
  const names = new Set();
  for (const name of Object.keys(pluginSources))
    if (name !== 'manual' && !coveredByReader(name)) names.add(name);
  for (const name of byPlugin.keys())
    if (name !== 'manual' && !coveredByReader(name)) names.add(name);

  const emitters = [];
  for (const name of names) {
    const d = byPlugin.get(name) ?? null;
    const decl = declaredSources(pluginSources, name);
    const nPersons = decl.reduce((n, s) => n + (Number(personCounts[s]) || 0), 0);
    const at = d?.lastReceivedAt ?? null;
    emitters.push({
      sourceKind: 'emitter',
      plugin: name,
      sources: decl,
      version: d?.version ?? null,
      lastReceivedAt: at,
      ageMs: at != null ? Math.max(0, now - at) : null,
      nPersons,
      nObs: d?.nObs ?? 0,
      totalObs: d?.totalObs ?? 0,
      deliveries: d?.deliveries ?? 0,
      connected: at != null,
      health: healthOf({ sourceKind: 'emitter', at, now }),
      // Kept so an emitter is shape-compatible with a reader entry for any
      // consumer that reads the old fields. An emitter is never "configurable"
      // (it is configured in its own host app) and never reports a failed run:
      // a rejected batch is not a delivery.
      configurable: false,
      account: null,
      lastRun: at,
      lastOk: at != null ? true : null,
    });
  }

  emitters.sort((a, b) => {
    if ((a.lastReceivedAt == null) !== (b.lastReceivedAt == null)) return a.lastReceivedAt == null ? 1 : -1;
    if (a.lastReceivedAt !== b.lastReceivedAt) return (b.lastReceivedAt ?? 0) - (a.lastReceivedAt ?? 0);
    return a.plugin.localeCompare(b.plugin);
  });

  return out.concat(emitters);
}
