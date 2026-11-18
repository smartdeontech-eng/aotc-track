# The agenda, measured against the congregation's own

AOTC Track, 27 August 2026. Written after the generated agenda was held up
against the congregation's own 30 July 2026 agenda and judged — rightly — to
look cruder than it.

The reference document is `_preview/`-adjacent only in spirit: the file itself
came from the Clerk. Everything below was **counted off it**, not guessed.

## What their agenda actually is

| | |
|---|---|
| Page | A4, margins top 450, left 873, right 877, bottom 142 twips |
| Masthead | in the page **header**: PRESBYTERIAN CHURCH OF GHANA (News Gothic MT bold 10pt), the crest (≈0.39in × 0.45in), ADABRAKA OFFICIAL TOWN CONGREGATION (News Gothic MT bold 11pt) |
| Title | News Gothic MT bold, **underlined**, centred, ordinal suffix **raised**: AGENDA FOR SESSION MEETING ON THURSDAY 30<sup>TH</sup> JULY 2026 |
| Table | 3 columns, **1881 / 4678 / 4249** twips *(this build uses 2141 / 4678 / 3989 — see below)*, fixed layout, pulled **180 twips left**, left cell margin **0**, right 115 |
| Column headings | Word's Heading 2 — the **major** theme face (Calibri Light), bold, **#1F4E79** |
| Body | the **minor** theme face — **Calibri 11pt**. Not the display face. |
| Numbered items | "1." and the title both **bold**, text at 451, number at 91 |
| Sub-items | "a)" and the text **plain**, text at 811 |
| Rules | one above each item, one below its last sub-item, **none between**; a single vertical rule after the Time column; no outer box |
| Paragraph rhythm | 100 twips before and after, single line spacing |

## The four faults, and why each one showed

1. **The display face was set on the table.** `agendaChildren` put News Gothic MT
   on every run. In their document only the masthead and the title are News
   Gothic MT; every measured run inside the table is Calibri. This was the
   single biggest reason the output read heavier and blockier — a display
   grotesque doing the work of a text face for forty lines.
2. **The columns were too narrow** — 1764 / 4388 / 3986 against their 1881 /
   4678 / 4249. So `6:30 pm (10 mins)` broke across two lines and *Update on
   Letter to Head Office* wrapped. Neither wraps in the real document, and
   nothing makes a table look cheaper than avoidable wrapping.
3. **The duration was bold.** `(10 mins)` in bold is wider than in plain, which
   is what tipped the Time column over the edge. Their document has the whole of
   it plain.
4. **The hanging indent left no room for a two-digit number**, so item 10 printed
   as `10.Closure` with the number touching the word.

Plus one the reference document has too, solved differently — see below.

## Where this build goes further than the reference

**The Responsible column stays level with its items.** Their agenda stacks the
item paragraphs in one cell and the names in another, and pays for it: the
moment an item wraps to two lines every name below it stands a line clear of the
item it belongs to. On the 30 July agenda one name had to be pushed down by hand
with an empty paragraph to get it back.

So this build gives **one table row per line of the agenda** — the numbered item,
then each of its sub-items — each paired in its own row with the name that
belongs to it. The rules are then drawn to keep the look: one above the numbered
item, one below the last of its sub-items, none between, so a reader still sees
one ruled block per agenda item. The Time cell is **vertically merged** down the
block, so the clock time is written once and centred against it — which is what
they do by hand on their own long rows.

Nothing wraps out of alignment any more, and nothing has to be nudged by hand.

## Whose item is it — the Responsible column says it two ways

The column has two different jobs, and they want doing differently:

**Review of Minutes** — the Session Clerk takes the whole item, both sets of
minutes under it. One name, merged down the block and **centred**, exactly as
the clock time is opposite it. It reads as one person's item rather than a name
stranded at the top of a list, and it is not repeated down the block as though
each set of minutes had its own person.

```
6:50 pm (15 mins) │ 4.  Review of Minutes
                  │     a)  11th June 2026 Session Meeting    Session Clerk
                  │     b)  9th July 2026 Session Meeting
```

**Matters Arising** — a different person answers for each heading beneath it, so
the column goes back to a name **per line**, level with the heading it belongs
to.

```
7:05 pm (20 mins) │ 5.  Matters Arising
                  │     a)  Update on Building Project        Ing. Sampson Agudze
                  │     b)  Update on Letter to Head Office   Rev. J. R. Tettey
```

The rule: **centre the item's own name when the item has sub-items, none of the
sub-items name anybody, and the item does.** All three conditions matter — the
third one was learned the hard way. Without `subs.length > 0`, Devotion (one
line, two people named) had its two-line name centred inside a one-line block,
which put it *above* its own row and printed it straight through the rule
between it and the column headings. In the PDF the same y is also floored at
`top + AG_ROW_PAD`, so a tall name can never climb out of its block whatever the
arithmetic says.

Considered and rejected: repeating the name against every sub-item. Nothing can
be misread, but it says each set of minutes had its own person, and a long block
repeats one name five or six times.

## Two things that were nearly bugs

- **The docx library writes a full default set of table borders** — outer box,
  `insideH` *and* `insideV` — if none are given, and only the cell borders were
  being set. LibreOffice let the cells win, so it rendered correctly here; Word
  is not obliged to, and the result there would have been the boxed grid this
  agenda was moved away from. They are now silenced explicitly. **Every rule on
  this table is drawn by a cell.**
- **An empty cell paragraph was dragging the minutes' Times New Roman into the
  agenda**, because the shared `p()` helper defaults to it. Empty cells now use a
  bare paragraph.

## The Time column, and why it is not 1881

The 30 July agenda's Time column is 1881 twips. The generated one copied that
and the times did not fit it. Measured at 11pt against the 88.3pt of usable
width 1881 gives:

| | Calibri / Carlito | Liberation Sans |
|---|---|---|
| `6:40 pm (10 mins)` | 80.9pt | **88.6pt — overflows** |
| `12:30 pm (10 mins)` | 86.5pt — 1.8pt spare | **94.8pt — overflows** |

Two faults, one symptom:

1. **The server had no Carlito**, so the PDF fell back to Liberation Sans, which
   is about 9% wider than Calibri. `6:40 pm (10 mins)` missed by 0.3pt, wrapped,
   and `mins)` printed *below the block's own bottom rule* — the strike-through
   look on the 27 August agenda.
2. **1881 was too tight even in the right font.** 1.8pt of clearance for a
   half-past start is luck, not a margin.

So the Time column is **2141** twips (101.3pt usable), and the 260 comes off the
Responsible column, which had 51pt of slack — its longest name, *Rev Joseph
Richmond Tettey*, is 161pt in a 212pt column. The table's overall width is
unchanged at 10808. Every realistic time now fits with room, in both faces:

```
6:30 pm (8 mins)     Carlito 75.3   Liberation 82.5    (101.3 available)
12:30 pm (10 mins)   Carlito 86.5   Liberation 94.8
12:45 pm (105 mins)  Carlito 92.1   Liberation 100.9
```

`agenda-format-check.js` measures these strings in the real font rather than
trusting the number, so a future change to the column or the face fails loudly.

### And the height bug underneath it

The PDF computed each block's height from the Item and Responsible text **only**
— it never counted the Time, nor a centred whole-block name. So a Time that
wrapped was always going to print past the rule, whatever the column width.
`asideH` now measures both and grows the block's last line to fit. Widening the
column hides this fault; fixing the arithmetic removes it.

### Carlito is bundled

`utils/fonts/Carlito-Regular.ttf` and `-Bold.ttf` ship with the app and are
tried **before** anything on the box, so the PDF is set in Calibri metrics
wherever it runs and no longer depends on the server having a font package.
SIL OFL 1.1, licence beside them. The earlier note to `apt install
fonts-crosextra-carlito` is obsolete.

**Still not identical between the two formats:** the masthead and title. The
Word file's are News Gothic MT, which comes from the template; the PDF sets them
in the bundled sans, because News Gothic MT is not a face that can be shipped.
Everything inside the table now matches exactly.

## The PDF

`buildSessionAgendaPdf` boxed every cell in a full grid, in Helvetica, with no
numbering and the sub-items bold — it read like a spreadsheet. It is now drawn
to the same measurements as the Word file, and the two are held to each other by
`agenda-format-check.js`.

Its face is **Carlito**, which is metrically identical to Calibri, falling
through to Calibri itself, Liberation Sans, then DejaVu Sans. **On the server:
`apt install fonts-crosextra-carlito`** — without it the PDF still builds but
stops matching the Word file line for line. Its masthead and title are set in
that sans too, not the minutes' serif, because the Word agenda's are News
Gothic MT.

## Working on this

```bash
node agenda-preview.js      # builds both formats into _preview/ and rasterises page 1
node agenda-format-check.js # 58 checks, measured off their document
```

**Render and look.** Both formats have shipped visually broken output that passed
every XML assertion. `_preview/` is excluded from the deploy.

If a check here fails, hold the output against the real document before changing
the number in the check.
