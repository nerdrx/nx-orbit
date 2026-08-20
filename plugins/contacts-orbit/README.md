# contacts-orbit

A tiny standalone Node CLI (ES modules, **zero dependencies**) that feeds
[NX Orbit](../../SPEC.md) the **birthdays already sitting in your own address
book**.

VRChat's API doesn't expose friends' birthdays. Neither does Discord. So Orbit's
birthday board (SPEC §5 `upcomingBirthdays`) starts out nearly empty — the one
feature that needs no event history has no data. Your own contacts *do* have
birthdays. This reads them.

## What it reads

**Files you hand it. Nothing else, ever.**

- **vCard** — `.vcf`, versions 2.1 / 3.0 / 4.0
- **iCalendar** — `.ics` (birthday `VEVENT`s)

exported from an address book **you already own**: Google Contacts, Nextcloud,
Thunderbird, Apple Contacts, DAVx5, Evolution, a phone backup.

There is **no network access to any contacts provider**. No OAuth, no CardDAV
client, no "sync my Google account," no lookup or enrichment service. The only
socket this program opens is the POST to `127.0.0.1`. Read
[`index.js`](index.js) — the imports are `node:fs/promises`, `node:http`,
`node:crypto`, `node:os`, `node:path`, `node:url`.

> ### Charter note (SPEC §0)
>
> This is the operator's own address book: data you already have, about people
> who gave you their contact card. It is the most first-person source Orbit has.
> Two things follow:
>
> 1. **Run `--dry-run` first.** It prints the exact batch that would be
>    ingested, POSTs nothing, and touches no snapshot. Read it before you ingest
>    an address book — you'll see precisely which fields leave the file.
> 2. **Only feed it contacts of people you actually know.** An address book can
>    hold plumbers, recruiters, and a person you met once in 2014. Orbit is for
>    *friends you keep up with* (§0.4), not a contact database. Export a group,
>    not the whole book, if your book is a junk drawer.

## Fields, and where they land

| vCard / iCalendar | Orbit `Person` field | note |
| --- | --- | --- |
| `FN` (or `N`, or `NICKNAME`) | `displayName` | a card with no name at all is skipped |
| `NICKNAME` | `handle` | first entry of the list |
| `BDAY` | `birthday` | `YYYY-MM-DD`, or `MM-DD` when no year was stated |
| `item1.X-ABDATE` + `X-ABLABEL:…Birthday…` | `birthday` | Apple Contacts variant |
| `X-ANDROID-CUSTOM:…contact_event;<date>;3` | `birthday` | Android type `3` = birthday |
| `UID` | `sourceId` | falls back to `sha1(normalised FN)` |
| `NOTE` | `note` | SPEC §2.1 `note` is explicitly *your* private note about them — a contact-card note is exactly that |
| `VEVENT` marked as a birthday | a person + `MM-DD` | see below |
| everything else (`TEL`, `EMAIL`, `ADR`, `ORG`, photos…) | **dropped** | Orbit has no field for it and won't invent one |

**No observations are emitted, ever.** A contact card is static identity data,
not an event stream — the batch always carries `"observations": []`, which SPEC
§3 explicitly allows.

## Birthdays: a year is never invented

SPEC §2.1: `birthday: "MM-DD" | "YYYY-MM-DD"` — *"NO year unless they stated
it."* Handled shapes:

| input | result | why |
| --- | --- | --- |
| `BDAY:1991-04-23` | `1991-04-23` | year stated |
| `BDAY:19851124` | `1985-11-24` | ISO basic format |
| `BDAY:1991-04-23T00:00:00Z` | `1991-04-23` | time part dropped |
| `BDAY:--0517` (vCard 4.0) | `05-17` | year deliberately omitted by the exporter |
| `BDAY:--05-17` | `05-17` | same, extended form |
| `BDAY;X-APPLE-OMIT-YEAR=1604:1604-03-09` | `03-09` | `1604` is Apple's "no year" sentinel, not a year |
| `BDAY:sometime in May` / `--0000` / `1991-13-01` | *(dropped)* | unusable beats guessed |
| an `.ics` birthday event | **always `MM-DD`** | see below |

**Why `.ics` birthdays lose their year:** a birthday in a calendar is a
`FREQ=YEARLY` recurring event, and exporters disagree about what `DTSTART`'s year
means — some write the birth year, many write the year the event was created. A
year that might be the birth year is not a year the person stated, so it is
dropped. A missing year beats a fabricated one.

## iCalendar: which events count as birthdays

A `VEVENT` is treated as a birthday when **any** of these holds:

- `CATEGORIES` contains `Birthday` (Google Contacts / Nextcloud write this), or
- it carries an `X-…BIRTHDAY…` property, or
- it has `RRULE:FREQ=YEARLY` **and** a summary matching a birthday pattern
  (`Ada's Birthday`, `Birthday of Ada`, `Birthday: Ada`, `Ada has a birthday`,
  `🎂 Ada`, `Geburtstag von Ada`).

The person's name is the captured group, or the whole `SUMMARY` when the event
was already identified as a birthday by `CATEGORIES`/`X-`. Everything else in
your calendar (`Dentist`, standups, flights) is ignored — this plugin reads
birthday events, not your schedule.

## vCard parsing details

Real exports are messier than the RFC suggests, so:

- **Line folding (RFC 6350 §3.2)** — a line starting with a space or TAB
  continues the previous one. Exactly one leading whitespace character is
  removed and nothing is inserted, so a name folded mid-word (`Lo` + ` ves`)
  rejoins as `Loves`, not `Lo ves`.
- **Escaping (RFC 6350 §3.4)** — `\,` `\;` `\:` `\\` become the literal
  character; `\n` / `\N` become a newline. An escaped separator does **not**
  split a structured or list value.
- **`QUOTED-PRINTABLE`** (vCard 2.1 exporters — Android, old phones) — `=C3=AB`
  is decoded as UTF-8 bytes, and a QP **soft line break** (a QP line ending in
  `=`) joins with the next line.
- **Quoted parameters** — `TYPE="a:b"` doesn't confuse the name/value split.
- **Groups** — `item1.X-ABDATE` / `item1.X-ABLABEL` are matched by their group
  prefix, which is how Apple attaches labels to dates.

## Identity: no fuzzy matching, ever

`sourceId` is the card's `UID` when it has one, otherwise a SHA-1 of the
normalised (lower-cased, whitespace-collapsed) formatted name. Records sharing a
`sourceId` are merged — that is **deduplication inside your own address book**,
not identity matching.

The same human appearing in both a `.vcf` and an `.ics` therefore arrives as
**two person rows**. That is deliberate. SPEC §2.1: Orbit *never* guesses that
two identities are the same human.

### Linking contacts to your VRChat / Discord friends

Your contacts often *are* the same humans as your VRChat or Discord friends —
that's the point of ingesting them. Orbit models this with `person_link`, and
**only you** assert it:

- In Orbit, open a person and use **link** (`orbit.people.link(idA, idB)`,
  SPEC §6) to say "this `contacts` person is the same human as this `vrcx` one."
- Once linked, the birthday from your address book shows on the friend's card,
  and the heatmap/overlap data from VRChat or Steam shows on the same card.

contacts-orbit deliberately makes **no attempt** to match on name similarity,
avatar, or anything else, and never emits a `links` array. Fuzzy identity
matching across platforms is exactly the kind of inference §0.3 forbids.

## Usage

```bash
# ALWAYS start here — see exactly what would be ingested, POST nothing:
node index.js --dry-run --file contacts.sample.vcf --file birthdays.sample.ics

# A whole export folder:
node index.js --dry-run --dir ~/Downloads/contacts-export

# Real run — POST to Orbit on the default port 8477:
node index.js --file ~/exports/contacts.vcf

# Include contacts that have no birthday, with an explicit token and port:
node index.js --file ~/exports/contacts.vcf --all --port 8477 --token nxo_live_…
```

Flags:

| flag | meaning |
| --- | --- |
| `--file <path>` | a `.vcf` or `.ics` you exported yourself (repeatable) |
| `--dir <path>` | every `.vcf`/`.ics` directly inside this directory (repeatable) |
| `--all` | also ingest contacts with no birthday (default: skip them) |
| `--full` | ignore the snapshot and re-emit every contact |
| `--dry-run` | print the batch to stdout instead of POSTing; snapshot untouched |
| `--port N` | loopback ingest port (default `8477`) |
| `--token TOKEN` | ingest bearer token (see resolution order below) |
| `-h`, `--help` | usage |

By default a contact with **no** birthday is skipped: it would be a name in your
roster that no Orbit feature can use. `--all` overrides that if you want the
address book as a roster.

## Configure the token

Resolution order (first hit wins):

1. `--token <TOKEN>` flag
2. `NX_ORBIT_TOKEN` environment variable
3. `~/.config/nx-orbit/ingest.token`

Copy the token from **NX Orbit → Settings → Sources**. Rotating it there
invalidates the old one.

## Change detection (idempotent)

A snapshot at `~/.config/nx-orbit/contacts-orbit.snapshot.json` stores a
fingerprint per contact. A re-run with an unchanged export emits **nothing** and
exits `0`; edit a note or add a birthday and only that person is re-emitted.
The snapshot advances only on an accepted (`200`) batch, and `--dry-run` neither
reads nor writes it. `--full` re-emits everything.

Address books change rarely — run this by hand after you export, or from a
weekly timer. There is nothing to poll.

## The batch it POSTs

```
POST http://127.0.0.1:8477/ingest
Authorization: Bearer <your Orbit ingest token>
Content-Type: application/json
```

Example body, trimmed from `--dry-run` over the two bundled samples:

```json
{
  "plugin": "contacts-orbit",
  "version": "1.0.0",
  "emittedAt": 1787245848433,
  "persons": [
    {
      "source": "contacts",
      "sourceId": "urn:uuid:6f0a1b3c-1111-4a2b-9c3d-000000000001",
      "displayName": "Ada Ramirez",
      "handle": "adarama",
      "birthday": "1991-04-23",
      "note": "met at Framework's world, likes DnB. Ask about the modular synth; she is building one."
    },
    {
      "source": "contacts",
      "sourceId": "urn:uuid:6f0a1b3c-1111-4a2b-9c3d-000000000002",
      "displayName": "Bo Lindqvist",
      "handle": "bo",
      "birthday": "05-17",
      "note": "Does not share the year, and that is fine — Orbit keeps it as MM-DD. Loves cold-water swimming and will tell you about it."
    },
    {
      "source": "contacts",
      "sourceId": "43fc6a6db144a983f4449311b2a167966d4a9d3e",
      "displayName": "Zoë Smíth",
      "birthday": "1985-11-24",
      "note": "met at the Berlin meetup\nbrings the good coffee"
    },
    {
      "source": "contacts",
      "sourceId": "apple-abcd-0004",
      "displayName": "Kenji Watanabe",
      "birthday": "03-09"
    },
    {
      "source": "contacts",
      "sourceId": "edc0979c4e2f3c287b06201691887967cad34336",
      "displayName": "Priya Raman",
      "birthday": "05-17"
    }
  ],
  "observations": []
}
```

## The sample files

- [`contacts.sample.vcf`](contacts.sample.vcf) — vCard 3.0 + 4.0 + 2.1 mixed:
  a full `BDAY`, a year-less `BDAY:--0517`, a folded mid-word `NOTE`, escaped
  `\,` and `\;`, a `QUOTED-PRINTABLE` card with a soft line break, an Apple
  `X-APPLE-OMIT-YEAR` card, an `item1.X-ABDATE` card, an Android
  `X-ANDROID-CUSTOM` card, and one contact with no birthday at all.
- [`birthdays.sample.ics`](birthdays.sample.ics) — a Google-style
  `CATEGORIES:Birthday` event, an `X's Birthday` + `RRULE:FREQ=YEARLY` event, an
  `X-`-marked event with a folded `DESCRIPTION`, and a dentist appointment that
  must be ignored.

```bash
node index.js --dry-run --file contacts.sample.vcf --file birthdays.sample.ics
node --test ../../test/contacts-orbit.test.js
```

The test suite validates the emitted batch against a transcription of SPEC §3
*and* against the real `src/main/ingest.js` validator.

## License

MIT © 2026 nerdrx.
