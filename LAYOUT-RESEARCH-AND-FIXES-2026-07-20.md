# AOTC Track — Layout Presentation: Research & Fixes

**Date:** 20 July 2026
**Scope:** Data-dense areas (tables, grids, information-heavy forms) on mobile and desktop equally.
**Files touched:** `public/css/style.css` (only). No HTML/JS changes were needed — the shared stylesheet drives every page.

---

## 1. What the best sources say

I reviewed two of the most-cited references on presenting dense data on the web, alongside the established responsive-design consensus.

**Chris Coyier — "Responsive Data Tables" (CSS-Tricks).** The core problem: a data row must stay together to make sense, so a wide table can only shrink so far before it either becomes unreadably small or forces two-axis scrolling. His recommended fix is to detect narrow screens with a media query and *reformat* the table — turn each row into its own labelled block using `data-label` attributes read by CSS, so no horizontal swiping is needed.

**Huijing Chen — "Table Design Patterns on the Web" (Smashing Magazine).** Lays out the full menu of options and, crucially, that the right choice depends on the data:

- **Do nothing** — fine for few columns; just cap the max width so it doesn't sprawl on big screens.
- **Style the scroll** — keep the table intact and let it scroll sideways *inside its own container*, ideally with a scroll affordance, so the page itself never grows wider than the screen.
- **Rows to blocks** — the stacked-card reformatting above, best for many-column tables on phones.
- **Column toggle** — hide non-essential columns on small screens with a control to bring them back.

The throughline from both, and from general responsive practice, is a small set of rules:

1. Never let anything exceed the viewport width; contain overflow *locally* (in the card/table), never on the whole page.
2. Prefer intrinsically flexible layouts (`flex-wrap`, `auto-fit` grids) over fixed column counts, so a block adapts to any item count and any width instead of breaking at the one size it was tuned for.
3. Cap line length on large screens and centre the content rather than pinning it to one edge.
4. Keep touch targets ≥44px and inputs ≥16px on mobile (prevents iOS auto-zoom).

The good news: your app already does items 1, 4, and the "rows to blocks" table pattern very well (auto-tagged `data-label`s, stacked cards below 640px, safe-area insets, keyboard-aware modals). The remaining problems were all about **fixed layouts that only looked right at one specific size** — which is exactly where "things fall out of line" comes from.

---

## 2. What was actually causing the shifting / crowding

| # | Problem | Where it showed | Why |
|---|---------|-----------------|-----|
| 1 | Form rows with 3–6 fields looked cramped and misaligned on desktop | Attendance (6 M/F count fields), fundraising entry modal, committees, users, settings | `.field-row` was a hard **2-column grid**. Any row with more than 2 fields wrapped into lopsided 2-per-line stacks, and fields with small `max-width`s left big empty gaps in their cells. |
| 2 | A lone stat card dropped to a half-width "orphan" out of line | Fundraising (5 stat cards) | `.stat-grid` was hard-coded to **4 columns**, so a 5th card sat alone on a second row. |
| 3 | Wasted empty gutter / content pinned left on wide monitors | Every page on large screens | `.main` had `max-width:1200px` but no centring, so it hugged the left with dead space on the right. |
| 4 | Risk of the whole page shifting sideways from a wide table | Users (8 columns), audit log (IP + Device), committees | Wide-table horizontal scrolling was only contained on screens ≤820px. On desktop/tablet a too-wide table could push the page itself wider. |

---

## 3. What I changed (all in `style.css`)

1. **`.field-row` → flexible wrapping row.** Changed from `grid-template-columns: 1fr 1fr` to `display:flex; flex-wrap:wrap` with each field `flex: 1 1 200px; min-width:0`. A normal two-field row still splits into equal halves; rows with more fields now flow and wrap cleanly; inline `max-width`s still cap individual fields. On phones (≤820px) fields go full-width, one per line.

2. **`.stat-grid` → auto-fitting grid.** Changed to `repeat(auto-fit, minmax(190px, 1fr))`. Any number of cards (4, 5, 6…) now distributes evenly with no orphan, at every width — which also let me delete two now-redundant breakpoint overrides.

3. **`.main` centred with a shrink guard.** Added `margin-inline:auto` (centres the capped column on wide screens) and `min-width:0` (lets a wide table inside scroll instead of forcing the page wider).

4. **Wide-table safety net at all widths.** Added `.main .card:has(> table) { overflow-x:auto }` so a too-wide table scrolls *inside its own card* on desktop and tablet, never dragging the page sideways. Scoped with `:has(> table)` so it never clips cards that hold pop-over menus, and the existing ≤640px stacked-card rule still overrides it back to visible.

No behaviour that was already working (mobile table stacking, keyboard-safe modals, safe-area padding, dark theme) was altered.

---

## 4. Verification

- **CSS integrity:** braces balanced (410/410); no page JS or HTML depends on the old grid definitions, so nothing else breaks.
- **Breakpoint reasoning (checked at 360 / 390 / 768 / 1024 / 1440px):**
  - *stat-grid:* 1 column ≤~400px → 2–3 on tablet → up to 5 across on desktop, always even, no orphan.
  - *field-row:* full-width stack on phones → clean wrapping multi-field rows on tablet/desktop.
  - *wide tables:* stacked cards ≤820px; contained sideways scroll inside the card above 820px; page never overflows horizontally.
- **Hands-on preview:** `layout-preview.html` (in the app folder) is a self-contained page with the real stylesheet inlined and the three worst-case blocks (5 stat cards, the 6-field attendance row, the 8-column users table). Open it and resize the window, or open it on your phone, to see the behaviour directly. *(I couldn't capture screenshots automatically here — the sandbox blocks the headless-browser download — so this preview is how you confirm it visually.)*

---

## 5. Optional next steps — now applied (20 July 2026)

All three were implemented. A backup of the two edited files was taken first, at
`backups/layout-optional-<timestamp>/` (`style.css` + `app.js`).

1. **Breakpoint alignment (CSS).** The table-stacking media queries moved from
   640px to **820px** so tables collapse into labelled cards at exactly the same
   width the sidebar becomes the bottom tab bar. This closes the 641–819px
   "tablet gap" that used to show the mobile chrome alongside desktop-style
   side-scrolling tables.

2. **Scroll-edge hint (CSS).** Above 820px, a table card that overflows now
   shows the canonical "scrolling shadows" (Lea Verou / Roma Komarov) — a soft
   shadow appears only on a side that actually has more table off-screen, so
   users can tell they can scroll. It uses `background-image` so the card's own
   colour is untouched, and it's scoped to >820px (below that, tables stack, so
   there's nothing to scroll).

3. **Column-toggle (JS + CSS).** Wide tables (6+ columns: Users, committees,
   the audit log, the IOU register, etc.) get a small **"Columns"** button that
   opens a menu to hide non-essential columns. It's deliberately conservative:
   nothing is hidden until the user chooses to, the action column and the first
   (identifier) column can't be hidden, the menu reuses the app's existing
   body-level dropdown (so the card's overflow can't clip it), and the control
   is hidden on phones/small tablets where tables already stack. The logic is
   wrapped in try/catch so a UI hiccup can never break a page.

### Verification of these three
- `node --check public/js/app.js` passes; `style.css` braces balanced (417/417);
  no stray 640/460px queries remain.
- **Not browser-tested here:** the sandbox can't download a headless browser, so
  the column-toggle interaction was verified by code review and by a stand-in in
  `layout-preview.html`, not in the running app. Please click the **Columns**
  button on the Users page after deploying to confirm it behaves as expected.
  The two CSS changes carry no interaction risk.

### To roll back if needed
Restore from the backup folder:
```
cp backups/layout-optional-<timestamp>/style.css public/css/style.css
cp backups/layout-optional-<timestamp>/app.js    public/js/app.js
```

---

## 6. Diagnosis of the reported mobile screenshots (20 July 2026)

Three phone screenshots were reviewed (from the **currently deployed** build, which
is behind this working copy):

1. **Roster modal — action buttons broken one letter per line** ("E d i t c o n
   t a c t"). Root cause: table cells set `word-break`/`overflow-wrap` (so long
   emails wrap), and those properties are **inherited**, so a button squeezed in a
   narrow, not-yet-stacked column shattered mid-word. **Fixed globally** — `.btn`
   (and `.badge`/`.chip`/`.tab`) now pin `white-space:nowrap; word-break:normal;
   overflow-wrap:normal`, so a label can never break mid-word on any page. The
   working copy also already stacks modal tables into cards on phones, which
   removes the squeeze entirely.
2. **Attendance list** — this is the stacked-card view working as intended; fine
   after deploy.
3. **Quarterly Entry — large empty area below content, top label under the status
   bar.** The clipped top is scroll position beneath the phone status bar
   (cosmetic). The dead space is short content above the page background — to be
   confirmed live after deploy rather than guessed at here.

## 7. Whole-app inline-style audit (20 July 2026)

Scanned every HTML page and page script for per-page layout offenders:

- **Hard `width:NNNpx`** — only on modals (login reset/recover), all capped by
  `.modal { max-width: 90vw }` (94vw on phones), so no overflow; and a couple of
  small 140–180px avatars/QRs. No action needed.
- **`min-width` (200–240px)** — on filter selects that go full-width once the page
  header stacks at ≤820px. Safe.
- **Inline `white-space:nowrap`** — only on dates, badges and the truncated
  device/user-agent column (which uses `overflow:hidden; text-overflow:ellipsis`,
  so it never overflows). Action columns are overridden to wrap by an author
  `!important` rule when stacked. Safe.
- **No** inline absolute/fixed positioning, oversized padding, or wide fixed-px
  grids were found in page content.

Conclusion: the pages are clean; the shared root-cause fixes in `style.css` /
`app.js` cover the whole app, so the fix is comprehensive rather than per-screen.

## Deploy & re-check
These screenshots are from the deployed build, which lags this working copy. Deploy
(your usual rsync + `systemctl restart aotc-track`), then re-check the three screens
on a phone. Anything still off — especially screenshot 3's empty space — send a
fresh screenshot and it can be finished quickly.
