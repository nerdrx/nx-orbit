// test/mastodon-orbit.test.js — the mastodon-orbit external emitter.
// Runs the CLI offline (--dry-run --from-fixture) and pushes the emitted batch
// through the REAL core validator, so "SPEC §3 valid" is checked by the code
// that would reject it in production, not by a restatement of the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ingest from '../src/main/ingest.js';
import { freshDb } from './helpers.js';
import {
  parseLinkNext,
  decodeEntities,
  htmlToText,
  parseBirthday,
  readProfileFields,
  fullHandle,
  toPerson,
  buildBatch,
} from '../plugins/mastodon-orbit/index.js';

const CLI = fileURLToPath(new URL('../plugins/mastodon-orbit/index.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../plugins/mastodon-orbit/fixture.sample.json', import.meta.url));
const SNAPSHOT_NAME = 'mastodon-orbit.snapshot.fixture.json';

/** Run the CLI with an isolated HOME so the operator's real snapshot is untouched. */
function runCli(args, { snapshot } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'orbit-mastodon-home-'));
  try {
    if (snapshot) {
      mkdirSync(join(home, '.config', 'nx-orbit'), { recursive: true });
      writeFileSync(join(home, '.config', 'nx-orbit', SNAPSHOT_NAME), JSON.stringify(snapshot));
    }
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, NX_ORBIT_TOKEN: '' },
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const dryRun = opts => runCli(['--from-fixture', FIXTURE, '--dry-run'], opts);

// ---------------------------------------------------------------- CLI

test('mastodon-orbit --dry-run --from-fixture emits a batch the core accepts', () => {
  const batch = dryRun();
  const t = freshDb();
  try {
    const res = ingest.submit(batch);
    assert.equal(res.ok, true, 'core rejected: ' + JSON.stringify(res.rejected));
    assert.equal(res.accepted.persons, batch.persons.length);
  } finally {
    t.cleanup();
  }
});

test('batch envelope matches SPEC §3 and the plugin registry', () => {
  const batch = dryRun();
  assert.equal(batch.plugin, 'mastodon-orbit');
  assert.deepEqual(ingest.PLUGIN_SOURCES['mastodon-orbit'], ['mastodon']);
  assert.equal(typeof batch.version, 'string');
  assert.equal(typeof batch.emittedAt, 'number');
  assert.ok(batch.emittedAt > 1_600_000_000_000, 'emittedAt is epoch ms');
  assert.ok(Array.isArray(batch.persons) && Array.isArray(batch.observations));
});

test('every person is mastodon-sourced, or the reserved (self, me)', () => {
  const batch = dryRun();
  const selves = batch.persons.filter(p => p.source === 'self');
  assert.equal(selves.length, 1);
  assert.equal(selves[0].sourceId, 'me');
  for (const p of batch.persons) assert.ok(p.source === 'mastodon' || p.source === 'self', p.source);
});

test('Mastodon has no presence — the plugin emits none, and never a VRChat ring', () => {
  const batch = dryRun({ snapshot: null });
  assert.equal(batch.observations.filter(o => o.kind === 'presence').length, 0);
  for (const o of batch.observations) {
    assert.ok(ingest.OBS_KINDS.has(o.kind), `kind ${o.kind}`);
    assert.notEqual(o.status, 'joinme');
    assert.notEqual(o.status, 'askme');
    if (o.status != null) assert.ok(ingest.STATUS_VALUES.has(o.status));
    assert.equal(typeof o.ts, 'number');
    assert.ok(o.ts > 1_600_000_000_000, 'ts is epoch ms');
  }
});

test('every observation subject is present in persons', () => {
  const batch = dryRun();
  const keys = new Set(batch.persons.map(p => p.source + ' ' + p.sourceId));
  for (const o of batch.observations) assert.ok(keys.has(o.source + ' ' + o.sourceId), `${o.source}:${o.sourceId}`);
});

test('pagination: all three Link-chained fixture pages are followed', () => {
  const batch = dryRun();
  const ids = batch.persons.filter(p => p.source === 'mastodon').map(p => p.sourceId).sort();
  assert.deepEqual(ids, ['7690', '7702', '7708', '7710']);
});

test('profile fields the person published become pronouns / birthday', () => {
  const batch = dryRun();
  const by = id => batch.persons.find(p => p.sourceId === id);
  assert.equal(by('7710').pronouns, 'she/her');
  assert.equal(by('7710').birthday, '1994-05-12'); // they stated the year
  assert.equal(by('7708').pronouns, 'he/him');
  assert.equal(by('7708').birthday, '03-03'); // "March 3" — no year stated, none invented
  assert.equal(by('7690').pronouns, 'they/them');
  assert.equal(by('7690').birthday, '07-18'); // "18/07" — 18 can only be the day
  assert.equal(by('7702').pronouns, undefined); // no fields → field omitted entirely
  assert.equal(by('7702').birthday, undefined);
});

// ---------------------------------------------------- snapshot diffing

test('second run against a snapshot emits bio / nick / avatar / friend changes only', () => {
  const snapshot = {
    version: 1,
    accounts: {
      // aria: bio and display name both changed since we last looked
      7710: {
        handle: '@aria@mastodon.example',
        displayName: 'Aria',
        bio: 'Synth builder.',
        avatarUrl: 'https://files.mastodon.example/accounts/avatars/000/007/710/original/aria-v2.png',
      },
      // kaz: unchanged
      7708: {
        handle: '@kaz@fedi.example',
        displayName: 'kaz',
        bio: '🏖 away till the 20th — slow replies',
        avatarUrl: 'https://files.mastodon.example/cache/accounts/avatars/000/007/708/original/kaz.jpg',
      },
      // someone we followed last run who is not in the following list any more
      6001: { handle: '@gone@old.example', displayName: 'Gone', bio: '', avatarUrl: '' },
    },
  };
  const batch = dryRun({ snapshot });
  const of = (id, kind) => batch.observations.filter(o => o.sourceId === id && o.kind === kind);

  const bio = of('7710', 'bio');
  assert.equal(bio.length, 1);
  assert.match(bio[0].text, /DnB enjoyer/);
  assert.equal(bio[0].meta.previous, 'Synth builder.');

  const nick = of('7710', 'nick');
  assert.equal(nick.length, 1);
  assert.equal(nick[0].text, 'Aria ✨');
  assert.equal(nick[0].meta.previous, 'Aria');

  assert.equal(of('7710', 'avatar').length, 1);
  assert.equal(of('7708', 'bio').length, 0, 'unchanged account emits nothing');
  assert.equal(of('7708', 'nick').length, 0);
  assert.equal(of('7708', 'avatar').length, 0);

  // newly-followed accounts on a NON-first run do get a friend event
  assert.equal(of('7690', 'friend')[0].meta.state, 'followed');
  // and the vanished one is recorded as unfollowed, with its person re-upserted
  assert.equal(of('6001', 'friend')[0].meta.state, 'unfollowed');
  assert.ok(batch.persons.some(p => p.sourceId === '6001'), 'unfollowed person is in-batch');

  const t = freshDb();
  try {
    assert.equal(ingest.submit(batch).ok, true);
  } finally {
    t.cleanup();
  }
});

test('re-running with an identical snapshot emits nothing (idempotent)', () => {
  const first = dryRun();
  const accounts = {};
  for (const p of first.persons.filter(p => p.source === 'mastodon')) {
    accounts[p.sourceId] = {
      handle: p.handle,
      displayName: p.displayName,
      bio: p.bio ?? '',
      avatarUrl: p.avatarUrl ?? '',
    };
  }
  const again = dryRun({ snapshot: { version: 1, accounts } });
  assert.equal(again.observations.length, 0);
  assert.ok(again.persons.length > 0, 'persons are still re-upserted');
});

test('first run baselines bios but invents no follow timestamps', () => {
  const batch = dryRun({ snapshot: null });
  assert.equal(batch.observations.filter(o => o.kind === 'friend').length, 0);
  assert.equal(batch.observations.filter(o => o.kind === 'bio').length, 3); // orbitbot has no bio
});

test('buildBatch never emits presence, whatever the inputs', () => {
  const persons = [{ source: 'mastodon', sourceId: '1', handle: '@a@b', displayName: 'A', bio: 'x' }];
  const { batch } = buildBatch(persons, null, null, 1_700_000_000_000);
  assert.equal(batch.observations.some(o => o.kind === 'presence'), false);
  assert.equal(batch.observations.some(o => o.status != null), false);
});

// ------------------------------------------------------- unit: parsing

test('parseLinkNext picks rel="next" and ignores prev', () => {
  const h =
    '<https://m.example/api/v1/accounts/1/following?max_id=110>; rel="next", ' +
    '<https://m.example/api/v1/accounts/1/following?since_id=120>; rel="prev"';
  assert.equal(parseLinkNext(h), 'https://m.example/api/v1/accounts/1/following?max_id=110');
  assert.equal(parseLinkNext('<https://m.example/x>; rel="prev"'), null);
  assert.equal(parseLinkNext(undefined), null);
  assert.equal(parseLinkNext(''), null);
});

test('decodeEntities handles named, decimal and hex references', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x2014;'), "a & b <c> 'd' —");
  // &nbsp; decodes to a real U+00A0 — verbatim, not silently flattened to a space
  assert.equal(decodeEntities('a&nbsp;b'), 'a\u00a0b');
  assert.equal(decodeEntities('&notareal;'), '&notareal;'); // unknown entity left alone
});

test('htmlToText renders a Mastodon note the way the person wrote it', () => {
  assert.equal(
    htmlToText('<p>Line one.<br />Line two.</p><p>Para two &amp; more</p>'),
    'Line one.\nLine two.\n\nPara two & more'
  );
  // links keep their visible text, the markup around them disappears
  assert.equal(
    htmlToText('<p>site: <a href="https://x.example"><span class="invisible">https://</span>x.example</a></p>'),
    'site: https://x.example'
  );
  // an escaped angle bracket the person literally typed survives as text
  assert.equal(htmlToText('<p>i love &lt;marquee&gt;</p>'), 'i love <marquee>');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
});

test('parseBirthday keeps a stated year, never invents one, refuses ambiguity', () => {
  assert.equal(parseBirthday('1994-05-12'), '1994-05-12');
  assert.equal(parseBirthday('May 12'), '05-12');
  assert.equal(parseBirthday('12 May'), '05-12');
  assert.equal(parseBirthday('May 12th, 1994'), '1994-05-12');
  assert.equal(parseBirthday('3rd of March'), '03-03');
  assert.equal(parseBirthday('05-12'), '05-12');
  assert.equal(parseBirthday('18/07'), '07-18'); // 18 can only be a day
  assert.equal(parseBirthday('07/18'), '07-18');
  assert.equal(parseBirthday('03/04'), null, 'DD/MM vs MM/DD is ambiguous — refuse');
  assert.equal(parseBirthday('sometime in spring'), null);
  assert.equal(parseBirthday('2024-13-40'), null);
  assert.equal(parseBirthday(''), null);
  assert.equal(parseBirthday(undefined), null);
});

test('readProfileFields only reads pronoun/birthday-named fields', () => {
  const fields = [
    { name: 'Pronouns', value: 'she/her' },
    { name: 'Birthday', value: '<p>1994-05-12</p>' },
    { name: 'Location', value: 'Berlin' }, // NOT mapped — Orbit stores no location field
    { name: 'Lucky number', value: '03/04' },
  ];
  assert.deepEqual(readProfileFields(fields), { pronouns: 'she/her', birthday: '1994-05-12' });
  assert.deepEqual(readProfileFields([{ name: 'bday', value: 'never' }]), {}); // unparseable → omitted
  assert.deepEqual(readProfileFields(undefined), {});
});

test('fullHandle qualifies local accounts with your instance domain', () => {
  assert.equal(fullHandle('aria', 'mastodon.example'), '@aria@mastodon.example');
  assert.equal(fullHandle('kaz@fedi.example', 'mastodon.example'), '@kaz@fedi.example');
  assert.equal(fullHandle('@aria', 'mastodon.example'), '@aria@mastodon.example');
  assert.equal(fullHandle('', 'mastodon.example'), null);
});

test('toPerson emits allow-listed fields only, and omits what is empty', () => {
  const p = toPerson({ id: 9, acct: 'x', display_name: '', note: '', avatar_static: '', fields: [] }, 'h.example');
  assert.deepEqual(Object.keys(p).sort(), ['displayName', 'handle', 'source', 'sourceId']);
  assert.equal(p.displayName, '@x@h.example'); // falls back to the handle, not a placeholder
  assert.equal(toPerson({ acct: 'x' }, 'h.example'), null); // no id → skipped, not invented
});
