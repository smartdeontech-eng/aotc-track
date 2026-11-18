# Matters Arising: the register holds the detail, the agenda carries the heading

AOTC Track. Written 27 August 2026, mid-implementation; **finished and tested
27 August 2026**, not yet deployed at the time of writing — see *State of play*.

## The problem this solves

The AI reads a set of minutes and extracts outstanding matters accurately, item
by item. That precision is right for the register: the Session needs to know
that a second legal counsel was to be obtained, and separately that the
consultants had not yet responded. Both are real, both are outstanding, both
should be tracked to their own conclusion.

But an agenda that lists both as separate lines is wrong. On the night, the
Session does not take "second legal counsel" and "consultants' response" as two
items. It takes **Update on Building Project**, and everything outstanding on the
building project is dealt with under it.

So the register and the agenda need different grains:

| | grain | why |
|---|---|---|
| **Outstanding Matters register** | one entry per issue | each is tracked, chased and cleared on its own |
| **Matters Arising on the agenda** | one line per heading | that is how the Session actually takes them |

Dealing with the heading deals with everything gathered beneath it.

## The shape

Every register entry carries a `heading` — the agenda item it belongs under, in
the minutes' own words:

```
heading: "Update on Building Project"
subject: "Second legal counsel on the contractor's claim"
detail:  "The Session asked that a second legal opinion be obtained…"
owner:   "Ing Sampson Agudze"
status:  "in-progress"
```

`heading` falls back to `subject` when it is blank, so an entry typed straight
into the register without one still reaches the agenda as itself rather than
disappearing into a nameless group.

## The sub-item label is the act, not the whole instruction

The heading grain was the first half of this. The second half is how each item
*beneath* the heading is labelled, and getting it wrong makes the register
unreadable even when the grouping is right.

The minutes write an outstanding item as a full instruction. Taking the first 80
characters of it — which is what the code did — gives a line that is too long to
scan and cut mid-word. What distinguishes one sub-item from another is **the
act**, not the qualification of it, so `shortSubject` cuts the trailing
qualifier and keeps the act:

| the minutes say | the sub-item reads |
|---|---|
| Letter to contractor regarding reverting to original contract terms and requesting for meeting | Letter to contractor |
| Seeking legal counsel before proceeding with termination of contractor | Seeking legal counsel |
| Submission of letter to head office with copies to clerk | Submission of letter to head office |
| Write to the consultants in respect of the reviewed claim | Write to the consultants |
| Repair of the chapel roof | Repair of the chapel roof |

`SUBJECT_TRAILER` is the list of qualifier openings — *regarding, concerning,
pending, before, after, in respect of, in connection with, with copies, and
requesting, so as to, in order to*. The cut is refused if it would leave a
single word, because "Letter" is not a sub-item and "Letter to contractor" is.
Nine words and 70 characters at the outside — a sub-item may run a little
longer than a heading, since it has to be told apart from its siblings.

**Nothing is lost.** The full instruction goes to `detail`, where the Session
can read what was actually asked.

Both `shortHeading` and `shortSubject` first run `dropReportingFrame`, because
"It was reported that…" and "A concern was raised about…" are how the minutes
narrate, never part of the concern itself.

### The bug this turned up

`openItemsOf` set an item's subject to `row.subject || fallbackSubject` — the
section's subject when the row had none of its own. So every item under "Update
on Building Project" was *labelled* "Update on Building Project", identical to
its heading, and the register showed a heading with a copy of itself beneath it.
The item's own label now falls back to the action it was given, never to the
section. The section's subject belongs to the heading; a sub-item that repeats
its heading word for word tells the Session nothing.

### How it reads

```
Update on Building Project        [2 open · Ing Sampson Agudze]
   · Letter to contractor
   · Seeking legal counsel

Letter to Head Office             [1 open · The Session Clerk]
   · Submission of letter to head office

Washrooms at the chapel           [1 open]          <- from "Other Matters"
   · Washrooms at the chapel are in a poor state

Security of the manse at night    [1 open]          <- from "Other Matters"
   · Security of the manse at night
```

and the next agenda:

```
5.0  Matters Arising
     5.1  Update on Building Project        Ing Sampson Agudze
     5.2  Letter to Head Office             The Session Clerk
     5.3  Washrooms at the chapel
     5.4  Security of the manse at night
```

## Container labels are not headings

Some Subject lines are containers, not subjects. **Other Matters** holds the
state of the washrooms and the security of the manse in the same breath.
Carrying "Other Matters" onto the next agenda does neither any good: it names no
concern and it welds two unrelated ones onto one line. So where the parent item
is a container, the heading is taken from the matter's own words instead.

`CATCHALL_HEADINGS` in `utils/sessionMinutes.js` is the list — Other Matters,
Any Other Business, A.O.B., Matters Arising, General/Miscellaneous, Announcements,
Correspondence, and the procedural items (opening, closing, benediction,
devotion, attendance, agenda, minutes). `isCatchAllHeading` tests it, ignoring a
leading item number.

`shortHeading(text)` composes the replacement, and it is worth knowing how,
because a naive word-count truncation was tried first and read badly:

1. the reporting frame is dropped — "It was reported that", "A concern was
   raised about", "The Session was informed that";
2. the first clause only, cut at punctuation or at *which / because / so that*;
3. **cut at the predicate.** What is left reads "*<the thing> <is doing
   something>*", and the area of concern is the thing. Cutting at the verb turns
   "the washrooms at the chapel are in a poor state" into **Washrooms at the
   chapel**. Truncating at six words would have given "Washrooms at the chapel
   are in", which is why the predicate cut exists;
4. six words and 60 characters at the outside.

Measured against real phrasings:

| the minutes say | the heading becomes |
|---|---|
| It was reported that the washrooms at the chapel are in a poor state and need urgent repair | Washrooms at the chapel |
| A concern was raised about the security of the manse at night, which… | Security of the manse at night |
| The Session was informed that the church bus has broken down again | Church bus |
| It was noted that the quotas to the General Assembly have not been paid | Quotas to the General Assembly |
| Repair of the chapel roof | Repair of the chapel roof |

`headingFor(subject, parentSubject, body)` puts the three in order of trust: the
item's own subject if it is a real subject, then the parent's, then a heading
composed from the body. `matterHeading(m)` applies the same fall-through when
reading a record back, so a container that reached the data before this existed
corrects itself on the next render rather than needing a migration.

## Where the heading comes from

Four ways, and the container rule applies to all of them:

1. **The AI extraction.** `MATTERS_PROMPT` asks for the heading as a separate
   field, tells the model to copy the numbered item's own Subject line rather
   than compose one, warns that several matters sharing a heading is expected,
   and carries two worked examples — three matters under two headings, and a
   container split into two named concerns. The response is **not** taken on
   trust: `proposeMatters` runs every returned heading back through
   `headingFor`, so a returned "Other Matters" is replaced rather than stored.
2. **Bringing matters across from a set of minutes.** `openItemsOf` knows the
   parent section's subject and passes it through `headingFor` with the row's
   action as the body, so an item under "Other Matters" arrives named.
3. **The route that saves them.** `POST /minutes/matters/from/:docId` sets the
   heading through `headingFor` too — it previously dropped the field entirely,
   which meant anything brought in from minutes arrived headless.
4. **By hand.** The register form has an *Agenda heading* box above Subject with
   a datalist of headings already in use, so a typed entry joins an existing
   group instead of starting a near-duplicate — "Building Project" and "Update
   on Building Project" would otherwise be two agenda lines. `matterPatch`
   refuses to store a container label.

## How the agenda is built from it

`groupByHeading` gathers the open matters by heading, in the order first met,
case-insensitively. Where every matter under a heading names the same person,
that person becomes the heading's owner; where they name different people, the
agenda leaves it blank rather than putting one person's name against other
people's work.

`GET /minutes/matters` returns these as `headings`, alongside the flat `matters`
list it already returned. The **⤢ Bring in from the register** button on the
Matters Arising row uses `headings`, so the agenda gets:

```
5.0  Matters Arising
     5.1  Update on Building Project          Ing Sampson Agudze
     5.2  Update on Letter to Head Office     The Session Clerk
     5.3  Chapel Washrooms
```

not seven lines of detail. The toast says what happened in both grains —
*"3 headings brought in, covering 7 matters."* Anything already on the agenda is
left alone, so the button is safe to press twice.

## The register page

The page groups by heading, because that is the grain the Session works in on
the night. Each card is one heading; beneath it, on a rule, are the sub-notes it
gathers. The heading itself is not a record and cannot be cleared — **each
sub-note is cleared on its own**, and the card shows "2 of 3 still open" so the
Clerk can see at a glance what is left. Once the last sub-note is cleared the
card dims and says it will not appear on the next agenda, which is exactly what
`groupByHeading` then does.

An overdue or stale sub-note raises the flag onto its heading, so a matter going
cold is visible without opening the group.

## Clearing a heading

Two grains, two actions, and both are needed.

Each sub-note has its own **Mark cleared**, because a matter is cleared on its
own merits: the letter to the contractor may go out while the legal counsel is
still awaited. That is the register doing its job.

But once the Session has taken *Update on Building Project* and finished with
it, opening each sub-note in turn is busywork. So the heading card also carries
**Clear the whole heading**, which closes every sub-note still open beneath it
after a confirmation naming how many. Sub-notes already closed are left
untouched, so their closing dates are not rewritten. The writes go one at a
time rather than in parallel, so a failure part way through is visible instead
of leaving the register in a state nobody asked for.

The button names its group **by position**, not by pasting the heading text into
an onclick attribute — a heading with an ampersand or an apostrophe in it has no
business travelling through HTML.

## Choosing what comes onto the agenda

Taking the whole register every time is wrong: not everything the Session is
carrying is for tonight. **⤢ Bring in from the register** now opens a panel —
one scrollable tickable line per heading, with the sub-notes it gathers listed
beneath so the Clerk can see what dealing with it would cover, plus *Tick all* /
*Untick all* and a running count in both grains: *"2 headings selected, covering
3 matters."*

A heading already on the agenda is shown greyed and cannot be ticked, so nothing
is added twice — and *Tick all* cannot re-tick it either.

`pickFromRegister` lives in `public/js/agenda-editor.js` alongside
`fromRegister`, and builds its own overlay, so both agenda editors — the
Meetings page and the Agenda tab of the Minutes page — get it without either
page growing markup for it. That file exists precisely because these two once
lived in separate copies and drifted; keep new agenda behaviour in it.

## The Review of minutes row

Same idea, different row, and worth recording here because it shares the
machinery.

The Review of minutes row names the sitting whose minutes are being taken. The
Clerk used to type it, and a typed date is a date that will not match: the
minutes page finds the sitting by looking for its date *inside* the sub-item
text, so "11/6/26" or "11 June" finds nothing and the corrections and the mover
list then line up with no meeting at all.

So the row carries a dropdown of the sittings the app holds, **most recent
first, five at most** — ten made the list a chore and nobody reviews that far
back; five reaches a set deferred a couple of meetings running. Tonight's own
sitting is never offered, nor is anything later than it. Picking 11 June 2026
writes:

```
5.0  Review of minutes                                    Session Clerk
     5.1  Review of minutes for 11th June 2026 Session Meeting
```

as a sub-item, leaving the row itself alone — which is the form
`reviewOptions()` in `utils/sessionMinutes.js` already reads, so the pick flows
straight into the minutes' review section. A meeting with a title of its own
keeps it: *"Review of minutes for 14th May 2026 Emergency Session Meeting"*.

**The dropdown stays on the row after a pick**, its placeholder changing from
*"+ minutes being reviewed…"* to *"+ another set of minutes…"*, so a second
sitting can be added — one sub-item per set. A sitting already named drops out
of the list, and a date the Clerk typed by hand earlier is recognised rather
than duplicated. Where there is nothing left to offer the dropdown is not
rendered at all, because an empty dropdown reads as a broken one.

A sitting already named is **blocked everywhere**, not just on the row that
took it. `reviewChoices` and `addReview` both take the whole agenda and scan
every review row on it, so an agenda with two review rows cannot offer the same
sitting twice and hand the Session the same minutes to adopt in two places.

### Regular sittings and emergency sittings

The Session sits regularly, and now and then it is called together urgently.
Which of the two a meeting was is not decoration: the minutes are headed by it,
and next month's agenda has to read *"Review of minutes for 14th May 2026
Emergency Session Meeting"* rather than quietly calling it an ordinary sitting.

So it is settled **at scheduling**, where the Clerk knows the answer. The
Schedule dialog's free-text Title box is now a dropdown of the two kinds, with
*"Something else — give it a title…"* for the rare sitting that is neither.
`MEETING_KINDS` lives in `utils/sessionMinutes.js` and is **served** by
`GET /minutes/venues` rather than hardcoded in the page, so the labels cannot
drift from the ones the documents are headed with.

`title` remains the field the documents read, so nothing downstream changed; the
kind is what decides the title. Three functions hold it together:

- `meetingKindOf(doc)` — the stored kind, or, for a meeting recorded before this
  existed, read from the title the Clerk typed. That is how emergency sittings
  were distinguished until now, so no migration is needed.
- `meetingTitleOf(doc)` — what to call it in a sentence. The two standard kinds
  are always named the standard way, so a legacy *"AOTC Session Meeting"* reads
  as *"Session Meeting"* on next month's agenda instead of dragging the prefix
  along. A title the Clerk wrote himself — *"Joint Session and Committee
  Sitting"* — is nobody's business to rewrite, and is left exactly as it is.
- `GET /minutes` returns `meetingKind` and `kindLabel` on every row, so the
  Review dropdown does not have to guess from the title.

Correcting the kind afterwards renames the meeting with it — unless the Clerk
gave it a title of his own, which is kept while the kind is still recorded.

`ordinalDate` now exists in **two** places — `agenda-editor.js` for the browser
and `utils/sessionMinutes.js` for the server — and the whole thing rests on them
agreeing. `review-pick-check.js` asserts they do; if you change one, that check
fails, which is the point.

## The loop this closes

```
Session defers something
   → it goes on the register, with its heading
   → the heading appears on the next agenda under Matters Arising
   → it is discussed
   → the outcome goes back on the register, sub-note by sub-note
   → each sub-note is cleared on its own
   → the heading stops appearing once the last one is cleared
```

## State of play

**Done, tested, not yet deployed.**

- `heading` through the model, the AI prompt and its guard, the register routes,
  the form, and the two agenda editors
- the container rule: `CATCHALL_HEADINGS`, `isCatchAllHeading`, `shortHeading`,
  `headingFor`, applied at every point a heading is set or read
- the register page grouped by heading with individually clearable sub-notes
- the heading datalist, populated from headings already in use
- the sub-item labelling rule: `SUBJECT_TRAILER`, `shortSubject`,
  `dropReportingFrame`, and the `openItemsOf` fallback bug it exposed
- the heading-level clear, alongside the per-sub-note one
- the import picker: `pickFromRegister`, used by both agenda editors
- `matters-headings-check.js` — 83 checks, including scheduling an emergency
  sitting over the wire
- `register-dom-check.js` — 29 checks, the page rendered into a real DOM
- `agenda-pick-check.js` — 28 checks, the register picker driven in a DOM
- `review-pick-check.js` — 56 checks, the Review of minutes dropdown, the
  cross-agenda blocking, and the two kinds of sitting

**Not done:** `browser-check.js` was not run — see the note in
`CONTINUATION.md` §2. Run it before trusting the button in anger.

## Still outstanding from earlier, unrelated

The **17 open matters extracted from the 2026 minutes have never been loaded
into the app.** Until they are, the register is empty and the button finds
nothing — which is exactly what was reported on 27 August when an agenda for
that evening's meeting came up with no Matters Arising. Three were
time-critical and one has passed: Rev Kofi Manukure Akyeampong took over as
District Minister on 1 September with nothing recorded about the handover.
