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
  'people.forget',
  'sources.status',
  'sources.runNow',
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
  handle('people.get', (id) => ({ person: db.getPerson(id), timeline: digest.personTimeline(id) }));
  handle('people.setNote', (id, text) => db.setNote(id, text));
  // Manual-source persons come via IPC, not a plugin file (SPEC §7 "manual (UI)").
  handle('people.addManual', (p) => {
    const person = { ...p, source: 'manual' };
    if (!person.sourceId) person.sourceId = 'm_' + Date.now().toString(36);
    db.upsertPerson(person);
    return db.getPerson(db.personId('manual', person.sourceId));
  });
  handle('people.link', (idA, idB) => db.linkPersons(idA, idB));
  handle('people.forget', (id) => db.forgetPerson(id));

  handle('sources.status', () => (sources ? sources.status() : []));
  handle('sources.runNow', (plugin) => (sources ? sources.runNow(plugin) : { ok: false, reason: 'no sources' }));

  handle('settings.get', () => db.getSettings());
  handle('settings.set', (patch) => db.setSettings(patch ?? {}));
}
