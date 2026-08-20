// src/main/ipc.js — wires the SPEC §6 channels to db/digest in the main process.
// The renderer never touches these modules directly; it can only invoke the
// exact channel names the preload whitelists. Imports electron → main-only.

import { ipcMain } from 'electron';
import * as db from './db.js';
import * as digest from './digest.js';

// The complete SPEC §6 channel set. preload.js mirrors these names; nothing
// outside this map is reachable from the renderer.
export const CHANNELS = [
  'digest.whoIsOnNow',
  'digest.heatmap',
  'digest.birthdays',
  'digest.statusBoard',
  'digest.changeFeed',
  'people.list',
  'people.get',
  'people.setNote',
  'people.addManual',
  'people.link',
  'people.unlink',
  'people.linkSuggestions',
  'people.forget',
  'sources.status',
  'sources.token',
  'sources.runNow',
  'sources.configure',
  'sources.test',
  'sources.disconnect',
  'settings.get',
  'settings.set',
];

// register({ sources }) — `sources` is the runtime source registry from
// index.js (status snapshot + runNow trigger). Kept injectable so ipc.js has no
// scheduler logic of its own.
export function register({ sources } = {}) {
  const handle = (channel, fn) => ipcMain.handle('orbit:' + channel, (_e, ...args) => fn(...args));

  handle('digest.whoIsOnNow', () => digest.whoIsOnNow());
  handle('digest.heatmap', (personId) => digest.overlapHeatmap(personId));
  handle('digest.birthdays', (withinDays) => digest.upcomingBirthdays(withinDays ?? 30));
  handle('digest.statusBoard', () => digest.statusBoard());
  handle('digest.changeFeed', (sinceTs) => digest.changeFeed(sinceTs ?? 0));

  handle('people.list', (filter) => db.listPersons(filter ?? {}));
  // people.get returns the whole identity cluster (§6): `identities` is every
  // Person reachable via links (incl. the queried id itself), so the card can
  // show "also on Steam / Discord"; `timeline` is unioned across that cluster.
  handle('people.get', (id) => {
    const person = db.getPerson(id);
    const identities = person
      ? db.cluster(id).map((cid) => db.getPerson(cid)).filter(Boolean)
      : [];
    return { person, identities, timeline: digest.personTimeline(id) };
  });
  handle('people.setNote', (id, text) => db.setNote(id, text));
  // Manual-source persons come via IPC, not a plugin file (SPEC §7 "manual (UI)").
  handle('people.addManual', (p) => {
    const person = { ...p, source: 'manual' };
    if (!person.sourceId) person.sourceId = 'm_' + Date.now().toString(36);
    db.upsertPerson(person);
    return db.getPerson(db.personId('manual', person.sourceId));
  });
  handle('people.link', (idA, idB) => db.linkPersons(idA, idB));
  handle('people.unlink', (idA, idB) => db.unlinkPersons(idA, idB));
  // Candidates for the operator to CONFIRM — pure string comparison, applies
  // nothing (§0.3). id omitted → strongest across the whole roster.
  handle('people.linkSuggestions', (id) => digest.linkSuggestions(id));
  handle('people.forget', (id) => db.forgetPerson(id));

  handle('sources.status', () => (sources ? sources.status() : []));
  // The loopback ingest token (SPEC §6). Pulled on demand — the operator's own
  // secret for their own machine, shown only when they click Reveal/Copy in the
  // Sources view. It is the one thing an external emitter cannot work without.
  handle('sources.token', () => (sources ? sources.token() : { token: null, reason: 'no sources' }));
  handle('sources.runNow', (plugin) => (sources ? sources.runNow(plugin) : { ok: false, reason: 'no sources' }));
  // Connect flow (SPEC §6). test = dry-run validate; configure = validate+save+run;
  // disconnect = clear the 0600 credentials file. `cfg` carries {apiKey, steamId};
  // the full key never comes BACK (status returns only a redacted account).
  handle('sources.configure', (plugin, cfg) => (sources ? sources.configure(plugin, cfg) : { ok: false, reason: 'no sources' }));
  handle('sources.test', (plugin, cfg) => (sources ? sources.test(plugin, cfg) : { ok: false, reason: 'no sources' }));
  handle('sources.disconnect', (plugin) => (sources ? sources.disconnect(plugin) : { ok: false, reason: 'no sources' }));

  handle('settings.get', () => db.getSettings());
  handle('settings.set', (patch) => db.setSettings(patch ?? {}));
}
