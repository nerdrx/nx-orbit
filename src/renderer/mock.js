// NX Orbit — standalone mock of the window.orbit bridge (SPEC §6).
//
// Installed ONLY when window.orbit is missing — i.e. the renderer was opened in
// a plain browser with no Electron main process behind it. app.js imports this
// module first (for its side effect) so the UI can be driven and screenshotted
// on its own.
//
// CONTRACT FIDELITY IS THE POINT. The real bridge is `ipcRenderer.invoke(...)`
// in preload.cjs, so EVERY method returns a Promise. This mock does the same,
// with a small artificial delay, so loading states and render races are
// actually exercised here instead of blowing up in Electron. A mock that
// resolves synchronously would lie about the contract — that lie is precisely
// what let an "await-less" renderer pass verification and then fail against the
// real core. If you add a method, add it async.
//
// SIZE FIDELITY IS ALSO THE POINT. This mock used to hold a dozen tidy friends
// with tidy ASCII names, and that politeness hid four real layout bugs (ragged
// card widths, a heatmap that ran off the viewport, views that didn't fill the
// window, an unusable 400-entry <select>). It now reproduces the shape of a real
// roster: ~411 people, ~45 online, arbitrary Unicode display names — CJK, RTL,
// combining-mark stacks, emoji strings, decorated fullwidth "clan tag" names —
// long statuses, long bios, and enough presence history to fill the heatmap.
//
// The data is deliberately tasteful and privacy-respecting in flavour: friends
// waving, birthdays, a couple of people on holiday — never targets.
//
// Nothing in this file runs when a real bridge is present.

if (!window.orbit) {
  // -- a tiny seeded PRNG so the "history" is stable across reloads ----------
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  const DAY = 86400000;
  const HOUR = 3600000;
  // Frozen "now" so the mock reads identically every load (2026-08-20, a Thu).
  const NOW = new Date('2026-08-20T21:12:00').getTime();

  // Locale-independent sort key (DESIGN §7 — the host may run any locale, so
  // `localeCompare` would order 411 names differently on a de_DE box than on a
  // C-locale CI runner). Strip combining marks and decoration, fold case, and
  // compare the residue; ties break on id so the order is total and stable.
  function sortKey(name) {
    return String(name || '')
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, '')
      .toLowerCase();
  }

  /* ===================================================================
     NAME GENERATION
     Real friend lists are not tidy. Roughly a fifth of these names would
     break a naive layout: 60+ visible characters, wide CJK glyphs that are
     ~2× an ASCII advance, stacked combining marks, embedded bidi controls,
     grapheme clusters made of ZWJ emoji sequences.
     =================================================================== */

  // Built from escapes rather than pasted literals so the file survives any
  // editor/encoding round-trip.
  const COMBINING = ['̀', '́', '̂', '̃', '̈', '̊', '̧', '̩', '̰', '͓', 'ͤ', '͛'];
  function zalgofy(base, depth, rnd) {
    let out = '';
    for (const ch of base) {
      out += ch;
      if (ch === ' ') continue;
      const n = Math.floor(rnd() * depth);
      for (let i = 0; i < n; i++) out += COMBINING[Math.floor(rnd() * COMBINING.length)];
    }
    return out;
  }
  const zrnd = mulberry32(0x5eed1);

  // Curated pathological names — every one of these is the kind of thing that
  // actually turns up in a real VRChat/Discord roster. Written as \uXXXX
  // escapes rather than pasted glyphs so the file stays byte-stable through any
  // editor, patch tool or checkout that is unsure about UTF-8.
  const HARD_NAMES = [
    // ༻༒₦ɆƁUⱠ₳₦₳U₮༒༺ — Tibetan brackets around currency-symbol letterforms.
    // Invented, like every name in this file: mock data must never contain a
    // real person lifted from someone's actual friends list.
    { handle: 'nebulanaut',  displayName: '༻༒₦ɆƁUⱠ₳₦₳U₮༒༺' },
    // ✟ANNI✟
    { handle: 'anni',        displayName: '✟ANNI✟' },
    { handle: 'rooftopdj',   displayName: 'xX_the_one_and_only_starlit_terrace_dj_who_absolutely_never_sleeps_Xx' },
    // wide CJK + kana + latin in one name
    { handle: 'yukikaze',    displayName: '雪風・ゆきかぜ・Snow Wind' },
    // long Hangul with no spaces to break on
    { handle: 'byeolbit',    displayName: '한밤중의별빛무지개고양이' },
    // stacked combining marks (zalgo) — one grapheme, many code points
    { handle: 'nightforest', displayName: zalgofy('nightforest', 4, zrnd) },
    { handle: 'voidwalker',  displayName: zalgofy('V O I D', 6, zrnd) },
    // Arabic, RTL
    { handle: 'sahar',       displayName: 'سحر القمر' },
    // Hebrew, RTL
    { handle: 'kochav',      displayName: 'כוכב הלילה' },
    // An UNBALANCED U+202E RIGHT-TO-LEFT OVERRIDE. Rendered raw this reverses
    // every character after it, including the surrounding UI text — which is
    // exactly why the renderer strips bidi controls before it prints a name.
    { handle: 'bidinova',    displayName: 'nova‮star fox' },
    // astral-plane maths letters — surrogate pairs, which a naive .slice() cuts
    { handle: 'garden',      displayName: '\u{1D52B}\u{1D52C}\u{1D520}\u{1D531}\u{1D532}\u{1D52F}\u{1D52B}\u{1D51E}\u{1D529} \u{1D524}\u{1D51E}\u{1D52F}\u{1D521}\u{1D522}\u{1D52B}' },
    // fullwidth forms — roughly 2x the advance width of ASCII
    { handle: 'fullwidth',   displayName: 'ＦＵＬＬＷＩＤＴＨ　ＭＯＯＤ' },
    // an emoji-only name, including a ZWJ sequence (black cat)
    { handle: 'catmoon',     displayName: '\u{1F338}✨\u{1F408}‍⬛\u{1F319}\u{1F4AB}\u{1F3A7}\u{1FAE7}\u{1FA90}\u{1F30C}\u{1F98A}' },
    // 76 characters with no break opportunity anywhere
    { handle: 'wall',        displayName: 'a'.repeat(76) },
    // very long, wide-glyph Chinese
    { handle: 'changping',   displayName: '這是一個非常非常長的中文顯示名稱測試用' },
    { handle: 'thinspace',   displayName: 'k i t s u n e   d r e a m' },
    // block-drawing "clan tag" decoration
    { handle: 'tagged',      displayName: '█▓▒░ ЅŦАЯŁłŦ ░▒▓█' },
    // Devanagari with a chandrabindu (combining mark above)
    { handle: 'devanagari',  displayName: 'चाँदनी रात' },
    // Thai — marks stacked above and below, and no word spaces
    { handle: 'thai',        displayName: 'ดาวราตรีสีม่วง' },
    // Greek
    { handle: 'greekowl',    displayName: 'Νυχτερινή Κουκουβάγια' },
  ];

  // Ordinary procedural names — the other ~93% of a roster.
  const SYL_A = ['ka', 'mi', 'ru', 'ne', 'sa', 'to', 'ly', 'vex', 'no', 'ze', 'ari', 'bel', 'cyn', 'dra', 'elo', 'fen', 'gal', 'hex', 'iri', 'jun', 'kes', 'lum', 'mor', 'nix', 'ori', 'pyx', 'qua', 'ren', 'syl', 'tas', 'umb', 'vel', 'wis', 'xan', 'yri', 'zae', 'ash', 'bra', 'cor', 'del'];
  const SYL_B = ['ra', 'na', 'th', 'va', 'ko', 'mi', 'sha', 'lex', 'dor', 'wyn', 'ette', 'ix', 'os', 'ara', 'elle', 'ion', 'uxe', 'ynn', 'ade', 'ora', 'ley', 'iel', 'un', 'ka'];
  const SURNAME = ['', '', '', '', ' Vale', ' Ashgrove', ' Winterhold', ' of the Ferret', ' Nine', ' Radio', ' Sixteen', ' Lark'];
  const CJK_CH = ['雪', '星', '夜', '月', '風', '光', '海', '桜', '空', '影', '花', '雷', '霧', '翼', '葵', '琴', '杉', '霧'];
  const HANGUL = ['하늘', '별빛', '도윤', '서연', '바다', '달빛'];
  const CYRILLIC = ['Алекс', 'Мила', 'Ника', 'Соня', 'Даша', 'Юра'];

  function makeName(rnd) {
    const roll = rnd();
    if (roll < 0.045) {
      const n = 2 + Math.floor(rnd() * 2);
      let s = '';
      for (let i = 0; i < n; i++) s += CJK_CH[Math.floor(rnd() * CJK_CH.length)];
      return s;
    }
    if (roll < 0.065) return HANGUL[Math.floor(rnd() * HANGUL.length)];
    if (roll < 0.085) return CYRILLIC[Math.floor(rnd() * CYRILLIC.length)];
    const a = SYL_A[Math.floor(rnd() * SYL_A.length)];
    const b = SYL_B[Math.floor(rnd() * SYL_B.length)];
    const base = a + b;
    const cap = base[0].toUpperCase() + base.slice(1);
    return cap + SURNAME[Math.floor(rnd() * SURNAME.length)];
  }
  function makeHandle(name, i, rnd) {
    const ascii = sortKey(name).slice(0, 12);
    const stem = ascii || 'friend';
    return rnd() < 0.35 ? `${stem}${10 + Math.floor(rnd() * 89)}` : `${stem}${i % 7 === 0 ? '_' + (i % 97) : ''}`;
  }

  // -- flavour pools ---------------------------------------------------------
  const PLACES = ['Framework Hangout', 'The Copper Ferret', 'Starlit Terrace', 'Hollow Barn', 'Cyber Dream Club', 'Club Meridian', 'Prismatic Void', 'The Velvet Moth', 'Rainy Alley', 'Summer Festival Grounds', 'Quiet Library', 'Room of the Rain'];
  const STATUSES = [
    '🏖 away till the 20th',
    'grinding shader homework',
    'sleeping 😴 back friday',
    'on holiday in Kyoto 🗼 slow replies',
    'open instance, come say hi',
    'afk — dinner',
    'commissions closed for now',
    'exams. see you in september.',
    'mic broken, typing only',
    'first day back — be gentle',
    'moving flats this week, replies will be slow, sorry in advance to everyone waiting on a world review — I promise I have not forgotten, the boxes are just winning right now',
    'currently learning to solder, currently failing to solder, if anyone has a spare tip for a TS100 I will trade you an entire custom avatar for it, this is a serious offer and not a joke',
  ];
  const BIOS = [
    'DnB, long instances, worse puns.',
    'photographer. will point a camera at your avatar.',
    'shaders, coffee, regret.',
    'building small tools. mutuals only.',
    'nocturnal. sorry.',
    'ttrpg gremlin.',
    'come vibe. mic optional.',
    'cartography & trains.',
    'world-builder. always cooking.',
    'threads about tiny UIs.',
    'I make worlds about quiet places — train platforms at 3am, launderettes, the bit of a car park where the light is orange. If you want a tour ask, I will always say yes, and I will always talk for far too long about the fog volume settings.',
    'she/her · avatar optimisation, mostly · I will rig your model for free if you promise to actually use it · fediverse elsewhere · no DMs about crypto, ever, I am begging · currently 11,000 polys under budget and unbearably smug about it',
  ];
  const NOTES = ['', '', '', '', '', 'Met at Framework’s world.', 'Study-group buddy.', 'Runs the Tuesday campaign.', 'Good eye for glass.', 'Owes me a world tour.', 'Knows everyone; ask them for intros.', 'Met at the summer meetup — they run the Sunday photo walk and always know which instance everyone drifted to, ask them before hunting around yourself'];
  const PEAKS = ['day', 'eve', 'night'];

  // -- the friends -----------------------------------------------------------
  // Person id is `${source}:${sourceId}` — matches the real core.
  const CURATED = [
    { source: 'vrcx',    sourceId: 'usr_a10c',  handle: 'mika',       displayName: 'Mika',   online: true,  birthday: '08-24', pronouns: 'she/her',   statusText: '🏖 away till the 20th', statusKind: 'askme', place: 'Framework Hangout', bio: 'DnB, long instances, worse puns.', note: 'Met at Framework’s world. Likes drum & bass. Owes me a world tour.', peak: 'eve', weekendBias: 1.2 },
    { source: 'vrcx',    sourceId: 'usr_b22f',  handle: 'juniper',    displayName: 'Juniper', online: true, birthday: null,    pronouns: 'they/them', statusText: '', statusKind: 'online', place: 'The Copper Ferret', bio: 'photographer. will point a camera at your avatar.', note: '', peak: 'eve', weekendBias: 1.0 },
    { source: 'discord', sourceId: '198802',    handle: 'sable',      displayName: 'sable',  online: true,  birthday: null,    pronouns: 'she/her',   statusText: 'grinding shader homework', statusKind: 'busy', place: '', bio: 'shaders, coffee, regret.', note: 'Study-group buddy. Ping before finals week.', peak: 'night', weekendBias: 0.8 },
    { source: 'discord', sourceId: '204417',    handle: 'orion',      displayName: 'Orion',  online: false, birthday: '08-22', pronouns: 'he/him',    statusText: '', statusKind: 'offline', place: '', bio: '', note: '', peak: 'day', weekendBias: 0.9 },
    { source: 'twitter', sourceId: '77120041',  handle: 'wrenbuilds', displayName: 'Wren',   online: true,  birthday: null,    pronouns: 'she/her',   statusText: '', statusKind: 'online', place: '', bio: 'building small tools. mutuals only.', note: '', peak: 'day', weekendBias: 0.7 },
    { source: 'vrcx',    sourceId: 'usr_c31d',  handle: 'kestrel',    displayName: 'Kestrel', online: false, birthday: null,   pronouns: 'he/him',    statusText: 'sleeping 😴 back friday', statusKind: 'busy', place: '', bio: 'nocturnal. sorry.', note: '', peak: 'night', weekendBias: 1.1 },
    { source: 'discord', sourceId: '211903',    handle: 'amandine',   displayName: 'amandine', online: true, birthday: '09-02', pronouns: 'she/her',  statusText: '', statusKind: 'active', place: '', bio: 'ttrpg gremlin.', note: 'Runs the Tuesday campaign.', peak: 'eve', weekendBias: 1.0 },
    { source: 'vrcx',    sourceId: 'usr_d47e',  handle: 'tycho',      displayName: 'Tycho',  online: true,  birthday: null,    pronouns: 'they/them', statusText: '', statusKind: 'joinme', place: 'Starlit Terrace', bio: 'come vibe. mic optional.', note: '', peak: 'eve', weekendBias: 1.3 },
    { source: 'twitter', sourceId: '88431125',  handle: 'liormaps',   displayName: 'Lior',   online: false, birthday: null,    pronouns: 'he/him',    statusText: '', statusKind: 'offline', place: '', bio: 'cartography & trains.', note: '', peak: 'day', weekendBias: 0.6 },
    { source: 'discord', sourceId: '219660',    handle: 'novah',      displayName: 'Novah',  online: true,  birthday: null,    pronouns: 'she/they',  statusText: 'on holiday in Kyoto 🗼 slow replies', statusKind: 'askme', place: '', bio: 'away, eating everything.', note: 'Back end of the month.', peak: 'day', weekendBias: 1.0 },
    { source: 'vrcx',    sourceId: 'usr_e58a',  handle: 'fenn',       displayName: 'Fenn',   online: false, birthday: '08-21', pronouns: 'he/him',    statusText: '', statusKind: 'offline', place: '', bio: 'world-builder. always cooking.', note: 'Birthday tomorrow — say hi.', peak: 'eve', weekendBias: 1.1 },
    { source: 'twitter', sourceId: '90277314',  handle: 'cassthreads', displayName: 'Cass',  online: true,  birthday: null,    pronouns: 'she/her',   statusText: '', statusKind: 'online', place: '', bio: 'threads about tiny UIs.', note: 'Good eye for glass. Ask about the OLED theme.', peak: 'day', weekendBias: 0.7 },

    // -- cross-source identity demo (SPEC §2.1) --------------------------------
    // The SAME invented human on three sources, with slight name variations, so
    // linkSuggestions() returns real candidates for the operator to confirm.
    // None of these are real people — every name here is made up.
    { source: 'steam',   sourceId: '7656119railway', handle: 'badger',   displayName: 'Badger',    online: true,  birthday: null,    pronouns: 'they/them', statusText: '', statusKind: 'online', place: '', bio: 'digs holes in blender.', note: '', peak: 'night', weekendBias: 1.1 },
    { source: 'discord', sourceId: '540221badger',   handle: 'badger',   displayName: 'badger_',   online: false, birthday: '10-02', pronouns: 'they/them', statusText: '', statusKind: 'offline', place: '', bio: '', note: '', peak: 'night', weekendBias: 1.1 },
    { source: 'vrcx',    sourceId: 'usr_badger7f',   handle: 'badgerVR', displayName: 'Badger 🦡', online: true,  birthday: null,    pronouns: 'they/them', statusText: 'building a burrow world', statusKind: 'joinme', place: 'Hollow Barn', bio: 'worldbuilder, nocturnal.', note: '', peak: 'night', weekendBias: 1.2 },

    // An ALREADY-LINKED cluster (see SEED_LINKS below), so the "Also on other
    // platforms" + Unlink path renders on first open without any setup.
    { source: 'vrcx',    sourceId: 'usr_noct91',     handle: 'noctis',   displayName: 'Noctis',    online: true,  birthday: null,    pronouns: 'she/her',   statusText: '', statusKind: 'askme', place: 'Prismatic Void', bio: 'aurora chaser.', note: 'Met at the winter meetup.', peak: 'night', weekendBias: 1.0 },
    { source: 'discord', sourceId: '778430noct',     handle: 'noctis9',  displayName: 'Noctis',    online: false, birthday: '12-14', pronouns: 'she/her',   statusText: '', statusKind: 'offline', place: '', bio: '', note: '', peak: 'eve', weekendBias: 1.0 },
  ];

  // Operator-asserted links present on first load (SPEC §2.1). Undirected pairs
  // of person ids; the cluster is their transitive closure, recomputed on read.
  const SEED_LINKS = [['vrcx:usr_noct91', 'discord:778430noct']];

  const ROSTER_SIZE = 411;   // what a real, well-used roster looks like
  const ONLINE_TARGET = 45;  // a normal Thursday evening

  const SOURCES_MIX = [
    ['vrcx', 0.56],
    ['discord', 0.30],
    ['twitter', 0.14],
  ];
  function pickSource(r) {
    let acc = 0;
    for (const [name, w] of SOURCES_MIX) { acc += w; if (r < acc) return name; }
    return 'vrcx';
  }
  const STATUS_KINDS = { vrcx: ['online', 'joinme', 'askme', 'busy'], discord: ['online', 'active', 'busy'], twitter: ['online'] };

  function buildRoster() {
    const rnd = mulberry32(0xC0FFEE);
    const out = CURATED.map((c) => ({ ...c }));
    const seenHandles = new Set(out.map((p) => p.handle));

    const specials = HARD_NAMES.map((h) => ({ ...h, __hard: true }));
    let specialAt = 0;

    for (let i = out.length; i < ROSTER_SIZE; i++) {
      // Sprinkle the pathological names evenly through the roster rather than
      // clumping them, so any grid row can catch one.
      const takeSpecial = specialAt < specials.length && i % 19 === 5;
      const source = pickSource(rnd());
      let displayName;
      let handle;
      if (takeSpecial) {
        const s = specials[specialAt++];
        displayName = s.displayName;
        handle = s.handle;
      } else {
        displayName = makeName(rnd);
        handle = makeHandle(displayName, i, rnd);
      }
      while (seenHandles.has(handle)) handle += (i % 10);
      seenHandles.add(handle);

      const sourceId = source === 'vrcx' ? `usr_${(hashStr(handle) % 0xfffff).toString(16).padStart(5, '0')}` : String(100000 + (hashStr(handle) % 899999));
      const kinds = STATUS_KINDS[source];
      const hasStatus = rnd() < 0.16;
      const longIdx = i % 97 === 0 ? 10 : i % 89 === 0 ? 11 : -1; // a couple of essays
      const hasBio = rnd() < 0.42;
      const longBio = i % 83 === 0 ? 10 : i % 71 === 0 ? 11 : -1;

      out.push({
        source,
        sourceId,
        handle,
        displayName,
        online: false, // assigned below so the total is exact
        birthday: rnd() < 0.22 ? `${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}` : null,
        pronouns: ['she/her', 'he/him', 'they/them', 'she/they', '', ''][Math.floor(rnd() * 6)],
        statusText: hasStatus ? STATUSES[longIdx >= 0 ? longIdx : Math.floor(rnd() * 10)] : '',
        statusKind: kinds[Math.floor(rnd() * kinds.length)],
        place: source === 'vrcx' && rnd() < 0.5 ? PLACES[Math.floor(rnd() * PLACES.length)] : '',
        bio: hasBio ? BIOS[longBio >= 0 ? longBio : Math.floor(rnd() * 10)] : '',
        note: NOTES[Math.floor(rnd() * NOTES.length)],
        peak: PEAKS[Math.floor(rnd() * PEAKS.length)],
        weekendBias: 0.6 + rnd() * 0.8,
      });
    }

    // Exactly ONLINE_TARGET people online, curated ones first (they carry the
    // hand-written flavour), then a deterministic spread of the rest.
    let online = 0;
    for (const p of out) { if (p.online) online++; }
    const ornd = mulberry32(0x51de);
    for (let i = 0; i < out.length && online < ONLINE_TARGET; i++) {
      const p = out[(i * 37 + 11) % out.length];
      if (p.online) continue;
      p.online = true;
      if (!p.place && p.source === 'vrcx' && ornd() < 0.6) p.place = PLACES[Math.floor(ornd() * PLACES.length)];
      online++;
    }
    return out;
  }

  const FRIENDS = buildRoster();

  // The reserved "self" person — the operator (SPEC §0.6). The real core keeps
  // it out of people.list() unless includeSelf is set; so does this mock.
  const SELF = { source: 'manual', sourceId: 'self', handle: 'you', displayName: 'You', online: true, birthday: null, pronouns: '', statusText: '', statusKind: 'online', place: '', bio: '', note: '', peak: 'eve', weekendBias: 1, isSelf: true };

  const idOf = (p) => `${p.source}:${p.sourceId}`;
  const FIRST_SEEN = NOW - 240 * DAY;

  // Public Person shape (SPEC §2.1). avatarUrl stays null: the UI paints a
  // deterministic monogram tile (DESIGN §8), the correct fallback.
  function toPerson(p) {
    return {
      id: idOf(p),
      source: p.source,
      sourceId: p.sourceId,
      handle: p.handle,
      displayName: p.displayName,
      avatarUrl: null,
      birthday: p.birthday,
      pronouns: p.pronouns,
      bio: p.bio || null,
      note: p.note || '',
      links: [],
      isSelf: !!p.isSelf,
      status: p.online ? p.statusKind : 'offline',
      statusText: p.statusText || '',
      place: p.place || '',
      lastSeen: p.online ? NOW : NOW - Math.floor(2 + (hashStr(p.sourceId) % 400)) * HOUR,
    };
  }

  const PEOPLE = FRIENDS.map(toPerson);
  const SELF_PUB = toPerson(SELF);
  const byId = new Map(PEOPLE.map((p) => [p.id, p]));
  byId.set(SELF_PUB.id, SELF_PUB);
  const rawById = new Map(FRIENDS.map((p) => [idOf(p), p]));
  rawById.set(idOf(SELF), SELF);
  const notes = new Map(PEOPLE.map((p) => [p.id, p.note]));

  // -- identity clusters (SPEC §2.1) -----------------------------------------
  // Links are undirected edges; the cluster is the transitive closure. Stored
  // as canonical "min|max" keys so an edge is recorded once regardless of the
  // order it was asserted in — the real core stores it directionally and closes
  // over both orientations, which comes out to the same clusters.
  const LINKS = new Set();
  const linkKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const [a, b] of SEED_LINKS) if (byId.has(a) && byId.has(b)) LINKS.add(linkKey(a, b));

  function clusterOf(id) {
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      for (const key of LINKS) {
        const [x, y] = key.split('|');
        const other = x === cur ? y : y === cur ? x : null;
        if (other && !seen.has(other)) { seen.add(other); queue.push(other); }
      }
    }
    return [...seen].filter((cid) => byId.has(cid));
  }

  // Same normalizer/scorer the core uses (digest.js), so the standalone demo
  // ranks candidates exactly like the real bridge.
  function normKey(s) {
    return String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  }
  const MIN_KEY = 3;
  function bestMatch(a, b) {
    const ah = normKey(a.handle), an = normKey(a.displayName);
    const bh = normKey(b.handle), bn = normKey(b.displayName);
    if (ah.length >= MIN_KEY && ah === bh) return { score: 3, reason: `same handle: ${a.handle || ah}` };
    if (an.length >= MIN_KEY && an === bn) return { score: 2, reason: `same name: ${a.displayName || an}` };
    const aKeys = [ah, an].filter((k) => k.length >= MIN_KEY);
    const bKeys = [bh, bn].filter((k) => k.length >= MIN_KEY);
    for (const ak of aKeys) for (const bk of bKeys) {
      if (ak === bk || ak.includes(bk) || bk.includes(ak)) {
        return { score: 1, reason: `name ${a.displayName || a.handle} ~ ${b.displayName || b.handle}` };
      }
    }
    return null;
  }

  // -- overlap heatmap -------------------------------------------------------
  // A believable 7×24 grid of "hours you and this friend were BOTH online",
  // shaped by peak (day/eve/night) + weekend bias, jittered per person. Over a
  // ~34-week window a regular evening friend accumulates tens of hours in their
  // peak bucket, so the grid is dense rather than a handful of lit cells.
  function personGrid(p) {
    const rnd = mulberry32(hashStr(idOf(p)) ^ 0x9e3779b9);
    const weeks = 30 + rnd() * 8;          // how much of the window they overlapped
    const engagement = 0.12 + rnd() * 0.5; // fraction of those weeks they showed up
    const grid = [];
    for (let d = 0; d < 7; d++) {
      const weekend = d === 5 || d === 6;
      const dayScale = weekend ? p.weekendBias : 1;
      const row = [];
      for (let h = 0; h < 24; h++) {
        let base;
        if (p.peak === 'day') base = Math.exp(-((h - 15) ** 2) / 22);
        else if (p.peak === 'eve') base = Math.exp(-((h - 21) ** 2) / 14);
        else base = Math.exp(-(((h + 24 - 2) % 24 - 4) ** 2) / 30) + Math.exp(-((h - 1) ** 2) / 20);
        let v = base * dayScale * weeks * engagement * (0.55 + rnd() * 0.9);
        if (h >= 4 && h <= 9) v *= 0.25; // people are rarely on 4–9am
        row.push(Math.max(0, Math.round(v)));
      }
      grid.push(row);
    }
    return grid;
  }
  const GRIDS = new Map(FRIENDS.map((p) => [idOf(p), personGrid(p)]));

  let aggCache = null;
  function aggregateGrid() {
    if (aggCache) return aggCache;
    const g = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const grid of GRIDS.values()) {
      for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) g[d][h] += grid[d][h];
    }
    aggCache = g;
    return g;
  }
  function gridMax(g) {
    let m = 0;
    for (const row of g) for (const v of row) if (v > m) m = v;
    return m;
  }
  // How many friends contributed any lit cell at all — reported as
  // `friendsConsidered` so the aggregate caption can say what it is summing.
  const HAS_OVERLAP = new Set();
  for (const [id, g] of GRIDS) if (gridMax(g) > 0) HAS_OVERLAP.add(id);

  // Hours of the OPERATOR's own presence Orbit has on file. This is the quiet
  // ceiling on the whole feature: overlap can only be counted for hours Orbit
  // knows YOU were online, so a thin grid is usually a thin self-history. The
  // real dataset this mock mirrors has 51.
  const SELF_HOURS = 51;

  // -- per-person timeline (SPEC §5 personTimeline, reverse-chron) -----------
  // Multi-hour sessions, not single blips: an online edge followed by an
  // offline edge some hours later, walked backwards over several weeks.
  function timelineFor(p) {
    const raw = rawById.get(idOf(p));
    const rnd = mulberry32(hashStr(idOf(p)) ^ 0x51ed270b);
    const evs = [];
    let t = NOW - (raw.online ? 0 : Math.floor(2 + rnd() * 30) * HOUR);
    if (raw.online) evs.push({ kind: 'presence', ts: NOW - Math.floor(rnd() * 3) * HOUR - 20 * 60000, status: 'online', place: raw.place || null });
    for (let i = 0; i < 14; i++) {
      t -= Math.floor(2 + rnd() * 5) * HOUR;          // session length
      evs.push({ kind: 'presence', ts: t, status: 'offline', place: null });
      t -= Math.floor(8 + rnd() * 34) * HOUR;         // the gap until the last one started
      evs.push({ kind: 'presence', ts: t, status: 'online', place: raw.place || null });
    }
    if (raw.statusText) evs.push({ kind: 'status', ts: NOW - Math.floor(1 + rnd() * 8) * HOUR, status: raw.statusKind, text: raw.statusText });
    evs.push({ kind: 'status', ts: NOW - Math.floor(3 + rnd() * 10) * DAY, status: 'online', text: 'back home, finally' });
    if (raw.bio) evs.push({ kind: 'bio', ts: NOW - Math.floor(2 + rnd() * 20) * DAY, text: raw.bio });
    if (rnd() > 0.55) evs.push({ kind: 'nick', ts: NOW - Math.floor(5 + rnd() * 40) * DAY, text: raw.displayName, meta: { from: raw.handle } });
    if (rnd() > 0.6) evs.push({ kind: 'avatar', ts: NOW - Math.floor(1 + rnd() * 25) * DAY });
    evs.push({ kind: 'friend', ts: FIRST_SEEN + Math.floor(rnd() * 200) * DAY, meta: { became: true } });
    return evs
      .map((e) => ({ ...e, source: p.source, sourceId: p.sourceId }))
      .sort((a, b) => b.ts - a.ts);
  }
  const TIMELINES = new Map(FRIENDS.map((p) => [idOf(p), timelineFor(p)]));

  // -- birthdays -------------------------------------------------------------
  function nextBirthday(mmdd, fromTs) {
    const parts = mmdd.split('-').map(Number);
    const [mm, dd] = parts.length === 3 ? [parts[1], parts[2]] : parts;
    const from = new Date(fromTs);
    const year = from.getFullYear();
    let cand = new Date(year, mm - 1, dd);
    const floor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    if (cand < floor) cand = new Date(year + 1, mm - 1, dd);
    const daysAway = Math.round((cand - floor) / DAY);
    const p2 = (n) => (n < 10 ? '0' + n : '' + n);
    // local-date string (not toISOString, which shifts to UTC and can slip a day)
    const nextDate = `${cand.getFullYear()}-${p2(cand.getMonth() + 1)}-${p2(cand.getDate())}`;
    return { nextDate, daysAway };
  }

  function publicPerson(id) {
    const p = byId.get(id);
    if (!p) return null;
    return { ...p, note: notes.get(id) ?? '' };
  }

  // -- change feed (SPEC §5 changeFeed: bio/nick/avatar/friend, rev-chron) ---
  function buildChangeFeed(sinceTs) {
    const rows = [];
    for (const p of PEOPLE) {
      for (const e of TIMELINES.get(p.id) || []) {
        if (['bio', 'nick', 'avatar', 'friend'].includes(e.kind)) {
          rows.push({ person: publicPerson(p.id), kind: e.kind, ts: e.ts, text: e.text || null, meta: e.meta || null });
        }
      }
    }
    rows.sort((a, b) => b.ts - a.ts);
    return typeof sinceTs === 'number' ? rows.filter((r) => r.ts >= sinceTs) : rows;
  }

  // -- sources ---------------------------------------------------------------
  // Two populations, exactly as the real core reports them (SPEC §1):
  //
  //   kind:"reader"  — runs INSIDE Orbit on a timer. Steam is the one
  //                    CONFIGURABLE reader (it has a Connect flow) and starts
  //                    DISCONNECTED so the walkthrough demoes.
  //   kind:"emitter" — runs in another app and POSTs to the loopback API. Its
  //                    only evidence is the §4 ingest_log, so the mock states
  //                    what "arrived": a bridge delivering right now, a CLI that
  //                    has never been run, and one that went quiet days ago.
  //
  // Health is derived at call time, never baked in — and from an AGE, not from
  // the frozen scene clock, so "delivered 2 minutes ago" stays 2 minutes ago
  // however long after `NOW` the demo is opened. (A fixed timestamp here made
  // the healthy bridge drift into "quiet" the moment the wall clock passed it.)
  const EMITTER_LIVE_MS = 10 * 60 * 1000; // matches src/main/sources-status.js
  const READER_LIVE_MS = 30 * 60 * 1000;
  function healthOf(kind, at, lastOk, now) {
    if (kind === 'reader' && lastOk === false) return 'error';
    if (at == null) return 'waiting';
    return now - at <= (kind === 'reader' ? READER_LIVE_MS : EMITTER_LIVE_MS) ? 'live' : 'idle';
  }
  const countOf = (source) => FRIENDS.filter((f) => f.source === source).length;

  // agoMs = how long ago it last ran/delivered; null = never.
  const readers = [
    { plugin: 'vrcx', source: 'vrcx', agoMs: 6 * 60000, lastOk: true, nPersons: countOf('vrcx'), configurable: false, connected: true, account: null, version: '1.0.0', deliveries: 812, nObs: 34, totalObs: 61240 },
    { plugin: 'steam', source: 'steam', agoMs: null, lastOk: null, nPersons: countOf('steam'), configurable: true, connected: false, account: null, version: null, deliveries: 0, nObs: 0, totalObs: 0 },
  ];

  const emitters = [
    // Working: the Vencord bridge flushes every 30s, so a live one is minutes old.
    { plugin: 'vencord-orbit-bridge', sources: ['discord'], version: '1.0.0', agoMs: 2 * 60000, nPersons: countOf('discord'), nObs: 17, totalObs: 12408, deliveries: 2841 },
    // Went quiet: delivered for months, nothing for three days.
    { plugin: 'lastfm-orbit', sources: ['lastfm'], version: '1.0.0', agoMs: 3 * DAY, nPersons: 6, nObs: 96, totalObs: 3120, deliveries: 154 },
    // Never installed: the "waiting for first delivery" rows, with their hints.
    { plugin: 'twitter-orbit', sources: ['twitter'], version: null, agoMs: null, nPersons: countOf('twitter'), nObs: 0, totalObs: 0, deliveries: 0 },
    { plugin: 'contacts-orbit', sources: ['contacts'], version: null, agoMs: null, nPersons: 0, nObs: 0, totalObs: 0, deliveries: 0 },
  ];

  // A fake token — 64 hex chars like a real randomBytes(32), but a constant, so
  // nothing here could ever be mistaken for a live credential.
  const MOCK_TOKEN = 'deadbeef'.repeat(8);

  // Fake credential state for the Steam Connect flow. No real key, no real data:
  // `test` "succeeds" for any non-empty key + profile, `configure` flips it on.
  let steamCred = null; // { account, steamId, friendCount } once connected
  function steamValidate(cfg) {
    const apiKey = String((cfg && cfg.apiKey) || '').trim();
    const profile = String((cfg && cfg.steamId) || '').trim();
    if (!apiKey) return { ok: false, reason: 'Enter your Steam Web API key first.' };
    if (!profile) return { ok: false, reason: 'Paste your Steam profile link (or your SteamID64).' };
    // Let a demo-er see the actionable private-list error on purpose.
    if (/private/i.test(profile)) {
      return {
        ok: false,
        reason:
          'Steam did not return your friends list. Steam only shares it when your own ' +
          '"My Friends List" privacy is set to Public. Fix it here, then test again: ' +
          'Steam → Profile → Edit Profile → Privacy Settings → My Friends List → Public.',
      };
    }
    return { ok: true, account: 'nova_navigator', friendCount: 128, steamId: '76561198000000042' };
  }

  let settings = {
    retentionDays: 365,
    ingestPort: 8477,
    sources: { vrcx: true, 'vencord-orbit-bridge': true, 'twitter-orbit': true, manual: true },
  };

  const clone = (v) => JSON.parse(JSON.stringify(v));

  /* ---------------------------------------------------------------------
     The synchronous implementations. These are NEVER exposed directly —
     `asyncify` below wraps each one so the public surface is Promise-based,
     exactly like ipcRenderer.invoke.
     --------------------------------------------------------------------- */
  const impl = {
    digest: {
      whoIsOnNow() {
        const people = PEOPLE.filter((p) => rawById.get(p.id)?.online).map((p) => publicPerson(p.id));
        return clone({ count: people.length, people });
      },
      // Cell = the number of distinct calendar DATES on which you and that
      // friend were both online during that local weekday-hour. The aggregate
      // ("Everyone") grid sums that across friends, so its unit is friend-hours,
      // not hours of your life — the view has to say which one it is showing.
      heatmap(personId) {
        const single = personId && GRIDS.has(personId);
        let g;
        if (single) {
          // Union the whole identity cluster's grids (element-wise max) so a
          // linked friend's Steam + VRChat presence reads as one merged grid —
          // the core does this exactly, over presence buckets.
          const ids = clusterOf(personId).filter((cid) => GRIDS.has(cid));
          if (ids.length > 1) {
            g = Array.from({ length: 7 }, () => new Array(24).fill(0));
            for (const cid of ids) {
              const gg = GRIDS.get(cid);
              for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) g[d][h] = Math.max(g[d][h], gg[d][h]);
            }
          } else {
            g = GRIDS.get(personId);
          }
        } else {
          g = aggregateGrid();
        }
        return clone({
          grid: g,
          max: gridMax(g),
          windowDays: settings.retentionDays,
          metric: 'distinct-dates-both-online',
          // How much of YOUR OWN presence Orbit has on file. A thin grid is
          // usually this, not "you have no friends online" — the view says so.
          selfHours: SELF_HOURS,
          friendsConsidered: single ? 1 : HAS_OVERLAP.size,
        });
      },
      birthdays(withinDays = 30) {
        return clone(
          PEOPLE.filter((p) => byId.get(p.id)?.birthday)
            .map((p) => ({ person: publicPerson(p.id), ...nextBirthday(byId.get(p.id).birthday, NOW) }))
            .filter((b) => b.daysAway <= withinDays)
            .sort((a, b) => a.daysAway - b.daysAway || (a.person.id < b.person.id ? -1 : 1)),
        );
      },
      statusBoard() {
        return clone(
          PEOPLE.filter((p) => (byId.get(p.id)?.statusText || '').trim().length)
            .map((p) => {
              const raw = rawById.get(p.id);
              return { person: publicPerson(p.id), status: raw.online ? raw.statusKind : 'offline', text: raw.statusText, ts: byId.get(p.id).lastSeen };
            })
            .sort((a, b) => b.ts - a.ts || (a.person.id < b.person.id ? -1 : 1)),
        );
      },
      changeFeed(sinceTs) {
        return clone(buildChangeFeed(sinceTs));
      },
    },
    people: {
      // Real filter shape: { q, source, hasBirthday, includeSelf }. The self
      // person is excluded unless includeSelf — same as the core.
      list(filter) {
        const f = filter && typeof filter === 'object' ? filter : {};
        let list = PEOPLE.map((p) => publicPerson(p.id));
        if (f.includeSelf) list = list.concat([{ ...SELF_PUB }]);
        if (f.q) {
          const q = String(f.q).toLowerCase();
          list = list.filter((p) => (p.displayName + ' ' + p.handle + ' ' + p.source + ' ' + (p.note || '')).toLowerCase().includes(q));
        }
        if (f.source) list = list.filter((p) => p.source === f.source);
        if (f.hasBirthday) list = list.filter((p) => !!p.birthday);
        // Locale-independent, total ordering (DESIGN §7).
        return clone(
          list.sort((a, b) => {
            const ka = sortKey(a.displayName);
            const kb = sortKey(b.displayName);
            if (ka !== kb) return ka < kb ? -1 : 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          }),
        );
      },
      get(id) {
        if (!byId.has(id)) return null;
        const ids = clusterOf(id);
        // identities = the whole cluster incl. the queried id (SPEC §6), so the
        // card can show "also on Steam / Discord".
        const identities = ids.map((cid) => publicPerson(cid));
        // timeline = union across the cluster, reverse-chron, each row already
        // tagged with the source it came from (timelineFor stamps it).
        const timeline = [];
        for (const cid of ids) for (const e of TIMELINES.get(cid) || []) timeline.push(e);
        timeline.sort((a, b) => b.ts - a.ts);
        return clone({ person: publicPerson(id), identities, timeline });
      },
      setNote(id, text) {
        if (byId.has(id)) notes.set(id, String(text ?? ''));
        return { ok: true };
      },
      link(idA, idB) {
        if (idA === idB) throw new Error('cannot link a person to themselves');
        if (idA.startsWith('self:') || idB.startsWith('self:')) throw new Error('the reserved self person cannot be linked');
        if (byId.has(idA) && byId.has(idB)) {
          LINKS.add(linkKey(idA, idB));
          aggCache = null;
        }
        return { ok: true };
      },
      unlink(idA, idB) {
        LINKS.delete(linkKey(idA, idB));
        aggCache = null;
        return { ok: true };
      },
      // Candidates to CONFIRM — pure string comparison, applies nothing.
      linkSuggestions(personId) {
        const roster = PEOPLE.map((p) => publicPerson(p.id));
        if (personId) {
          const base = publicPerson(personId);
          if (!base) return [];
          const inCluster = new Set(clusterOf(personId));
          const out = [];
          for (const c of roster) {
            if (c.source === base.source) continue;
            if (inCluster.has(c.id)) continue;
            const m = bestMatch(base, c);
            if (m) out.push({ a: base.id, b: c.id, person: base, candidate: c, score: m.score, reason: m.reason });
          }
          out.sort((x, y) => y.score - x.score || (x.candidate.id < y.candidate.id ? -1 : 1));
          return clone(out);
        }
        const out = [];
        const seen = new Set();
        for (let i = 0; i < roster.length; i++) {
          for (let j = i + 1; j < roster.length; j++) {
            const p = roster[i], q = roster[j];
            if (p.source === q.source) continue;
            const m = bestMatch(p, q);
            if (!m) continue;
            if (clusterOf(p.id).includes(q.id)) continue;
            const key = linkKey(p.id, q.id);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ a: p.id, b: q.id, person: p, candidate: q, score: m.score, reason: m.reason });
          }
        }
        out.sort((x, y) => y.score - x.score);
        return clone(out.slice(0, 50));
      },
      forget(id) {
        const p = byId.get(id);
        if (p) {
          byId.delete(id);
          rawById.delete(id);
          notes.delete(id);
          GRIDS.delete(id);
          HAS_OVERLAP.delete(id);
          TIMELINES.delete(id);
          for (const key of [...LINKS]) { const [x, y] = key.split('|'); if (x === id || y === id) LINKS.delete(key); }
          aggCache = null;
          const i = PEOPLE.findIndex((x) => x.id === id);
          if (i >= 0) PEOPLE.splice(i, 1);
          const j = FRIENDS.findIndex((x) => idOf(x) === id);
          if (j >= 0) FRIENDS.splice(j, 1);
        }
        return { ok: true };
      },
      // Real core returns THE CREATED PERSON object (not {ok}).
      addManual({ displayName, birthday, note } = {}) {
        const sourceId = 'm_' + (hashStr(String(displayName) + Date.now()) % 1000000).toString(36);
        const raw = { source: 'manual', sourceId, handle: String(displayName || 'person').toLowerCase().replace(/\s+/g, ''), displayName: displayName || 'New person', online: false, birthday: birthday || null, pronouns: '', statusText: '', statusKind: 'offline', place: '', bio: '', note: note || '', peak: 'day', weekendBias: 1 };
        const pub = toPerson(raw);
        FRIENDS.push(raw);
        PEOPLE.push(pub);
        byId.set(pub.id, pub);
        rawById.set(pub.id, raw);
        notes.set(pub.id, note || '');
        GRIDS.set(pub.id, personGrid(raw));
        aggCache = null;
        TIMELINES.set(pub.id, [{ kind: 'friend', ts: NOW, source: 'manual', sourceId, meta: { became: true, manual: true } }]);
        // No source row to bump: `manual` is the in-app CRM path, not a reader
        // and not an emitter, so it never appears in sources.status() — exactly
        // as the real core reports it (only loaded plugin modules have state).
        return clone(pub);
      },
    },
    sources: {
      // Readers first, then emitters newest-delivery-first with the
      // never-delivered ones last — the same merge the core does.
      status() {
        // Reflect the live Steam credential state into its row.
        const steam = readers.find((x) => x.plugin === 'steam');
        if (steam) {
          steam.connected = !!steamCred;
          steam.account = steamCred ? steamCred.account : null;
        }
        const now = Date.now();
        const r = readers.map(({ agoMs, ...x }) => {
          const lastRun = agoMs == null ? null : now - agoMs;
          return {
            ...x,
            kind: 'reader',
            sources: x.source ? [x.source] : [],
            lastRun,
            lastReceivedAt: lastRun,
            ageMs: agoMs,
            health: healthOf('reader', lastRun, x.lastOk, now),
          };
        });
        const e = emitters
          .map(({ agoMs, ...x }) => {
            const at = agoMs == null ? null : now - agoMs;
            return {
              ...x,
              kind: 'emitter',
              lastReceivedAt: at,
              ageMs: agoMs,
              connected: at != null,
              health: healthOf('emitter', at, null, now),
              configurable: false,
              account: null,
              lastRun: at,
              lastOk: at != null ? true : null,
            };
          })
          .sort((a, b) => {
            if ((a.lastReceivedAt == null) !== (b.lastReceivedAt == null)) return a.lastReceivedAt == null ? 1 : -1;
            if (a.lastReceivedAt !== b.lastReceivedAt) return (b.lastReceivedAt ?? 0) - (a.lastReceivedAt ?? 0);
            return a.plugin.localeCompare(b.plugin);
          });
        return clone(r.concat(e));
      },
      // The loopback bearer token, on explicit request (SPEC §6). Fake, constant.
      token() {
        return { token: MOCK_TOKEN };
      },
      runNow(plugin) {
        const s = readers.find((x) => x.plugin === plugin);
        if (s) {
          s.agoMs = 0; // "just ran"
          s.lastOk = true;
        }
        return { ok: true };
      },
      // Dry-run validate WITHOUT saving (SPEC §6 sources.test).
      test(plugin, cfg) {
        if (plugin !== 'steam') return { ok: false, reason: `"${plugin}" is not configurable` };
        return steamValidate(cfg);
      },
      // Validate + save + (pretend to) kick a run (SPEC §6 sources.configure).
      configure(plugin, cfg) {
        if (plugin !== 'steam') return { ok: false, reason: `"${plugin}" is not configurable` };
        const res = steamValidate(cfg);
        if (!res.ok) return res;
        steamCred = { account: res.account, steamId: res.steamId, friendCount: res.friendCount };
        const s = readers.find((x) => x.plugin === 'steam');
        if (s) {
          s.connected = true;
          s.account = res.account;
          s.agoMs = 0;
          s.lastOk = true;
          s.nPersons = res.friendCount;
        }
        return { ok: true, connected: true, account: res.account, friendCount: res.friendCount };
      },
      // Forget the credentials (SPEC §6 sources.disconnect) — keeps synced people.
      disconnect(plugin) {
        if (plugin === 'steam') {
          steamCred = null;
          const s = readers.find((x) => x.plugin === 'steam');
          if (s) { s.connected = false; s.account = null; }
        }
        return { ok: true, connected: false, note: 'Steam credentials removed. Already-synced people are kept on this machine.' };
      },
    },
    settings: {
      get() {
        return clone(settings);
      },
      set(patch) {
        settings = { ...settings, ...clone(patch || {}) };
        return clone(settings);
      },
    },
  };

  /* Wrap every method so it resolves asynchronously with a small jittered
     delay — this is what makes the mock behave like ipcRenderer.invoke, and
     what makes loading states and stale-render races real here. */
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  function asyncify(ns) {
    const out = {};
    for (const [key, fn] of Object.entries(ns)) {
      out[key] = async (...args) => {
        await delay(10 + Math.random() * 20);
        return fn(...args);
      };
    }
    return out;
  }

  window.orbit = {
    __mock: true, // so the UI can be honest about being a standalone demo
    digest: asyncify(impl.digest),
    people: asyncify(impl.people),
    sources: asyncify(impl.sources),
    settings: asyncify(impl.settings),
  };
}
