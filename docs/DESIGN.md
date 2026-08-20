# NX Orbit — design notes

Orbit inherits the NX design language wholesale (liquid glass on deep space;
canonical spec in `nx-hub/docs/DESIGN.md`, tokens vendored in
`src/renderer/tokens.css`). This file only records the **Orbit-specific**
decisions on top of it.

## Identity accent

Per the NX rule that an app may carry **one** app-specific color for its core
domain signal, Orbit's is **`--orbit-live` (cyan `#00e5ff`)** — but note it
overlaps the suite's existing "light inside materials" cyan on purpose: Orbit's
whole domain *is* presence, so the live-status light and the material light are
the same idea. It marks **only** "this friend is online right now" (the status
dot, the live ring on an avatar). It never becomes an action color (violet leads
every action), never means danger, never a generic status. Offline/idle friends
get no accent — just muted glass.

## The heatmap must never look predictive

The overlap heatmap is the feature most at risk of *reading* like surveillance,
so its presentation is constrained:

- It is always labeled as a **histogram of the past** ("hours you were both
  online"), never phrased as "when they'll be on" or "best time to catch them."
- Intensity is a plain violet ramp (low-alpha → `--violet`), the same material
  language as everything else — not a heat/threat red-orange ramp.
- No alerts, no "they're usually on now" nudges, no real-time tracking. It's a
  quiet retrospective grid you glance at, like reading a friends list.
- Cells are angular (echo the crystal facet), never rounded blobs.

## Tone in copy

Orbit's microcopy waves, it doesn't watch. "Around now," not "currently
tracked." "Keep up with," not "monitor." "Forget this person," framed as a
courtesy you extend, not data you lose. The Sources screen states "local only —
nothing leaves this machine" plainly, because that's the product.

## Person card

The card is a friend, not a dossier. Order: their name + live status, the
birthday they shared (or nothing), **your** note, then a quiet timeline. No
scores, no "risk," no derived traits — there is nowhere in the schema for them,
by design (SPEC §2).

## Motion

Standard NX: one upper-left light source; specular sheen tracks pointer/scroll,
never a timed flash; everything decorative freezes under
`prefers-reduced-motion`. The only continuous motion is the live-status dot's
slow breath (a real, present signal), which also stills under reduced motion.
