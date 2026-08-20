// contacts-orbit: vCard/iCalendar parsing (folding, escaping, QUOTED-PRINTABLE,
// year-less birthdays) plus a SPEC §3 validator transcribed from SPEC.md and a
// pass through the real core validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ingest from '../src/main/ingest.js';
import { freshDb } from './helpers.js';
import {
  buildBatch,
  normalizeBirthday,
  parseDocument,
  parseIcs,
  parseVcf,
  parseContentLine,
  unfold,
} from '../plugins/contacts-orbit/index.js';
import { readFileSync } from 'node:fs';

const CLI = fileURLToPath(new URL('../plugins/contacts-orbit/index.js', import.meta.url));
const VCF = fileURLToPath(new URL('../plugins/contacts-orbit/contacts.sample.vcf', import.meta.url));
const ICS = fileURLToPath(new URL('../plugins/contacts-orbit/birthdays.sample.ics', import.meta.url));

function run(args) {
  return JSON.parse(
    execFileSync(process.execPath, [CLI, '--dry-run', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  );
}
const RAW = run(['--file', VCF, '--file', ICS]);
const byName = (n) => RAW.persons.find((p) => p.displayName === n);

// ---------------------------------------------------------------------------
// SPEC §3 validator, transcribed from SPEC.md (not imported from the core).
// ---------------------------------------------------------------------------
const OBS_KINDS = new Set(['presence', 'status', 'location', 'bio', 'nick', 'avatar', 'friend']);
const STATUS_VALUES = new Set(['online', 'active', 'idle', 'joinme', 'askme', 'busy', 'offline']);
const PERSON_FIELDS = new Set([
  'source', 'sourceId', 'handle', 'displayName', 'avatarUrl',
  'birthday', 'pronouns', 'bio', 'note', 'links',
]);
const OBS_FIELDS = new Set(['source', 'sourceId', 'kind', 'ts', 'status', 'text', 'place', 'meta']);

function validateBatch(batch, plugin, declaredSources) {
  const errs = [];
  const declared = new Set(declaredSources);
  if (batch.plugin !== plugin) errs.push(`plugin is "${batch.plugin}", expected "${plugin}"`);
  if (typeof batch.version !== 'string' || !batch.version) errs.push('missing version');
  if (typeof batch.emittedAt !== 'number') errs.push('missing emittedAt');
  if (!Array.isArray(batch.persons)) errs.push('persons is not an array');
  if (!Array.isArray(batch.observations)) errs.push('observations is not an array');
  if (errs.length) return errs;

  const keys = new Set();
  batch.persons.forEach((p, i) => {
    for (const k of Object.keys(p)) if (!PERSON_FIELDS.has(k)) errs.push(`persons[${i}]: field "${k}" not in SPEC §2.1`);
    if (!p.source) errs.push(`persons[${i}]: missing source`);
    if (!p.sourceId) errs.push(`persons[${i}]: missing sourceId`);
    if (p.source === 'self') {
      if (p.sourceId !== 'me') errs.push(`persons[${i}]: self person must be sourceId "me"`);
    } else if (!declared.has(p.source)) {
      errs.push(`persons[${i}]: source "${p.source}" not declared by ${plugin}`);
    }
    if (p.birthday != null && !/^(\d{4}-)?\d{2}-\d{2}$/.test(p.birthday))
      errs.push(`persons[${i}]: birthday "${p.birthday}" is not MM-DD or YYYY-MM-DD`);
    keys.add(p.source + ' ' + p.sourceId);
  });

  batch.observations.forEach((o, i) => {
    for (const k of Object.keys(o)) if (!OBS_FIELDS.has(k)) errs.push(`observations[${i}]: field "${k}" not in SPEC §2.2`);
    if (!OBS_KINDS.has(o.kind)) errs.push(`observations[${i}]: kind "${o.kind}" not in the enum`);
    if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) errs.push(`observations[${i}]: bad ts`);
    if (o.status != null && !STATUS_VALUES.has(o.status))
      errs.push(`observations[${i}]: status "${o.status}" not in the enum`);
    if (!keys.has(o.source + ' ' + o.sourceId))
      errs.push(`observations[${i}]: about a person not in the batch (${o.source}:${o.sourceId})`);
  });
  return errs;
}

// ---------------------------------------------------------------------------

test('the sample .vcf + .ics dry-run emits a SPEC §3-valid batch', () => {
  assert.deepEqual(validateBatch(RAW, 'contacts-orbit', ['contacts']), []);
  assert.equal(RAW.plugin, 'contacts-orbit');
  assert.ok(RAW.persons.length >= 8);
});

test('the core registry declares the source this plugin writes', () => {
  assert.deepEqual(ingest.PLUGIN_SOURCES['contacts-orbit'], ['contacts']);
  assert.deepEqual([...new Set(RAW.persons.map((p) => p.source))], ['contacts']);
});

test('the batch is accepted by the real core validator', () => {
  const ctx = freshDb();
  try {
    const res = ingest.submit(RAW);
    assert.equal(res.ok, true, JSON.stringify(res.rejected));
    assert.equal(res.accepted.persons, RAW.persons.length);
    assert.equal(res.accepted.observations, 0);
  } finally {
    ctx.cleanup();
  }
});

test('contacts are identity data: the batch carries ZERO observations', () => {
  assert.deepEqual(RAW.observations, []);
});

test('a stated year is kept (YYYY-MM-DD), a missing year is never invented (MM-DD)', () => {
  assert.equal(byName('Ada Ramirez').birthday, '1991-04-23'); // vCard 3.0, full date
  assert.equal(byName('Bo Lindqvist').birthday, '05-17'); // vCard 4.0 BDAY:--0517
  assert.equal(byName('Zoë Smíth').birthday, '1985-11-24'); // basic format 19851124
  assert.equal(byName('Kenji Watanabe').birthday, '03-09'); // Apple X-APPLE-OMIT-YEAR=1604
  assert.equal(byName('Marisol Vega').birthday, '1993-08-02'); // item1.X-ABDATE + X-ABLABEL
  assert.equal(byName('Tomas Nowak').birthday, '1988-12-30'); // X-ANDROID-CUSTOM type 3
  for (const p of RAW.persons) assert.ok(/^(\d{4}-)?\d{2}-\d{2}$/.test(p.birthday));
});

test('normalizeBirthday covers every shape the exporters emit', () => {
  assert.equal(normalizeBirthday('--0517'), '05-17'); // vCard 4.0 year-omitted
  assert.equal(normalizeBirthday('--05-17'), '05-17');
  assert.equal(normalizeBirthday('1991-04-23'), '1991-04-23');
  assert.equal(normalizeBirthday('19910423'), '1991-04-23');
  assert.equal(normalizeBirthday('1991-04-23T00:00:00Z'), '1991-04-23');
  assert.equal(normalizeBirthday('19910423T000000Z'), '1991-04-23');
  assert.equal(normalizeBirthday('1604-03-09'), '03-09'); // Apple "no year" sentinel
  assert.equal(normalizeBirthday('1970-03-09', { 'X-APPLE-OMIT-YEAR': '1970' }), '03-09');
  assert.equal(normalizeBirthday('1970-03-09'), '1970-03-09'); // …only when the param says so
  // Nothing usable → null, never a guess.
  assert.equal(normalizeBirthday(''), null);
  assert.equal(normalizeBirthday('sometime in May'), null);
  assert.equal(normalizeBirthday('1991-13-01'), null);
  assert.equal(normalizeBirthday('--0000'), null);
  assert.equal(normalizeBirthday(undefined), null);
});

test('line folding is unfolded byte-exactly (no injected spaces)', () => {
  const lines = unfold('FN:Bo\r\nNOTE:Lo\r\n ves cold\r\n\t water\r\nEND:VCARD\r\n');
  assert.deepEqual(lines, ['FN:Bo', 'NOTE:Loves cold water', 'END:VCARD']);
  // The sample card folds mid-word: "Lo" + " ves" must rejoin as "Loves".
  assert.match(byName('Bo Lindqvist').note, /^Does not share the year, and that is fine/);
  assert.match(byName('Bo Lindqvist').note, /Loves cold-water swimming/);
});

test('RFC 6350 escaping is resolved: \\, \\; \\n', () => {
  const [c] = parseVcf('BEGIN:VCARD\nFN:Test\nBDAY:--0101\nNOTE:a\\, b\\; c\\nd\\\\e\nEND:VCARD\n');
  assert.equal(c.note, 'a, b; c\nd\\e');
  // …and the operator's own note survives verbatim in the emitted person.
  assert.equal(
    byName('Ada Ramirez').note,
    "met at Framework's world, likes DnB. Ask about the modular synth; she is building one."
  );
});

test('an escaped separator does not split a structured or list value', () => {
  const [c] = parseVcf('BEGIN:VCARD\nFN:X\nNICKNAME:one\\, two,three\nBDAY:--0202\nEND:VCARD\n');
  assert.equal(c.handle, 'one, two'); // the escaped comma stayed inside the first item
});

test('QUOTED-PRINTABLE values (and their soft line breaks) are decoded', () => {
  const p = byName('Zoë Smíth');
  assert.ok(p, 'QP-encoded FN decoded to UTF-8');
  assert.equal(p.note, 'met at the Berlin meetup\nbrings the good coffee'); // =0A + trailing "="
});

test('parseContentLine handles groups, params and quoted colons', () => {
  const l = parseContentLine('item1.X-ABDATE;VALUE=DATE;TYPE="a:b":1993-08-02');
  assert.equal(l.group, 'ITEM1');
  assert.equal(l.name, 'X-ABDATE');
  assert.equal(l.params.VALUE, 'DATE');
  assert.equal(l.params.TYPE, 'a:b');
  assert.equal(l.rawValue, '1993-08-02');
});

test('a card with no FN falls back to N, and a card with no name is dropped', () => {
  const cs = parseVcf(
    'BEGIN:VCARD\nN:Doe;Jane;Q;;\nBDAY:--0303\nEND:VCARD\n' +
      'BEGIN:VCARD\nBDAY:--0404\nEND:VCARD\n'
  );
  assert.equal(cs.length, 1);
  assert.equal(cs[0].displayName, 'Jane Q Doe');
});

test('sourceId is the vCard UID when present, else a stable sha1 of the name', () => {
  assert.equal(byName('Ada Ramirez').sourceId, 'urn:uuid:6f0a1b3c-1111-4a2b-9c3d-000000000001');
  const derived = byName('Zoë Smíth').sourceId; // that card has no UID
  assert.match(derived, /^[0-9a-f]{40}$/);
  // Stable across runs and across whitespace/case noise in the name.
  const again = parseVcf('BEGIN:VCARD\nFN:  zoë   smíth \nBDAY:19851124\nEND:VCARD\n')[0];
  assert.equal(again.sourceId, derived);
});

test('.ics birthdays are MM-DD only — a recurring event\'s DTSTART year is not a birth year', () => {
  const priya = byName('Priya Raman'); // CATEGORIES:Birthday, DTSTART 19900517
  assert.equal(priya.birthday, '05-17');
  assert.equal(byName('Tomás Vega').birthday, '07-14'); // "X's Birthday" + RRULE=YEARLY
  const fromIcs = parseIcs(readFileSync(ICS, 'utf8'));
  assert.equal(fromIcs.length, 3);
  for (const c of fromIcs) assert.equal(c.birthday.length, 5, `${c.displayName} must be MM-DD`);
});

test('.ics events that are not birthdays are ignored', () => {
  assert.equal(byName('Dentist'), undefined);
  const cs = parseIcs(
    'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20260820T140000Z\nSUMMARY:Standup\nRRULE:FREQ=DAILY\nEND:VEVENT\nEND:VCALENDAR\n'
  );
  assert.deepEqual(cs, []);
});

test('the same human in a .vcf and an .ics is NOT auto-linked (SPEC §2.1)', () => {
  // Ada is in both fixtures. She arrives as TWO person rows with different ids:
  // the plugin does not fuzzy-match identities — the operator links them in the UI.
  const ada = RAW.persons.filter((p) => p.displayName === 'Ada Ramirez');
  assert.equal(ada.length, 2);
  assert.notEqual(ada[0].sourceId, ada[1].sourceId);
  assert.equal(ada[0].birthday, '1991-04-23'); // vCard: year stated
  assert.equal(ada[1].birthday, '04-23'); // .ics: year deliberately dropped
  for (const p of RAW.persons) assert.equal(p.links, undefined); // no auto-asserted links, ever
});

test('contacts without a birthday are skipped unless --all is passed', () => {
  assert.equal(byName('No Birthday Here'), undefined);
  const all = run(['--file', VCF, '--all']);
  const kept = all.persons.find((p) => p.displayName === 'No Birthday Here');
  assert.ok(kept);
  assert.equal(kept.birthday, undefined); // omitted, never a placeholder
  assert.deepEqual(validateBatch(all, 'contacts-orbit', ['contacts']), []);
});

test('format sniffing works when the extension does not say', () => {
  assert.equal(parseDocument(readFileSync(VCF, 'utf8'), 'export.txt').length, 7);
  assert.equal(parseDocument(readFileSync(ICS, 'utf8'), 'export.txt').length, 3);
  assert.throws(() => parseDocument('hello', 'x.txt'), /not a vCard or iCalendar/);
});

test('the snapshot makes a re-run a no-op; a changed note re-emits just that person', () => {
  const contacts = parseVcf(readFileSync(VCF, 'utf8'));
  const first = buildBatch({ contacts, now: 1 });
  assert.equal(first.batch.persons.length, 6);
  const second = buildBatch({ contacts, snapshot: first.nextSnapshot, now: 2 });
  assert.equal(second.batch.persons.length, 0);
  assert.equal(second.stats.unchanged, 6);

  const edited = contacts.map((c) => (c.displayName === 'Ada Ramirez' ? { ...c, note: 'new note' } : c));
  const third = buildBatch({ contacts: edited, snapshot: first.nextSnapshot, now: 3 });
  assert.equal(third.batch.persons.length, 1);
  assert.equal(third.batch.persons[0].note, 'new note');
  assert.deepEqual(validateBatch(third.batch, 'contacts-orbit', ['contacts']), []);
});

test('duplicate records merge, preferring the birthday that states a year', () => {
  const { batch } = buildBatch({
    contacts: [
      { sourceId: 'u1', displayName: 'Dup', handle: null, birthday: '04-23', note: null },
      { sourceId: 'u1', displayName: 'Dup', handle: 'dd', birthday: '1991-04-23', note: 'hi' },
    ],
    now: 1,
  });
  assert.equal(batch.persons.length, 1);
  assert.deepEqual(batch.persons[0], {
    source: 'contacts', sourceId: 'u1', displayName: 'Dup', handle: 'dd', birthday: '1991-04-23', note: 'hi',
  });
});
