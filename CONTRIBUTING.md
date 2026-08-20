# Contributing to NX Orbit

Thanks for wanting to help. NX Orbit has an unusual bar for contributions: **the
ethics are part of the API.** A PR that runs perfectly but crosses the charter is
declined; a PR that respects the charter but needs code work is welcome and we'll
help finish it.

## The charter is non-negotiable (SPEC §0)

Before anything else, read [`SPEC.md §0`](SPEC.md). NX Orbit is deliberately the
inverse of a people-profiler. Every contribution is measured against it:

1. **First-person only** — only data your own logged-in account already shows you
   about your own friends. No strangers, no scraping, no bought or correlated
   third-party data.
2. **Local only** — no server, no sync, no telemetry, no outbound network beyond
   a plugin reading its own local source and fetching a friend's own avatar for
   display.
3. **No inference about people** — arithmetic on timestamps you already have.
   Never predict, score, rank, or infer anything a person didn't state.
4. **Subject-first** — if a friend seeing their own Orbit card would feel creeped
   out rather than waved at, the feature is wrong.
5. **Forgetting is a feature** — retention windows and one-click hard-delete stay
   intact; don't add a code path that resurrects forgotten data.

If you're unsure whether an idea fits, open an issue describing it in terms of
"what a friend would see and feel." That framing usually answers it.

## Test data, fixtures and mocks must be invented

Never paste a real person into this repository. Not a display name, not a
handle, not a bio, not a user id, not a status message — and not "just as a
tricky Unicode example," which is exactly how a real friend's name once ended up
in `src/renderer/mock.js`. The same goes for places: which venues someone
frequents is itself personal, so invent world and server names too.

If you need a pathological case (RTL overrides, zalgo, astral-plane glyphs,
76-character walls), construct one. `mock.js` shows how — the hard names are
built from escapes and generators, and every one of them is made up. A repo
whose whole point is not collecting people should not ship people in its
fixtures.

## What we will not accept, ever

- A `kind`, field, or plugin that carries message/DM content, keystrokes,
  precise location beyond what a person published, sentiment, desirability
  scores, or any predicted schedule.
- Any outbound sync, "cloud backup," account system, or multi-user/"profiles for
  others" feature. Orbit has exactly one subject: the operator.
- A source plugin that reads anyone who isn't the operator's mutual/friend/
  followed account, or that reaches data the source app hides from the operator.

## Working in the codebase

- Electron 31, **ES modules, no framework, no bundler, no TypeScript** in the
  app (Vencord plugins are TS because that host is). Node built-ins first;
  `node:sqlite` is the datastore — don't add native deps.
- `SPEC.md` is the frozen contract. Change interfaces in the main loop and update
  `SPEC.md` in the same PR; never diverge from it silently.
- Own only your area (SPEC §7 ownership map). Match the NX design language
  (`docs/DESIGN.md`, tokens in `src/renderer/tokens.css`).
- `npm test` (Node's built-in runner) must pass. Add tests for new derivations
  and for any plugin's record mapping.

## Adding a source plugin

Read [`docs/PLUGIN_GUIDELINES.md`](docs/PLUGIN_GUIDELINES.md) — it is the full
contract, with a checklist. The reference implementation is the in-process VRCX
reader (`src/main/plugins/vrcx.js`). Your plugin's own README must state exactly
what it reads and why every field is first-person-visible.

## Commit / PR

- Small, focused commits. Describe *what a friend would see* for any
  data-touching change.
- By contributing you agree your work ships under MIT and abides by the charter.
