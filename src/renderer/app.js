// NX Orbit — renderer controller. No framework, no bundler: view functions
// return HTML strings, and this one module owns the DOM and window.orbit
// (SPEC §6). The mock is imported first so that, when the page is opened in a
// plain browser (no Electron behind it), window.orbit exists before we render.
//
// THE BRIDGE IS ASYNC. Every window.orbit method is ipcRenderer.invoke behind
// the preload, so every one of them returns a Promise. Views are async and the
// router awaits them; nothing here may read a bridge result without awaiting.
import './mock.js';

const orbit = window.orbit;
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const rail = $('#rail');

/* ------------------------------------------------------------- utilities */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------ display names are hostile
   A display name is arbitrary text authored by someone else. Real rosters
   contain 76-character walls with no break opportunity, wide CJK (≈2× the
   advance of ASCII), astral-plane letterforms stored as surrogate pairs, emoji
   ZWJ sequences, RTL scripts, and combining-mark stacks that paint far outside
   their line box. CSS truncation handles the width; these helpers handle the
   two things CSS cannot:

     1. Characters that reorder or hide the UI *around* the name — bidi
        overrides/embeddings (U+202A–202E, U+2066–2069), zero-width joiners
        used as separators, line/paragraph separators, BOM. An unbalanced
        U+202E in one friend's name would otherwise mirror every label after
        it. ZWJ (U+200D) is deliberately kept so emoji sequences stay one
        glyph rather than exploding into their parts.
     2. Length, measured in GRAPHEME CLUSTERS. Slicing by code unit splits
        surrogate pairs into mojibake; slicing by code point still decapitates
        an emoji sequence or a combining stack. Intl.Segmenter does it right;
        Array.from (code points) is the fallback.

   The cap is defensive belt-and-braces: CSS already clips, but a name that is
   never *materialised* long can't be measured long either — which keeps
   intrinsic sizing (grid `auto` tracks, table layout) honest. */
const UNSAFE_TEXT = /[\u00AD\u034F\u061C\u200B\u200C\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;
function graphemes(s) {
  if (!SEGMENTER) return Array.from(s);
  const out = [];
  for (const seg of SEGMENTER.segment(s)) out.push(seg.segment);
  return out;
}
// The full name, safe to put in the DOM (and in a title=""), but not shortened.
function fullName(raw) {
  const s = String(raw ?? '').replace(UNSAFE_TEXT, '').replace(/\s+/g, ' ').trim();
  return s || 'Unnamed';
}
const NAME_MAX = 40;
function safeName(raw, max = NAME_MAX) {
  // Cap combining marks at two per base character: that is enough for real
  // orthography (Vietnamese, Thai, Devanagari) and defuses zalgo.
  const s = fullName(raw).replace(/(\p{M}\p{M})\p{M}+/gu, '$1');
  const g = graphemes(s);
  return g.length > max ? g.slice(0, max - 1).join('') + '…' : s;
}
// One line, one attribute: the visible (clamped) name plus a title carrying the
// full one, so nothing is ever silently lost.
function nameCell(raw, cls = 't-clip') {
  const full = fullName(raw);
  const shown = safeName(raw);
  const title = shown === full ? '' : ` title="${esc(full)}"`;
  return { html: esc(shown), title, full, shown, cls };
}

// Deterministic hue in the cyan→violet band (DESIGN §8: 187–290°).
function hueOf(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 187 + ((h >>> 0) % 104);
}
function initials(name) {
  // Strip marks and the decoration people bracket their names with ("༻༒…༒༺",
  // "█▓▒░ … ░▒▓█") so the monogram lands on actual letters where there are any.
  const clean = fullName(name)
    .replace(/\p{M}+/gu, '')
    .replace(/^[^\p{L}\p{N}\p{Emoji_Presentation}]+/u, '')
    .trim();
  const parts = (clean || fullName(name)).split(' ').filter(Boolean);
  if (!parts.length) return '?';
  const first = graphemes(parts[0]);
  if (!first.length) return '?';
  if (parts.length === 1) return first.slice(0, 2).join('').toUpperCase();
  const last = graphemes(parts[parts.length - 1]);
  return (first[0] + (last[0] || '')).toUpperCase();
}
function avatar(p, size = 'sm') {
  const h = hueOf(p.id || p.displayName || 'x');
  const live = p.status && p.status !== 'offline' ? '<span class="live" title="online now"></span>' : '';
  return `<span class="avatar ${size}" style="--h:${h}" aria-hidden="true">${esc(initials(p.displayName))}${live}</span>`;
}

// Locale-independent formatting (DESIGN §7 — host may run any locale).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEK_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
function fmtDate(ts) { const d = new Date(ts); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; }
// Parse a "YYYY-MM-DD" string into a LOCAL date (Date.parse treats it as UTC).
function localDate(iso) { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function fmtDayLabel(ts) { const d = new Date(ts); return `${WEEK_LONG[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; }
function fmtTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  const h = Math.round(s / 3600);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// "MM-DD" | "YYYY-MM-DD" → days until the next occurrence. Pure arithmetic on
// a field the person already published (SPEC §0.3) — no inference, and no IPC
// round-trip just to label one card.
function daysUntilBirthday(mmdd) {
  const parts = String(mmdd).split('-').map(Number);
  if (parts.some(Number.isNaN)) return null;
  const [mm, dd] = parts.length === 3 ? [parts[1], parts[2]] : parts;
  if (!mm || !dd) return null;
  const now = new Date();
  const floor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let cand = new Date(floor.getFullYear(), mm - 1, dd);
  if (cand < floor) cand = new Date(floor.getFullYear() + 1, mm - 1, dd);
  return Math.round((cand - floor) / 86400000);
}

// Defensive coercion — the bridge is IPC; a shape that isn't what we expect
// should degrade to an empty view, never throw halfway through a render.
const asArray = (v) => (Array.isArray(v) ? v : []);

/* ---------------------------------------------------------------- icons */
// Stroked geometric glyphs, currentColor, ~1.7px stroke (DESIGN §8). No emoji.
const I = {
  now: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>',
  heatmap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6M17.5 14.8c2.3.5 4 2.5 4 5.2"/></svg>',
  changes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5c1 0 2 .25 2.8.7"/><path d="M17.5 13.5v6M14.5 16.5h6"/></svg>',
  sources: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6M4.5 11.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6"/></svg>',
  place: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s6.5-5.7 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.3 6.5 11 6.5 11Z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  cake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16M5 20v-6.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2V20"/><path d="M4.5 15c1.2 0 1.2 1 2.4 1s1.2-1 2.4-1 1.2 1 2.4 1 1.2-1 2.4-1 1.2 1 2.4 1"/><path d="M12 4v3.5M9 5.5V7M15 5.5V7"/></svg>',
  bio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h9l5 5v11H5z"/><path d="M14 4v5h5M8 13h8M8 16.5h5"/></svg>',
  nick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>',
  avatarChange: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><circle cx="9" cy="9.5" r="2"/><path d="M4 17l4.5-4 3 2.5L15 11l5 5.5"/></svg>',
  friend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.2-7-9.2A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7 2.8c0 5-7 9.2-7 9.2Z"/></svg>',
  presence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>',
  status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a7.5 7.5 0 0 1-10.5 6.9L4 20l1.6-5.5A7.5 7.5 0 1 1 20 11.5Z"/></svg>',
  location: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s6.5-5.7 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.3 6.5 11 6.5 11Z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5 12 15.5 18 9.5"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="1.6"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5 21 20H3z"/><path d="M12 10v4.5M12 17.5h.01"/></svg>',
};
const OBS_ICON = { presence: I.presence, status: I.status, location: I.location, bio: I.bio, nick: I.nick, avatar: I.avatarChange, friend: I.friend };

/* ------------------------------------------------------- small builders */
function srcBadge(source) {
  const label = { vrcx: 'VRChat', discord: 'Discord', twitter: 'X', manual: 'Manual' }[source] || source;
  return `<span class="badge-src" data-src="${esc(source)}"><span class="sdot"></span>${esc(label)}</span>`;
}
function sectionLabel(text) {
  return `<div class="section-label"><span class="micro">${esc(text)}</span><span class="rule"></span></div>`;
}

/* =====================================================================
   VIEW 1 — NOW (home)
   ===================================================================== */
async function viewNow() {
  // Three independent queries — fire them together, not in series.
  const [now, bdays, board] = await Promise.all([
    orbit.digest.whoIsOnNow(),
    orbit.digest.birthdays(30),
    orbit.digest.statusBoard(),
  ]);
  const people = asArray(now?.people);
  const count = typeof now?.count === 'number' ? now.count : people.length;

  const cards = people.length
    ? `<div class="grid-people">${people.map(friendCard).join('')}</div>`
    : emptyState('No one’s around right now', 'When a friend comes online on any of your sources, they’ll appear here — waved at, not tracked.');

  const bdayList = asArray(bdays);
  const bdayStrip = bdayList.length
    ? `<div class="bday-strip">${bdayList.map(bdayCard).join('')}</div>`
    : `<p class="pc-none">No birthdays in the next 30 days.</p>`;

  const boardList = asArray(board);
  const boardHtml = boardList.length
    ? `<div class="board">${boardList.map(boardRow).join('')}</div>`
    : `<p class="pc-none">No one has set a status. This is where “🏖 on holiday” notes show up, verbatim.</p>`;

  return `
    <div class="view">
      <div class="view-head">
        <div>
          <h1 class="view-title">Who’s around</h1>
          <p class="view-sub">${count} ${count === 1 ? 'friend is' : 'friends are'} online right now, across your sources. The cyan dot just means “on right now.”</p>
        </div>
      </div>
      ${cards}
      ${sectionLabel('Upcoming birthdays')}
      ${bdayStrip}
      ${sectionLabel('Status board · what everyone’s up to')}
      ${boardHtml}
    </div>`;
}

function friendCard(p) {
  const n = nameCell(p.displayName);
  const place = p.place
    ? `<div class="fc-place">${I.place}<span class="t-clip">${esc(p.place)}</span></div>`
    : '';
  return `
    <button class="card interactive friend-card" data-open="${esc(p.id)}" aria-label="Open ${esc(n.full)}">
      <div class="fc-top">
        ${avatar(p, 'md')}
        <div class="fc-name">
          <b class="t-clip"${n.title}>${n.html}</b>
          <span class="fc-handle t-clip">@${esc(p.handle)}</span>
        </div>
      </div>
      ${place}
      <div class="fc-meta">
        <span class="chip live"><span class="cdot"></span>Online</span>
        ${srcBadge(p.source)}
      </div>
    </button>`;
}

function bdayCard(b) {
  const soon = b.daysAway <= 7 ? 'soon' : '';
  const when = b.daysAway === 0 ? 'Today' : b.daysAway === 1 ? 'Tomorrow' : `${b.daysAway} days`;
  const sub = b.daysAway <= 1 ? '' : '<small>away</small>';
  const n = nameCell(b.person.displayName);
  return `
    <div class="card bday-card ${soon}">
      <div class="bd-when">${esc(when)} ${sub}</div>
      <div class="bd-who">${avatar(b.person, 'sm')}<span class="t-clip"${n.title}>${n.html}</span></div>
      <div class="bd-date"><span>${esc(fmtDate(b.nextDate ? localDate(b.nextDate) : Date.now()))}</span>${srcBadge(b.person.source)}</div>
    </div>`;
}

function boardRow(s) {
  const n = nameCell(s.person.displayName);
  return `
    <button class="board-row" data-open="${esc(s.person.id)}">
      ${avatar(s.person, 'sm')}
      <span class="br-text"><span class="br-name"${n.title}>${n.html}</span>${esc(s.text)}</span>
      <span class="br-when">${esc(relTime(s.ts))}</span>
    </button>`;
}

/* =====================================================================
   VIEW 2 — HEATMAP
   ===================================================================== */
let heatmapPerson = ''; // '' = Everyone
let heatmapRoster = [];
let refocusHmSelect = false;

async function viewHeatmap() {
  const [people, hm] = await Promise.all([
    orbit.people.list({}),
    orbit.digest.heatmap(heatmapPerson || undefined),
  ]);
  const roster = asArray(people);
  heatmapRoster = roster;
  const grid = Array.isArray(hm?.grid) ? hm.grid : [];
  const max = typeof hm?.max === 'number' ? hm.max : 0;
  const windowDays = hm?.windowDays ?? '—';
  const sel = roster.find((p) => p.id === heatmapPerson);
  const isAggregate = !heatmapPerson;
  const who = heatmapPerson ? safeName(sel?.displayName || 'this friend', 28) : 'your circle';

  const body = grid.length
    ? `${heatTable(grid, max)}`
    : emptyState('No overlap yet', 'Once there’s presence history from you and your friends, the hours you were both online show up here.');

  return `
    <div class="view hm-wrap">
      <div class="view-head">
        <div>
          <h1 class="view-title">Overlap heatmap</h1>
          <p class="view-sub">Hours you and ${esc(who)} were <b>both</b> online — a histogram of the past ${esc(windowDays)} days, not a prediction of anyone’s schedule.</p>
        </div>
      </div>
      <div class="hm-controls">${comboboxHtml(roster, sel)}</div>
      <div class="card hm-grid-card">
        <div class="hm-scroll">${body}</div>
        ${grid.length ? heatLegend(max, { isAggregate, who, friendsConsidered: hm?.friendsConsidered }) : ''}
        ${selfHoursNote(hm)}
        <div class="hm-note">${I.info}<span>This is arithmetic on timestamps you already had — <b>counts of past overlap</b>. Orbit predicts nothing, alerts nothing, and tracks no one in real time.</span></div>
      </div>
    </div>`;
}

// The grid can only count hours Orbit knows YOU were online, so a sparse grid
// is usually a thin self-history rather than an absent social life. Say so —
// but only when it's actually the explanation, and without alarm.
const THIN_SELF_HOURS = 10;
function selfHoursNote(hm) {
  const n = hm?.selfHours;
  if (typeof n !== 'number' || n >= THIN_SELF_HOURS) return '';
  const body = n === 0
    ? 'Orbit has no record yet of when <b>you</b> were online, and overlap needs both halves — so there is nothing to count here yet. It fills in as your own presence history is collected.'
    : `Based on ${esc(n)} ${n === 1 ? 'hour' : 'hours'} of <b>your own</b> recorded presence so far — a sparse grid here usually means Orbit doesn’t know much about your hours yet, not that no one was around. It fills in as more of your history is collected.`;
  return `<div class="hm-note hm-thin">${I.info}<span>${body}</span></div>`;
}

/* --------------------------------------------------------- the NX combobox
   A native <select> holding 411 friends is an unstyled OS dropdown you cannot
   theme and cannot navigate: no filtering, no grouping, and a list taller than
   the screen. This replaces it with the ARIA 1.2 *editable combobox* pattern.

   Why that pattern and not a fancy div: focus never leaves the real <input
   role="combobox">, so the browser's own text editing, IME, and screen-reader
   forms mode all keep working. The popup is a role="listbox" of role="option"
   elements which are NOT focusable — the active one is named by
   aria-activedescendant instead. That is what makes it keyboard-complete
   (↑/↓/Home/End/Enter/Escape/Tab) and announceable without trapping Tab, and
   the "trap" reduces to: while the popup is open, focus stays in the input.

   Ordering, for when someone scrolls rather than types: "Everyone" first (the
   default and by far the most-used choice), then friends who are online now
   (the ones you are most likely to be looking up), then the rest — each group
   alphabetical, in the locale-independent order the core already returned. */
const HM_SELECT_ID = 'hm-person';
const EVERYONE = { id: '', displayName: 'Everyone (your circle)', source: '', handle: '' };

function optionLabel(p) {
  return p.id === '' ? p.displayName : safeName(p.displayName, 34);
}
function comboboxHtml(roster, selected) {
  const cur = selected || EVERYONE;
  return `
    <div class="nxs" data-combobox data-open="false">
      <label class="nxs-label" for="${HM_SELECT_ID}">Compare with</label>
      <div class="nxs-control">
        <input
          id="${HM_SELECT_ID}"
          class="nxs-input"
          type="text"
          role="combobox"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-expanded="false"
          aria-controls="${HM_SELECT_ID}-listbox"
          aria-describedby="${HM_SELECT_ID}-foot"
          aria-autocomplete="list"
          placeholder="Search your ${roster.length} friends…"
          value="${esc(optionLabel(cur))}" />
        <span class="nxs-caret" aria-hidden="true">${I.caret}</span>
      </div>
      <div class="nxs-pop" hidden>
        <div class="nxs-list" id="${HM_SELECT_ID}-listbox" role="listbox" aria-label="Compare with"></div>
        <div class="nxs-foot" id="${HM_SELECT_ID}-foot" role="status">${roster.length} friends · type to filter</div>
      </div>
    </div>`;
}

// Fold to a searchable key: strip marks and non-alphanumerics so "Νυχτερινή",
// "níg̈ht" and "nova‮star" are all findable by typing plain letters.
function fold(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

function wireCombobox(root, { onChange }) {
  const box = $('[data-combobox]', root);
  if (!box) return;
  const input = $('.nxs-input', box);
  const pop = $('.nxs-pop', box);
  const list = $('.nxs-list', box);
  const foot = $('.nxs-foot', box);

  const online = heatmapRoster.filter((p) => p.status && p.status !== 'offline');
  const offline = heatmapRoster.filter((p) => !p.status || p.status === 'offline');
  const GROUPS = [
    { label: '', items: [EVERYONE] },
    { label: 'Online now', items: online },
    { label: 'Everyone else', items: offline },
  ].filter((g) => g.items.length);
  // Precompute search keys once; re-folding 411 names on every keystroke is
  // exactly the kind of thing that makes a "fast" filter feel sticky.
  const KEYS = new Map(
    heatmapRoster.concat([EVERYONE]).map((p) => [p.id, fold(`${p.displayName} ${p.handle} ${p.source}`)]),
  );

  // High enough that a normal roster renders whole (so End really does reach
  // the last friend and scrolling is a valid way to browse), low enough that a
  // pathological one can't stall a keystroke.
  const MAX_RENDER = 600;
  let open = false;
  let active = -1;     // index into `flat`
  let flat = [];       // the currently rendered options, in visual order
  let committed = heatmapPerson;

  const labelFor = (id) => optionLabel(id === '' ? EVERYONE : heatmapRoster.find((p) => p.id === id) || EVERYONE);

  function build(query) {
    const q = fold(query).trim();
    flat = [];
    let html = '';
    let hidden = 0;
    for (const g of GROUPS) {
      const items = q ? g.items.filter((p) => KEYS.get(p.id)?.includes(q)) : g.items;
      if (!items.length) continue;
      const shown = items.slice(0, Math.max(0, MAX_RENDER - flat.length));
      hidden += items.length - shown.length;
      if (!shown.length) { hidden += items.length; continue; }
      let opts = '';
      for (const p of shown) {
        const i = flat.length;
        flat.push(p);
        const n = nameCell(p.displayName);
        const live = p.status && p.status !== 'offline' ? '<span class="nxs-dot" aria-hidden="true"></span>' : '';
        opts += `<div class="nxs-opt" id="${HM_SELECT_ID}-o${i}" role="option" data-i="${i}"` +
          ` aria-selected="${p.id === committed ? 'true' : 'false'}"` +
          ` data-active="false"${n.title}>` +
          `${live}<span class="nxs-opt-name t-clip">${p.id === '' ? esc(p.displayName) : n.html}</span>` +
          `${p.source ? `<span class="nxs-opt-sub">${esc(p.source)}</span>` : ''}` +
          `</div>`;
      }
      html += g.label
        ? `<div class="nxs-group" role="group" aria-label="${esc(g.label)}"><span class="nxs-grouphead" aria-hidden="true">${esc(g.label)}</span>${opts}</div>`
        : `<div class="nxs-group">${opts}</div>`;
    }
    list.innerHTML = html || `<div class="nxs-empty">No friend matches “${esc(safeName(query, 24))}”.</div>`;
    // "Everyone" is a mode, not a friend — don't count it in the tally.
    const nFriends = flat.filter((p) => p.id !== '').length;
    foot.textContent = nFriends
      ? `${nFriends}${hidden ? ` of ${nFriends + hidden}` : ''} ${nFriends === 1 ? 'friend' : 'friends'}${hidden ? ' · keep typing to narrow' : ''}`
      : 'No matches — clear the box to see everyone.';
    setActive(flat.length ? 0 : -1, false);
  }

  function setActive(i, scroll = true) {
    active = i;
    for (const el of list.querySelectorAll('.nxs-opt')) el.dataset.active = 'false';
    if (i < 0) { input.removeAttribute('aria-activedescendant'); return; }
    const el = list.querySelector(`[data-i="${i}"]`);
    if (!el) { input.removeAttribute('aria-activedescendant'); return; }
    el.dataset.active = 'true';
    input.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function openPop(query) {
    if (!open) { open = true; pop.hidden = false; box.dataset.open = 'true'; input.setAttribute('aria-expanded', 'true'); }
    build(query ?? '');
  }
  function closePop(restoreLabel = true) {
    if (!open) return;
    open = false;
    pop.hidden = true;
    box.dataset.open = 'false';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (restoreLabel) input.value = labelFor(committed);
  }
  function commit(i) {
    const p = flat[i];
    if (!p) return;
    committed = p.id;
    input.value = labelFor(p.id);
    closePop(false);
    onChange(p.id);
  }

  input.addEventListener('input', () => openPop(input.value));
  input.addEventListener('focus', () => input.select());
  input.addEventListener('pointerdown', () => { if (!open) openPop(''); });

  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) { openPop(''); return; }
        setActive(flat.length ? (active + 1) % flat.length : -1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) { openPop(''); setActive(flat.length - 1); return; }
        setActive(flat.length ? (active - 1 + flat.length) % flat.length : -1);
        return;
      case 'Home':
        if (!open) return;
        e.preventDefault();
        setActive(flat.length ? 0 : -1);
        return;
      case 'End':
        if (!open) return;
        e.preventDefault();
        setActive(flat.length - 1);
        return;
      case 'Enter':
        if (!open) { e.preventDefault(); openPop(''); return; }
        e.preventDefault();
        commit(active);
        return;
      case 'Escape':
        if (open) { e.preventDefault(); e.stopPropagation(); closePop(); }
        return;
      case 'Tab':
        closePop();   // Tab is never trapped; it just dismisses the popup
        return;
      default:
    }
  });

  // pointerdown, not click: mousedown would blur the input and close the popup
  // out from under the click.
  list.addEventListener('pointerdown', (e) => {
    const opt = e.target.closest('.nxs-opt');
    if (!opt) return;
    e.preventDefault();
    commit(Number(opt.dataset.i));
  });
  box.addEventListener('focusout', () => {
    // let focus land before deciding; a click inside the popup keeps it open
    setTimeout(() => { if (!box.contains(document.activeElement)) closePop(); }, 0);
  });

  return { focus: () => input.focus() };
}

function cellStyle(v, max) {
  if (!v || max <= 0) return '--cell:rgba(255,255,255,0.022)';
  const t = v / max;
  const a = (0.1 + t * 0.82).toFixed(3);
  // violet body; the strongest cells pick up a touch of cyan light-in-material.
  const cyan = t > 0.72 ? `,inset 0 0 7px -1px rgba(0,229,255,${(0.5 * (t - 0.72) / 0.28).toFixed(2)})` : '';
  return `--cell:rgba(126,12,255,${a});box-shadow:inset 0 0 0 1px rgba(255,255,255,0.03)${cyan}`;
}

function heatTable(grid, max) {
  // Every third hour is labelled; the rest keep their column so the table's
  // fixed layout stays a clean 24 equal tracks at any width.
  const hourHead = ['<th scope="col"><span class="sr-only">Day</span></th>']
    .concat(Array.from({ length: 24 }, (_, h) => `<th class="hm-hour" scope="col">${h % 3 === 0 ? pad(h) : ''}</th>`))
    .join('');
  const rows = grid
    .map((row, d) => {
      const cells = asArray(row)
        .map((v, h) => `<td class="hm-cell" data-v="${v}" style="${cellStyle(v, max)}" title="${WEEK[d] || ''} ${pad(h)}:00 — ${v} overlapping ${v === 1 ? 'hour' : 'hours'}" tabindex="0"></td>`)
        .join('');
      return `<tr><td class="hm-daylabel" scope="row">${WEEK[d] || ''}</td>${cells}</tr>`;
    })
    .join('');
  return `<table class="hm-table"><caption class="sr-only">Overlapping hours by weekday and hour of day</caption><thead><tr>${hourHead}</tr></thead><tbody>${rows}</tbody></table>`;
}

/* A cell counts the distinct DATES on which both people were online during that
   weekday-hour, so for one friend the unit really is "hours you two were both
   on". The aggregate grid sums that across friends, and calling those "hours"
   would overstate it by an order of magnitude — 2966 is friend-hours, not 2966
   hours of anyone's life. The caption names the unit it is actually showing. */
function heatLegend(max, { isAggregate = true, who = 'your circle', friendsConsidered } = {}) {
  const steps = [0, 0.25, 0.5, 0.75, 1];
  const swatches = steps.map((t) => `<i style="background:${t === 0 ? 'rgba(255,255,255,0.03)' : `rgba(126,12,255,${(0.1 + t * 0.82).toFixed(2)})`}"></i>`).join('');
  const across = typeof friendsConsidered === 'number' && friendsConsidered > 1
    ? `, across ${esc(friendsConsidered)} friends`
    : '';
  const caption = isAggregate
    ? `peak ${esc(max)} friend-hours of overlap in one weekday-hour${across}`
    : `peak ${esc(max)} hours you and ${esc(safeName(who, 22))} were both online in one weekday-hour`;
  // Ramp and caption are separate flex children so the row can WRAP instead of
  // pushing the caption out through the side of the panel.
  return `<div class="hm-legend">
      <span class="hm-ramp"><span>Less</span><span class="ramp" aria-hidden="true">${swatches}</span><span>More</span></span>
      <span class="hm-caption">${caption}</span>
    </div>`;
}

/* =====================================================================
   VIEW 3 — PEOPLE
   ===================================================================== */
let peopleFilter = '';
async function viewPeople() {
  const list = asArray(await orbit.people.list(peopleFilter ? { q: peopleFilter } : {}));
  // view-fill: the header and search box hold still and the 411-row list gets
  // its own scroller, instead of the whole view scrolling away under the caret.
  return `
    <div class="view view-fill">
      <div class="view-head">
        <div>
          <h1 class="view-title">People</h1>
          <p class="view-sub">Everyone across your sources. Click a person for their card — your notes, their shared birthday, their timeline.</p>
        </div>
      </div>
      <div class="people-toolbar">
        <div class="search-wrap">${I.search}<input type="search" id="people-search" placeholder="Search name, handle, source, note…" value="${esc(peopleFilter)}" autocomplete="off" spellcheck="false" aria-label="Search people" /></div>
        <span class="micro" data-people-count>${list.length} ${list.length === 1 ? 'person' : 'people'}</span>
      </div>
      <div class="people-host" data-people-host>${peopleListHtml(list)}</div>
    </div>`;
}

function peopleListHtml(list) {
  return list.length
    ? `<div class="people-list">${list.map(personRow).join('')}</div>`
    : emptyState('No matches', 'Nobody matches that. Clear the search, or add someone by hand from the Add view.');
}

function personRow(p) {
  const n = nameCell(p.displayName);
  const note = p.note ? `<span class="pr-note t-clip" title="${esc(p.note)}">${esc(p.note)}</span>` : '';
  const liveChip = p.status && p.status !== 'offline' ? '<span class="chip live"><span class="cdot"></span>On</span>' : '';
  return `
    <button class="person-row" data-open="${esc(p.id)}" aria-label="Open ${esc(n.full)}">
      ${avatar(p, 'sm')}
      <span class="pr-name"><b class="t-clip"${n.title}>${n.html}</b><small class="t-clip">@${esc(p.handle)}</small></span>
      ${note}
      ${liveChip}
      ${srcBadge(p.source)}
    </button>`;
}

/* =====================================================================
   VIEW 4 — CHANGES
   ===================================================================== */
// A 411-person roster produces ~900 change rows. Painting all of them costs a
// visible beat on first render and buys nothing — nobody reads past the first
// few days. Page it, and say plainly how much is being held back.
const CHANGES_PAGE = 150;
let changesShown = CHANGES_PAGE;

async function viewChanges() {
  const feed = asArray(await orbit.digest.changeFeed());
  if (!feed.length) {
    return `<div class="view"><div class="view-head"><div><h1 class="view-title">What changed</h1></div></div>${emptyState('Nothing new', 'Name, bio and avatar changes your friends made will collect here, newest first.')}</div>`;
  }
  const shown = feed.slice(0, changesShown);
  const remaining = feed.length - shown.length;
  // group by day, reverse-chron
  const groups = [];
  let cur = null;
  for (const it of shown) {
    const k = dayKey(it.ts);
    if (!cur || cur.k !== k) { cur = { k, ts: it.ts, items: [] }; groups.push(cur); }
    cur.items.push(it);
  }
  const body = groups
    .map(
      (g) => `
      <div class="feed-day">
        <div class="fd-label">${sectionLabelInline(fmtDayLabel(g.ts))}</div>
        ${g.items.map(feedItem).join('')}
      </div>`,
    )
    .join('');
  const more = remaining
    ? `<div class="feed-more"><button class="btn sm" data-changes-more>Show ${Math.min(remaining, CHANGES_PAGE)} earlier changes<span class="hint" style="margin-left:6px">${remaining} left</span></button></div>`
    : '';
  return `
    <div class="view feed">
      <div class="view-head">
        <div>
          <h1 class="view-title">What changed</h1>
          <p class="view-sub">Name, bio and avatar changes since you last looked — the same things the apps already showed you, gathered in one place.</p>
        </div>
      </div>
      ${body}
      ${more}
    </div>`;
}
function sectionLabelInline(text) {
  return `<div class="section-label" style="margin:0"><span class="micro">${esc(text)}</span><span class="rule"></span></div>`;
}
function feedItem(it) {
  const verb = { bio: 'updated their bio', nick: 'changed their name', avatar: 'changed their avatar', friend: it.meta?.became ? 'became your friend' : 'is no longer a friend' }[it.kind] || 'changed';
  const n = nameCell(it.person?.displayName ?? 'Someone');
  let detail = '';
  if (it.kind === 'bio' && it.text) detail = `“${esc(it.text)}”`;
  else if (it.kind === 'nick' && it.meta?.from) detail = `was @${esc(it.meta.from)}`;
  return `
    <button class="feed-item" data-open="${esc(it.person?.id ?? '')}">
      <span class="fi-ico">${OBS_ICON[it.kind] || I.status}</span>
      <span class="fi-body">
        <span class="fi-line"><b${n.title}>${n.html}</b> ${esc(verb)} ${srcBadge(it.person?.source ?? '')}</span>
        ${detail ? `<span class="fi-detail">${detail}</span>` : ''}
      </span>
      <span class="fi-when">${esc(relTime(it.ts))}</span>
    </button>`;
}

/* =====================================================================
   VIEW 5 — ADD / MANUAL
   ===================================================================== */
async function viewAdd() {
  const canAdd = typeof orbit.people.addManual === 'function';
  const degraded = canAdd
    ? ''
    : `<div class="form-note">${I.info}<span>The core build behind this window doesn’t expose a manual-add channel yet, so this form is read-only. When it does (<code class="mono">orbit.people.addManual</code>), it lights up here.</span></div>`;
  return `
    <div class="view">
      <div class="view-head">
        <div>
          <h1 class="view-title">Add someone by hand</h1>
          <p class="view-sub">The personal-CRM path — for a friend no source knows about, or a birthday someone told you in person. Everything you type stays on this machine.</p>
        </div>
      </div>
      <div class="card form-card">
        <div class="field">
          <label for="add-name">Name</label>
          <input type="text" id="add-name" placeholder="e.g. Robin" autocomplete="off" ${canAdd ? '' : 'disabled'} />
        </div>
        <div class="field">
          <label for="add-bday">Birthday <span class="hint">optional · MM-DD, no year unless you want one</span></label>
          <input type="text" id="add-bday" placeholder="08-24" inputmode="numeric" autocomplete="off" ${canAdd ? '' : 'disabled'} />
        </div>
        <div class="field">
          <label for="add-note">Your note <span class="hint">optional · “met at …”, not a dossier</span></label>
          <textarea id="add-note" placeholder="Met at Framework’s world, likes DnB." ${canAdd ? '' : 'disabled'}></textarea>
        </div>
        <div class="form-actions">
          <button class="btn primary" data-add-submit ${canAdd ? '' : 'disabled'}>Add person</button>
        </div>
        ${degraded}
        <div class="form-note">${I.lock}<span>Manual people are marked <b>Manual</b> and are yours alone. Forgetting one removes every row about them, immediately.</span></div>
      </div>
    </div>`;
}

/* =====================================================================
   VIEW 6 — SOURCES + SETTINGS
   ===================================================================== */
async function viewSources() {
  const [list, settings] = await Promise.all([orbit.sources.status(), orbit.settings.get()]);
  const rows = asArray(list).map(srcRow).join('');
  const s = settings || {};
  return `
    <div class="view">
      <div class="view-head">
        <div>
          <h1 class="view-title">Sources</h1>
          <p class="view-sub">Each source turns one place you already have an account into records. Orbit only ever reads what you can already see as a logged-in friend.</p>
        </div>
      </div>
      <div class="local-banner">${I.lock}<span><b>Local only.</b> No server, no sync, no telemetry. The database lives on your disk; the only network Orbit makes is a plugin reading its own already-local source.</span></div>
      <div class="src-list">${rows || emptyState('No sources yet', 'Enable a plugin and it will report here after its first run.')}</div>

      ${sectionLabel('Ingest')}
      <div class="card src-panel">
        <dl class="kv">
          <dt>Loopback ingest port</dt>
          <dd><span class="mono">127.0.0.1:${esc(s.ingestPort ?? '—')}</span> <span class="hint">bound to loopback only</span></dd>
          <dt>Writing a source?</dt>
          <dd>See <a href="../../docs/PLUGIN_GUIDELINES.md">docs/PLUGIN_GUIDELINES.md</a> — the five-rule contract every plugin obeys.</dd>
        </dl>
      </div>

      ${sectionLabel('Settings')}
      <div class="card src-panel">
        <div class="field">
          <label for="set-retention">Retention <span class="hint">forgetting is a feature — raw events older than this are pruned on a rolling window</span></label>
          <div style="display:flex;align-items:center;gap:10px;max-width:320px">
            <input type="number" id="set-retention" min="7" max="3650" value="${esc(s.retentionDays ?? 365)}" />
            <span class="micro" style="white-space:nowrap">days</span>
            <button class="btn sm" data-save-retention>Save</button>
          </div>
        </div>
      </div>
    </div>`;
}

function srcRow(s) {
  const dot = s.lastOk ? '#00e5ff' : '#ff5470';
  const stateChip = s.lastOk ? '<span class="chip ok"><span class="cdot"></span>OK</span>' : '<span class="chip warn">Last run failed</span>';
  const label = { vrcx: 'VRCX', 'vencord-orbit-bridge': 'Vencord bridge', 'twitter-orbit': 'twitter-orbit', manual: 'Manual (you)' }[s.plugin] || s.plugin;
  const n = s.nPersons ?? 0;
  return `
    <div class="card src-row">
      <span class="src-ico">${I.sources}<span class="sdot" style="background:${dot}"></span></span>
      <div class="src-body">
        <b>${esc(label)}</b>
        <div class="src-meta">${n} ${n === 1 ? 'person' : 'people'} · last run ${s.lastRun ? esc(relTime(s.lastRun)) : 'never'}</div>
      </div>
      ${stateChip}
      <button class="btn sm" data-run="${esc(s.plugin)}">Run now</button>
    </div>`;
}

/* ------------------------------------------------- empty / loading / error */
function emptyState(title, body) {
  return `<div class="empty"><b>${esc(title)}</b><p>${esc(body)}</p></div>`;
}
function loadingState() {
  return `
    <div class="view loading" aria-busy="true" aria-label="Loading">
      <div class="sk sk-title"></div>
      <div class="sk sk-sub"></div>
      <div class="sk-grid">${'<div class="sk sk-card"></div>'.repeat(6)}</div>
    </div>`;
}
function errorState(err) {
  return `
    <div class="view">
      <div class="error-state">
        <span class="es-ico">${I.warn}</span>
        <b>That view could not load</b>
        <p>${esc(err?.message || 'The core did not answer.')} Nothing was changed — your data is untouched on disk.</p>
        <button class="btn sm" data-retry>Try again</button>
      </div>
    </div>`;
}

/* =====================================================================
   PERSON SHEET (tier 2 slide-over)
   ===================================================================== */
async function openPerson(id) {
  if (!id) return;
  let data;
  try {
    data = await orbit.people.get(id);
  } catch (err) {
    toast(`Could not open that person — ${err?.message || 'the core did not answer.'}`, 'danger');
    return;
  }
  if (!data || !data.person) {
    toast('That person is no longer in your roster.', 'warn');
    return;
  }
  const { person } = data;
  const timeline = asArray(data.timeline);

  const root = $('#sheet-root');
  root.innerHTML = await personSheet(person, timeline);

  const scrim = $('.scrim', root);
  const closeAll = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') closeAll(); };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', closeAll);
  $('.sheet-close', root).addEventListener('click', closeAll);
  $('.sheet-close', root).focus();

  // note editor
  const noteEl = $('#pc-note', root);
  const saveNote = $('[data-save-note]', root);
  noteEl.addEventListener('input', () => { saveNote.disabled = noteEl.value === (person.note || ''); });
  saveNote.addEventListener('click', async () => {
    saveNote.disabled = true;
    try {
      await orbit.people.setNote(id, noteEl.value);
      toast('Note saved — on this machine only.', 'ok');
    } catch (err) {
      saveNote.disabled = false;
      toast(`Could not save the note — ${err?.message || 'the core did not answer.'}`, 'danger');
    }
  });

  // forget (confirm)
  $('[data-forget]', root).addEventListener('click', () => confirmForget(person, closeAll));
}

async function personSheet(p, timeline) {
  const h = hueOf(p.id || p.displayName || 'x');

  // The birthday label is local arithmetic on p.birthday — no second query.
  let bdayHtml = `<p class="pc-none">No birthday shared. VRChat and X don’t expose this — add it from the Add view if a friend tells you.</p>`;
  if (p.birthday) {
    const away = daysUntilBirthday(p.birthday);
    const label = away === null ? '' : away === 0 ? 'today' : away === 1 ? 'tomorrow' : `in ${away} days`;
    const soon = away !== null && away <= 7;
    bdayHtml = `<div class="pc-birthday">${I.cake}<span>${esc(p.birthday)}${label ? ` · <span class="${soon ? 'amber' : ''}">${esc(label)}</span>` : ''}</span></div>`;
  }

  const status = p.statusText
    ? `<div class="pc-status">${esc(p.statusText)}</div>`
    : `<p class="pc-none">No status text set.</p>`;

  const mini = await miniHeat(p.id);

  return `
    <div class="scrim"></div>
    <aside class="sheet" role="dialog" aria-modal="true" aria-label="${esc(fullName(p.displayName))}">
      <button class="sheet-close" aria-label="Close">${I.close}</button>
      <div class="sheet-head">
        <span class="avatar lg" style="--h:${h}" aria-hidden="true">${esc(initials(p.displayName))}${p.status && p.status !== 'offline' ? '<span class="live"></span>' : ''}</span>
        <div class="pc-idblock">
          <h2>${esc(fullName(p.displayName))}</h2>
          <div class="pc-handle">@${esc(p.handle)}${p.pronouns ? ` · ${esc(p.pronouns)}` : ''}</div>
          <div class="pc-idrow">${srcBadge(p.source)}${p.status && p.status !== 'offline' ? '<span class="chip live"><span class="cdot"></span>Online now</span>' : `<span class="chip off">${p.lastSeen ? `Seen ${esc(relTime(p.lastSeen))}` : 'Offline'}</span>`}</div>
        </div>
      </div>
      <div class="sheet-body">
        <div class="pc-section"><span class="micro">Status</span>${status}</div>
        <div class="pc-section"><span class="micro">Birthday</span>${bdayHtml}</div>
        ${p.bio ? `<div class="pc-section"><span class="micro">Their bio</span><div class="pc-status">${esc(p.bio)}</div></div>` : ''}

        <div class="pc-section">
          <span class="micro">Your note <span class="hint" style="text-transform:none;letter-spacing:0">· private, never inferred</span></span>
          <textarea id="pc-note" placeholder="Met at Framework’s world, likes DnB.">${esc(p.note || '')}</textarea>
          <div style="margin-top:8px"><button class="btn sm" data-save-note disabled>Save note</button></div>
        </div>

        <div class="pc-section">
          <span class="micro">When you overlap</span>
          ${mini}
        </div>

        <div class="pc-section">
          <span class="micro">Timeline</span>
          ${timeline.length ? `<div class="timeline">${timeline.map(tlItem).join('')}</div>` : '<p class="pc-none">No observations recorded yet.</p>'}
        </div>

        <div class="danger-zone">
          <p>Forgetting is a feature. This hard-deletes every row about ${esc(safeName(p.displayName, 28))} across all sources, immediately — not a hide, a delete.</p>
          <button class="btn danger sm" data-forget>Forget this person</button>
        </div>
      </div>
    </aside>`;
}

async function miniHeat(id) {
  let hm;
  try {
    hm = await orbit.digest.heatmap(id);
  } catch {
    return '<p class="pc-none">Overlap history unavailable.</p>';
  }
  const grid = Array.isArray(hm?.grid) ? hm.grid : [];
  if (!grid.length) return '<p class="pc-none">No overlapping hours recorded yet.</p>';
  const max = typeof hm?.max === 'number' ? hm.max : 0;
  const rows = grid
    .map((row) => `<tr>${asArray(row).map((v) => `<td style="${cellStyle(v, max)}"></td>`).join('')}</tr>`)
    .join('');
  return `<div class="hm-scroll"><table class="mini-hm"><tbody>${rows}</tbody></table></div><div class="hint" style="margin-top:6px">7 days × 24 hours of past overlap — same histogram, in miniature.</div>`;
}

function tlItem(e) {
  let line = '';
  if (e.kind === 'presence') line = `Went <span class="tl-em">${esc(e.status)}</span>${e.place ? ` in ${esc(e.place)}` : ''}`;
  else if (e.kind === 'status') line = `Status: <span class="tl-em">${esc(e.text || e.status)}</span>`;
  else if (e.kind === 'location') line = `Entered <span class="tl-em">${esc(e.place)}</span>`;
  else if (e.kind === 'bio') line = `Bio changed${e.text ? ` — “${esc(e.text)}”` : ''}`;
  else if (e.kind === 'nick') line = `Renamed to <span class="tl-em">${esc(e.text)}</span>${e.meta?.from ? ` (was @${esc(e.meta.from)})` : ''}`;
  else if (e.kind === 'avatar') line = 'Changed avatar';
  else if (e.kind === 'friend') line = e.meta?.became ? 'Became your friend' : 'Stopped being a friend';
  else line = esc(e.kind);
  return `
    <div class="tl-item">
      <span class="tl-dot">${OBS_ICON[e.kind] || I.status}</span>
      <div class="tl-body"><div class="tl-line">${line}</div><div class="tl-when">${esc(fmtDate(e.ts))} · ${esc(fmtTime(e.ts))} · ${esc(relTime(e.ts))}</div></div>
    </div>`;
}

function confirmForget(person, afterClose) {
  const root = $('#sheet-root');
  const holder = document.createElement('div');
  holder.innerHTML = `
    <div class="scrim" style="z-index:49"></div>
    <div class="confirm" role="dialog" aria-modal="true" aria-label="Forget ${esc(fullName(person.displayName))}">
      <h3>Forget ${esc(safeName(person.displayName, 32))}?</h3>
      <p>Every row about them — presence, status, birthday, your note — is deleted across all sources, immediately and permanently. This can’t be undone.</p>
      <div class="form-actions">
        <button class="btn ghost sm" data-cancel>Keep</button>
        <button class="btn danger sm" data-confirm>Forget them</button>
      </div>
    </div>`;
  root.appendChild(holder);
  const cleanup = () => holder.remove();
  $('[data-cancel]', holder).addEventListener('click', cleanup);
  $('.scrim', holder).addEventListener('click', cleanup);
  const go = $('[data-confirm]', holder);
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await orbit.people.forget(person.id);
      cleanup();
      afterClose();
      toast(`${safeName(person.displayName, 28)} was forgotten — every row gone.`, 'ok');
      render();
    } catch (err) {
      go.disabled = false;
      toast(`Could not forget them — ${err?.message || 'the core did not answer.'}`, 'danger');
    }
  });
  go.focus();
}

/* ---------------------------------------------------------------- toasts */
function toast(msg, kind = '') {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity 200ms'; el.style.opacity = '0'; setTimeout(() => el.remove(), 220); }, 3600);
}

/* =====================================================================
   ROUTER + wiring
   ===================================================================== */
const VIEWS = { now: viewNow, heatmap: viewHeatmap, people: viewPeople, changes: viewChanges, add: viewAdd, sources: viewSources };
let current = 'now';
// Guards against a slow query from an abandoned view painting over a newer one.
let renderToken = 0;

let renderedView = null;
async function render() {
  const token = ++renderToken;
  const fn = VIEWS[current] || viewNow;
  // Re-rendering the SAME view (picked a friend, loaded another page of
  // changes) must not throw you back to the top of a long list.
  const keepScroll = renderedView === current ? main.scrollTop : 0;
  // Only show the skeleton if the query is actually slow — avoids a flash.
  const slow = setTimeout(() => { if (token === renderToken) main.innerHTML = loadingState(); }, 120);
  try {
    const html = await fn();
    clearTimeout(slow);
    if (token !== renderToken) return; // a newer render already won
    main.innerHTML = html;
    main.scrollTop = keepScroll;
    renderedView = current;
    wireView();
  } catch (err) {
    clearTimeout(slow);
    if (token !== renderToken) return;
    console.error('[orbit] view failed:', err);
    main.innerHTML = errorState(err);
    const retry = $('[data-retry]', main);
    if (retry) retry.addEventListener('click', () => render());
    toast(`Could not load that view — ${err?.message || 'the core did not answer.'}`, 'danger');
  }
  updateRailFoot();
}

async function updateRailFoot() {
  const el = $('#rail-online');
  if (!el) return;
  try {
    const now = await orbit.digest.whoIsOnNow();
    const n = typeof now?.count === 'number' ? now.count : asArray(now?.people).length;
    el.textContent = `${n} online now`;
  } catch {
    el.textContent = '— offline';
  }
}

function setView(v) {
  if (!VIEWS[v]) return;
  if (v !== current) changesShown = CHANGES_PAGE; // a fresh visit starts at page 1
  current = v;
  rail.querySelectorAll('.rail-item').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === v ? 'true' : 'false'));
  render();
}

// Populate the rail icons once.
rail.querySelectorAll('.ri-ico').forEach((el) => { el.innerHTML = I[el.dataset.ico] || ''; });

// Rail navigation.
rail.addEventListener('click', (e) => {
  const item = e.target.closest('.rail-item');
  if (item) setView(item.dataset.view);
});
rail.addEventListener('keydown', (e) => {
  const items = [...rail.querySelectorAll('.rail-item')];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});

// Per-view wiring (event delegation kept local to what each view needs).
let searchToken = 0;
function wireView() {
  // open person from any [data-open]
  main.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openPerson(el.dataset.open)));

  if (current === 'heatmap') {
    const combo = wireCombobox(main, {
      onChange: (id) => {
        heatmapPerson = id;
        refocusHmSelect = true;   // the view repaints; put the caret back
        render();
      },
    });
    if (combo && refocusHmSelect) { refocusHmSelect = false; combo.focus(); }
  }

  if (current === 'people') {
    const s = $('#people-search', main);
    if (s) {
      s.addEventListener('input', async () => {
        peopleFilter = s.value;
        const token = ++searchToken;
        let list;
        try {
          list = asArray(await orbit.people.list(peopleFilter ? { q: peopleFilter } : {}));
        } catch (err) {
          toast(`Search failed — ${err?.message || 'the core did not answer.'}`, 'danger');
          return;
        }
        if (token !== searchToken) return; // a later keystroke already answered
        // Repaint only the list region so focus stays in the field.
        const host = $('[data-people-host]', main);
        if (!host) return;
        host.innerHTML = peopleListHtml(list);
        host.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openPerson(el.dataset.open)));
        const count = $('[data-people-count]', main);
        if (count) count.textContent = `${list.length} ${list.length === 1 ? 'person' : 'people'}`;
      });
    }
  }

  if (current === 'changes') {
    const more = $('[data-changes-more]', main);
    if (more) more.addEventListener('click', () => { changesShown += CHANGES_PAGE; render(); });
  }

  if (current === 'add') {
    const submit = $('[data-add-submit]', main);
    if (submit && !submit.disabled) {
      submit.addEventListener('click', async () => {
        const name = $('#add-name', main).value.trim();
        const bday = $('#add-bday', main).value.trim();
        const note = $('#add-note', main).value.trim();
        if (!name) { toast('Give them a name first.', 'warn'); $('#add-name', main).focus(); return; }
        if (bday && !/^\d{2}-\d{2}(-\d{2,4})?$/.test(bday)) { toast('Birthday should look like 08-24 (MM-DD).', 'warn'); return; }
        submit.disabled = true;
        try {
          // Real core returns the created person object.
          const created = await orbit.people.addManual({ displayName: name, birthday: bday || null, note });
          if (!created) throw new Error('the core did not return the new person');
          toast(`Added ${safeName(created.displayName || name, 28)}. It’s yours, on this machine only.`, 'ok');
          peopleFilter = ''; // don't let a stale search hide who you just added
          setView('people');
        } catch (err) {
          submit.disabled = false;
          toast(`Could not add them — ${err?.message || 'the core did not answer.'}`, 'danger');
        }
      });
    }
  }

  if (current === 'sources') {
    main.querySelectorAll('[data-run]').forEach((b) =>
      b.addEventListener('click', async () => {
        const plugin = b.dataset.run;
        b.disabled = true;
        b.textContent = 'Running…';
        try {
          await orbit.sources.runNow(plugin);
          toast(`Ran ${plugin} — reading its own local source.`, 'ok');
          render();
        } catch (err) {
          b.disabled = false;
          b.textContent = 'Run now';
          toast(`${plugin} could not run — ${err?.message || 'the core did not answer.'}`, 'danger');
        }
      }),
    );
    const save = $('[data-save-retention]', main);
    if (save) save.addEventListener('click', async () => {
      const v = Math.max(7, Math.min(3650, parseInt($('#set-retention', main).value, 10) || 365));
      save.disabled = true;
      try {
        await orbit.settings.set({ retentionDays: v });
        toast(`Retention set to ${v} days. Older raw events prune on a rolling window.`, 'ok');
      } catch (err) {
        toast(`Could not save that — ${err?.message || 'the core did not answer.'}`, 'danger');
      } finally {
        save.disabled = false;
      }
    });
  }
}

/* ------------------------------------------ pointer-bound specular sheen */
// One rAF-throttled listener writes --mx on the interactive card under the
// pointer, so the highlight slides WITH the cursor (DESIGN "light rides
// motion"), never a timed flash. Frozen under reduced motion (CSS hides it).
let rafPending = false;
let lastEvt = null;
document.addEventListener('pointermove', (e) => {
  lastEvt = e;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const card = lastEvt.target.closest?.('.card.interactive');
    if (!card) return;
    const r = card.getBoundingClientRect();
    const mx = Math.max(0, Math.min(1, (lastEvt.clientX - r.left) / r.width));
    card.style.setProperty('--mx', mx.toFixed(3));
  });
}, { passive: true });

/* --------------------------------------------- park the sky when hidden */
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('sky-parked', document.hidden);
});

/* ------------------------------------------------------------- keyboard */
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement === document.body && current === 'people') {
    const s = $('#people-search', main);
    if (s) { e.preventDefault(); s.focus(); }
  }
});

/* --------------------------------------------------------------- boot */
// A bridge that never arrived is a real failure mode in Electron — say so
// instead of throwing into a blank window.
if (!orbit || !orbit.digest || !orbit.people) {
  main.innerHTML = `<div class="view">${errorState(new Error('The orbit bridge is not available — the preload did not load.'))}</div>`;
} else {
  render();
}
