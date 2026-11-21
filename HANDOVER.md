# AOTC Track — handover

Everything a new session needs to pick this up without re-deriving it.

**App:** quarterly planning, reporting and records for PCG Adabraka Official Town
Congregation. Node/Express, JSON-file datastore, vanilla-JS frontend, no build step.
**Code:** `OneDrive Personal / Projects / Software / AOTC Reports Software / aotc-track`
on the user's MacBook. **Live:** `track.pcg-aotc.com` — VPS `172.93.52.195`,
service `aotc-track`, app root `/opt/aotc-track`.
**Scale:** ~170 JS files, 23 route modules, 42 utils, 35 pages, 37 data collections,
13 committees + 12 groups.

> **What this document is built from:** the repository itself, the project docs,
> the stored memory file, and the sessions of 20 Sept – 8 Oct 2026. It does **not**
> recall sessions whose decisions were never written down. Where a project doc covers
> something in depth, this points at it rather than paraphrasing it.

### Keeping this file current — the rule

Update this file (and the project copy, `claude/handover.md`) **at the end of every
piece of work that changes what the app does, before handing the user the deploy
command** — not at the end of the session, which may never come. Each update:

1. adds the work to **§6** (one short entry; detail goes in a project doc, linked);
2. moves it in **§9** between *built, not deployed* and *deployed* — the move to
   *deployed* only once the live site has been checked from the browser pane;
3. adds anything that bit to **§8**.

Small fixes with no behaviour change (a typo, a comment) do not need an entry.
Last updated: **21 Nov 2026** (0.4.32: inflow list fits the page — built, not deployed; 0.4.31 deployed, green live). Before that, **19 Nov 2026, evening** (0.4.31: the day is set up first; 0.4.30 deployed). Before that, 18 Nov 2026 (0.4.29: harvest basket sheets — deployed, blue live; fresh git history pushed to GitHub smartdeontech-eng/aotc-track). Before that, 3 Nov 2026, 09:45 UTC (0.4.0: update bar, About with What's new, numbered releases — built, not deployed; before that: Pulse sign-ins reporter, tray deployed; blue live; SQLite + blue-green working). Commits from 10–24 Oct by other sessions are not summarised here; see `git log`.

---

## 1. Running and deploying

```bash
npm start                  # node server.js
npm run seed               # utils/seed.js
AOTC_DATA_DIR=/tmp/x npm start   # run against a throwaway data copy
```

**Source and GitHub (18 Nov 2026).** The source is this folder, a git repository
(branch `main`), with its online copy at **github.com/smartdeontech-eng/aotc-track**
(private). `.gitignore` keeps every live record out (data/, backups/, uploads,
minutes, marriage-files, document-files, .env) — check it before adding any folder
that holds people's records. **Every release, in this order:**

```bash
cd ~/Library/CloudStorage/OneDrive-Personal/Projects/Software/"AOTC Reports Software"/aotc-track
node scripts/check-version.js                        # package.json and changes.json agree
git add -A && git commit -m "0.4.x: what changed"
git push                                             # GitHub holds what is released
deploy/push.sh                                       # then release
```

Run it from THIS folder: each app has its own `deploy/push.sh`, and the one in the
current folder is the one that runs (17 Nov 2026: run from the RondoQ folder, it
released RondoQ).

**Deploy is one script, run by the user from their own Terminal:**

```
~/Library/CloudStorage/OneDrive-Personal/Projects/Software/"AOTC Reports Software"/aotc-track/deploy/push.sh
```

Pre-flight clash check → rollback snapshot on the server → rsync to
`~/aotc-staging` → promote into `/opt/aotc-track` → `systemctl restart aotc-track`
→ curl-based verification markers.

**You cannot deploy yourself.** SSH to the VPS is unreachable from both the
Mac-side shell and the cloud sandbox (`Network is unreachable`), and HTTPS to
`track.pcg-aotc.com` is blocked from both. Hand the user the command; never claim
to have deployed.

**How `push.sh` reaches the server (Oct 2026):** through the SSH alias
`deontech-vps` in the Mac's `~/.ssh/config` (set up once with
`printf '\nHost deontech-vps\n    HostName 172.93.52.195\n    User deploy\n' >> ~/.ssh/config`;
the script prints this line if the alias is missing). **On a phone hotspot** the
network is IPv6-only and a bare IPv4 address is unreachable — deploy with
`AOTC_HOST=deploy@track.pcg-aotc.com push.sh`. A Wi-Fi network that times out on
port 22 is blocking SSH; use another network. The verify step waits up to 30 s for
the service and uses `ssh -t` so sudo can prompt. Full notes: `server-access-issues.md`
(sent to the user 8 Oct).

**Seeing the live site:** the Claude desktop app's **browser pane** reaches
`track.pcg-aotc.com`. The user signs in there (never type passwords); then read live
data with `fetch('/api/…')` in the page. **Writes from the pane are blocked** by the
session's safety check — for a live data fix, give the user a one-line console
command (a `.then()` chain: Safari's console rejects top-level `await`), then
re-read to confirm. After every deploy, confirm from the pane, not only from the
markers.

**Never touched by a deploy:** `data/`, `.env`, `minutes/`, `generated/`,
`backups/`, `public/uploads`, `marriage-files`, `document-files`. These are live
records. `document-files` was added to the excludes on 1 Oct — it had been missing,
which would have destroyed ShareHub uploads on the first deploy after anyone used it.

**Verification markers** are the tail of `push.sh`: a `401` on an API line means the
route is mounted and wants a login; a count above zero means the client code landed.
One marker inverts — `mobile scroll fix` must print **0**, because it checks a bad
CSS rule is *gone*.

**Rollback** is the server-side tarball the script writes to `/opt/aotc-track-*.tar.gz`
before promoting. Git history is the other fallback (commits since Oct 2026, pushed to
GitHub from 18 Nov 2026).

---

## 2. Architecture, and the rules that are not obvious

- **Datastore** — `utils/db.js`. **SQLite since Oct 2026** (`data/aotc.db`, `DB_PATH` overrides),
  through `utils/sqliteDatastore.js` copied from `@deontech/db` 0.4.1 (IFAIMA's). Same contract as the
  old JSON store — `insert/findAll/findOne/findById/update/remove/mutate/readAll/writeAll`, same ids,
  insertion order, stamps — so no route changed. One `records` row per record, JSON document; WAL,
  every write in `BEGIN IMMEDIATE`, safe across processes. Opens on **first use**, not on require.
  A collection with no rows reads `data/<c>.json` in (once) and moves it to `data/json-before-sqlite/`.
  **Outside production it refuses to open the project's own data/** unless `AOTC_LOCAL_DB=1`; tests use
  `AOTC_DATA_DIR`. Way back: `scripts/sqlite-export.js`. Detail: `claude/sqlite-store.md`.
- **`utils/settings.js` does NOT honour `AOTC_DATA_DIR`** — it writes to a hardcoded
  `data/settings.json`. Anything stored through it cannot be exercised in a test
  without touching live settings. Put new config in the ordinary db store instead.
  (Worth fixing; left alone so far.)
- **Frontend** — plain `<script src>` tags, no bundler. `app.js` loads first and
  defines the shell, `api()`, `esc()`, `toast()`, `confirmDialog()`, `isElevated()`,
  `requireAuthAndRenderShell()`, `money()`, the date helpers and `NAV_ITEMS`.
- **Classic scripts share one global scope.** A `const` in a page script that collides
  with anything `app.js` declares is a `SyntaxError` at parse time and the **entire
  page script never runs** — silently, with no handler and no error card. See §8.
- **`api()` throws** an `Error` carrying `.status` and `.data`. Every page load path
  must catch and *show* the failure; a blank page is indistinguishable from a broken
  feature.
- **Derived figures are materialised, not computed at read time.** Attendance fills
  KPI entries; the weekly finance ledger writes into `finance_quarterly`. The rule:
  compute once, write it where every existing reader already looks, so the entry page,
  the report and the District workbook cannot disagree about the same number.

---

## 3. Domain model

**Entities.** A committee, a group, or `congregation` (code `OG`). Every account is
scoped to one, or is congregation-wide. `utils/scope.js` holds `userEntity`,
`canViewAll`, `isAdmin`, `isClerkOrAdmin`, `deriveOwnerType`.

**Goals and KPIs.** One goal row **per owner**, several owners sharing a `code` — that
is how a shared goal is modelled. `utils/goalRollup.js` derives the family at read
time (zero writes): the parent is the single committee/congregation-owned copy, the
participants are the group copies. `reportedValue()` is the one place all three
documents must go through. Only countable units sum — never `%` or `Date`.

**Quarter lifecycle.** Three states, not four: **not submitted** → **submitted**
(submitting *is* what locks it; there is no separate final-draft step) → **reopened**
(a timed window that re-locks itself). Nothing records a report being *received*.

**Reopening** has exactly two paths and they must stay distinct:
- `POST /entry/reopen-quarter` and change-request approval both call
  `openChangeWindow()` — a timed window, 48 hours or until the quarter's deadline.
- `POST /entry/unlock` is the admin's blunt instrument: strips the lock with no expiry
  (`status: 'unlocked'`). Anything reading submission state must treat this as *open*.

**Group ordering** is generational, never alphabetical: `utils/groupOrder.js`,
`CS, JY, YPG, YAF, MF, WF`, then everything else alphabetically. Matched on **code**,
so renaming a group never silently drops it to the bottom.

**Dates.** A calendar day and an instant are different things and the distinction has
already caused a data fault. Read `claude/dates-and-timezones.md` before touching any
date. `TZ=Africa/Accra` is pinned in the systemd unit.

---

## 4. Access

Role → default permissions → stored permissions array. **Checks read the array, not
the role**, except `admin`/`localadmin` which short-circuit everything. Changing a
role's defaults does *not* update existing accounts.

Full detail in `claude/roles-and-access.md`. The traps:

- A permission can be **declared in `middleware/auth.js` but missing from the group
  list in `public/js/page-users.js`** — in which case nobody can ever be granted it.
  This had happened to `docs.upload` (ShareHub never worked for non-admins) and
  `correspondence.intake`. Both fixed; all 26 are now reachable. **Check this whenever
  you add a permission.**
- **Client gates must match server gates exactly.** Narrower client = a feature that
  silently vanishes for one person; wider = a dead button.

---

## 5. Module map

**Routes** — analytics, attendance, auth, backups, checkin, counselling, documents,
entry, financeWeekly, fundraising, inbox, marriage, meetings, messages, minutes,
planning, push, reminders, reports, settings, setup, visitors.

All 22 are mounted in `server.js`. `documents` was **not** mounted for the whole life
of the project until 1 Oct 2026 — ShareHub had never worked. If a feature looks
complete but dead, check the mount first.

**Notable utils** — `goalRollup` (shared goals), `groupOrder`, `financeWeekly` (the
weekly money ledger), `attendanceStats`, `districtExcel` (the District return),
`reportData`/`reportPdf`/`reportDocx`, `congregationData`, `reminders` (ten job
families, deduplicated through `reminder_log`), `dates`, `scope`, `aiAssist`.

**Pages** — 34 HTML files; `NAV_ITEMS` in `app.js` decides the sidebar, and
`items.slice(0, 4)` decides the phone tab bar.

---

## 6. Modules worth knowing in detail

| Module | Project doc |
| --- | --- |
| Shared goals (committee goal extended to groups) | `claude/shared-goals.md` |
| Meeting types (general vs executive) | `claude/meeting-types.md` |
| Group ordering | `claude/group-ordering.md` |
| Attendance & meetings overviews | `claude/attendance-meetings-overview.md` |
| Naming & categorisation audit | `claude/naming-and-categorisation.md` |
| Dates and timezones | `claude/dates-and-timezones.md` |
| Fundraising | `claude/fundraising-module.md` |
| Roles and access | `claude/roles-and-access.md` |
| Committee minutes | `claude/committee-minutes.md` |
| Correspondence inbox | `claude/correspondence-inbox.md` |
| Office terms & handover | `claude/office-terms-and-handover.md`, `claude/handover-roll-fix.md` |
| Shared core extraction | `claude/shared-core-plan.md`, `-step1.md`, `-runbook.md` |
| Reopening anything that locks | `claude/unlock-requests.md` |
| Permissions split, sensitive rights, account on/off | `claude/roles-and-access.md` |
| Session minutes: tidy-up, decisions, matters, chairman signs | `claude/session-minutes-oct-2026.md` |
| Proofreading loop and the lessons so far | `claude/proofreading-lessons.md` |
| In-app document viewer (PDF close/download/share, PNG) | `claude/document-viewer.md` |

### Built 21 Nov 2026 — 0.4.32: the inflow entries list fits the page (no sideways scrolling)

Gideon: "I don't like that I have to scroll." The inflow list sat beside the expenses card and each row
carried up to nine buttons (Results, PDF, Open, Edit totals, Submit, Verify, Approve, Decline, ✕1st, ✕2nd).
Now: the inflows card is full width with expenses below; Event and Date are one column; each row shows
**Open**, the **one next step** in the chain (Submit → Verify → Approve, whichever this user can do now)
and **More ▾** (app.js `showActionsMenu`, as on the other list pages) holding Results, Announcement PDF,
Edit totals, any other approval step, Decline, Unlock / Ask to reopen and "Delete 1st/2nd service entry".
Code: `dayActionsHtml()` in page-fundraising.js (menu items kept in `_dayMenus`, one delegated click
handler for `[data-day-menu]` / `[data-day-next]`); CSS `.fr-inflows` / `.fr-act-row` at the end of
style.css — on phones the three buttons share one row (the selector has to beat
`table.responsive td.rt-actions .btn`'s 50% min-width). Draft badge shortened to "draft" (tooltip says
not yet submitted). Checked in Chrome at 1280 and 390 px: no horizontal overflow, menu opens.

Same release — **bank dropdown**. Gideon: "we know all the banks in Ghana… a drop down". `GH_BANKS` +
`bankPickHtml(attrs, value, style)` near the top of page-fundraising.js (used by the totals form's cheque /
transfer rows, the per-basket breakdown rows, and page-fundraising-sheets.js `rowHtml` for the sheet
entry). The select (`data-bank-pick`) writes into the existing text input beside it, so save code,
routes and PDFs are unchanged; the input only shows for "Other (type it)…" (rural/community banks,
savings & loans). An old value not on the list opens as Other with its text. List = the 23 universal banks
on the BoG register, Nov 2026 (Société Générale Ghana kept: its sale to Attijariwafa awaited approval in
Oct 2026 — rename it here when the bank rebrands).

Same release — **sheet entry mirrors the paper**. Gideon: "the sheet entering should be same as the sheet
itself in terms of format"; he chose to reletter so letters follow the page. Paper (`basketSheetPage` in
utils/fundraisingPdf.js): This-basket box and section titles now **A Cash, B Cheques, C MoMo, D Transfers,
E Foreign, F Pledges** (cheques table is full width just under the cash, so it is B); the day summary's
columns follow the same order. Screen (`#sEntry .hs-paper` in fundraising.html): navy band with
`sBandBasket/Event/Date/Svc` and the sheet-no. box; `.hs-top` = cash table (A cash total written at the
bottom, counted under it) + `.hs-basket` (sPartA–F, sTyped, BASKET TOTAL `sWrittenTotal`, sCheck); then
cheques full width, `.hs-two` MoMo|Transfers, Foreign|Pledges. `LISTS` in page-fundraising-sheets.js holds
each list's columns in paper order with fr widths (rows are CSS grids, `headHtml` draws the column
headings); cheques gained `drawer` (stored by `normCheques` only when typed); forex rows show a worked-out
GHS cell. Enter: reading order with the basket total forced last; Enter on an empty line jumps to the next
list; Enter on the last box of the last line adds a line. Phone: one column in the same order, two boxes
per line. Old `.hs-cols/.hs-totals/.hs-sum` CSS is now unused.

### Built 19 Nov 2026 — 0.4.31: the fundraising day is set up first (as Sunday attendance)

Owner, 19 Nov 2026 evening: "set up the day for the main harvest or whatever item, then everything follows."
- New collection **`fundraising_days`** `{eventId, eventName, year, date, shape: joint|dual, target, status, setBy,
  setAt, via?}`. `POST /api/fundraising/days` sets it up or changes it (shape change refused once figures of
  the other shape exist; empty photo-only entries of the other shape are removed; push to fundraising.manage
  users); `DELETE /api/fundraising/days` removes a day with nothing on it.
- `dayServices()` and `dayShapeError()` follow the record first. Sheets cannot be printed, entered or
  photographed until the day is set up (`daySetUp()`: a record, or figures from before this release).
  Totals typed in the totals form or "Save this basket" for a day nobody set up set it up (`ensureDay`,
  `via: 'totals form'`).
- `GET /sheets` returns `day` and `setUp`; `/overview` returns `days`, and the inflows list shows a set-up
  day with nothing entered ("set up — nothing entered yet", Open).
- Day window: until set up, only the "Set up the day" panel (joint / 1st and 2nd, optional day target);
  then the day line (who set it up, the day's target and % so far, change, remove this day) and the three
  steps. Changing Services on a set-up day asks first. Tally shows the day target and the event target.
- Tests: test-fundraising-sheets 62/62 (set-up gating, shape change, remove, totals form sets up);
  breakdown 99 (one message check widened: the refusal now names the set-up day), roles 31, pdf-layout 49,
  entry-dom 69. Browser check (Chrome 1280): set-up panel, set up, print step, tally.

### Built 19 Nov 2026 — 0.4.30: Record fundraising day and the harvest sheets are one window

Owner, 19 Nov 2026: the day and its sheets are one thing — set up the day with its target, print the
sheets, enter them, tally, report.
- **One button**, "+ Record fundraising day" (#entryBtn), opens the day window (`#sOverlay`,
  `page-fundraising-sheets.js`): event (with "＋ New event…", POST /events) and its target ("change
  target", PUT /events/:id), date, services; then three steps: **1 Print sheets** (+ "Type totals without
  sheets" → `openTotalsForm()`, the old form, now titled "Type the day's totals (without sheets)"),
  **2 Enter sheets** (board + entry, as 0.4.29), **3 Tally & report** (day total, sheets entered, event
  raised vs target, one line per basket with a column per service, by payment type; Results, Announcement,
  Day summary & cash handover, Submit). The window opens on the step the day is at.
- Inflow rows: "Sheets" → **Open**; "Edit" → **Edit totals**. The header's separate Print / Enter buttons
  are gone.
- **Gratitude & Thanksgiving is sheet 01** (then Sun–Sat-borns, Chairpersons, Seed, activities).
- Sheets are now matched to records by **basket** (`recordFor(entry, plan)`), not by the number stored with
  them, so renumbering loses nothing; a basket typed in the totals form shows on the board as entered
  (`source: 'form'`) and a sheet does not overwrite it without "replace" (409 names the totals form).
- `GET /sheets` also returns `event.target`, `event.raised` and `methods` (cash, momo, cheque, transfer,
  forex, ious) for the tally.
- Tests: test-fundraising-sheets 50/50 (new numbering, tally, form-typed basket); breakdown 99, roles 31,
  pdf-layout 49, entry-dom 69. Browser check (Chrome 1280): the three steps.

### Built 17 Nov 2026 — 0.4.29: harvest basket sheets (paper first, typed at the desk)

Why: at the last harvest figures "did not save" (the whole-day Save refuses the lot unless the whole day
balances, and on a dual day can save 1st and not 2nd), money got lumped together, and compiling was slow.
The Harvest Committee chose paper first, typed straight after (owner, 17 Nov 2026).
- **Printed set** `GET /api/fundraising/basket-sheets.pdf?eventId&date&services=joint|dual`
  (`buildBasketSheetsPdf`): one A4 per basket per service — Sun–Sat-borns, Gratitude & Thanksgiving,
  Chairpersons, ONE Seed sheet (counter circles the body), one per configured activity — pre-printed
  with event, date, service, basket and **sheet number**; denominations (pieces, amount optional),
  lists for MoMo / cheques / transfers / foreign / pledges, basket total, second count, two signatures;
  crest at the top and faint behind; the PCG – AOTC disclaimer. Then a "sheets returned" tick list per
  service. Numbers run through the DAY (dual: 1st = 01–10, 2nd = 11–20) — `sheetPlan()`.
- **Entry desk** `public/js/page-fundraising-sheets.js` (Fundraising → ⌨ Enter harvest sheets, or
  "Sheets" on an inflow row): board of every sheet (missing / photo to type / entered), sheet no. →
  basket fills in; pieces, lists, the cash total and BASKET TOTAL written on the sheet; Enter moves
  down, Ctrl/⌘+Enter saves; typing kept in localStorage until saved.
- **API** `GET /sheets`, `GET /sheets/:no`, `PUT /sheets/:no` (same buildEntry/persistEntry path as
  "Save this basket"; refuses a sheet whose typed figures disagree with its written cash/basket total
  unless marked "sheet's own adding-up is wrong" + note; 409 if already entered unless `replace`;
  a seed sheet needs `seedBody`; a typed forex rate becomes the day's rate, a clash is refused),
  `POST /sheets/:no/photo` (resized in the browser; stored in `<data>/fundraising-sheets/`, never
  public/; `GET /sheet-photo/:id` for viewers). Sheet meta lives on the entry as
  `entry.sheets[basketKey] = {no, enteredBy, at, writtenCash, writtenTotal, corrected, note, momo[], photoId}`.
- **Day summary & cash handover** `GET /day-summary.pdf` (`buildDaySummaryPdf`): one line per sheet
  (NOT ENTERED in red), then cash by note/coin across all sheets with a "pieces bagged" column, and every
  cheque (must agree with the deposit slip), with signatures.
- **Whole-day form can no longer overwrite** another desk's work: it sends `baseUpdatedAt` per service
  (`entryBase`, set when the form opens); `PUT /entries` answers 409 if the entry changed since.
- `server.js`: `/api/fundraising/sheets` takes JSON up to 4 MB (photos), before the 1 MB parser.
- Tests: `scripts/test-fundraising-sheets.js` 45/45; breakdown 99, roles 31, pdf-layout 49,
  entry-dom 69 still pass. Browser check (Chrome, 1280 and 390): keyboard entry, mismatch message,
  save, board; the cash table has no `<thead>` on purpose (app.js would turn it into cards on phones).

### Built 7 Nov 2026 — 0.4.28: About shows the last three releases

- `page-about.js`: the three newest `changes.json` entries in full (the running one marked "the version
  you are using"); all older ones inside a single `<details id="olderReleases">`, each still its own fold.

### Built 7 Nov 2026 — 0.4.27: programme offerings in Weekly Finance

- `utils/financeWeekly.js`: `rec.programmes = [{name, days:[{date, amount}]}]` (≤8, days only inside the
  Mon–Sun week, `cleanProgrammes`). Added to receipts total, to the quarter's Offertory feed
  (`byLine.programmes`), a "Programme offerings" totals row, and one announcement line per programme
  (`programmeLabel`: "<name> offering (<days>)", `daysLabel`).
- `routes/financeWeekly.js`: PUT saves `programmes`. Confirmed weeks still lock (409).
- `page-finance-weekly.js`: "Programmes during the week" block under receipts; name datalist from the
  Church Diary programmes that week (picking one ticks its days).
- Tests: `scripts/test-weekly-programmes.js` 12/12; browser check 6/6 at 1280 and 390.

### Built 7 Nov 2026 — 0.4.26: About folds earlier releases; Refresh page button

- `page-about.js`: the running release in full ("What's new in 0.4.x — the version you are using"),
  every other release a `<details>` with its number and first phrase.
- `app.js`: **Refresh page** (`#refreshPageBtn`, `location.reload()`) under the theme button in the
  sidebar, and in the phone's More sheet. The installed app (Mac Dock / home screen) has no browser
  bar, and `overscroll-behavior-y: contain` on html/body (the 30 Aug fundraising data-loss fix) turns
  off pull-to-refresh on purpose — a custom pull gesture was not added for the same reason.
- Browser check (ad hoc): About 5/5 at 1280 and 390.

### Built 7 Nov 2026 — 0.4.25: the Church Diary

Full detail: project doc `claude/church-diary.md`. In short: `routes/diary.js` (`/api/diary`),
`public/diary.html` + `public/js/page-diary.js`, nav "Church Diary" (Meetings & Attendance, every
signed-in user; Minister's fixed menu too). Auto items read live (Session meetings, meetings not
cancelled, marriages `approved`/`married` — traditional, church wedding, thanksgiving); entries in
`diary_entries` (programme, funeral, preaching, wedding, traditional, thanksgiving, other; multi-day
via `endDate`); suggestions derived on read from letters with a future `eventDate` and from minutes
visitors (funeral/marriage events), declined/accepted keys in `diary_decisions`, and a suggestion is
hidden when the same kind is already on the diary that day. Keepers: admin tier, `approvals.manage`,
`correspondence.intake`, or the new `diary.manage` (in `PERM_GROUPS`). Preaching plan: POST
`/preaching/read` (Word → table rows "a | b | c" via jszip; PDF as a document block; Claude returns
rows), review table, POST `/preaching` (same date+service updates, never doubles). Home's Coming up
adds diary items (not meetings/Session, already there); `fmtTime` now passes "1:00 pm" through.
`callClaudeFull` exported from `aiAssist.js`. Annual-plan activities are NOT on it: they carry a
quarter, not a date. Tests: `scripts/test-diary.js` 33/33; browser `scripts/diary-ui/` 16/16 at
1280 and 390, light and dark.

### Built 5 Nov 2026 — 0.4.24: constituted on the word shared; re-entrant redraw fixed

- **Tick** `proceedings.constitutedOnWord` (boolean, PUT /proceedings branch like `graceSaid`) and
  optional `constitutedWordRef` (a scripture). `constitutionSentence()` in `utils/sessionMinutes.js`:
  "X, drawing on the words shared during the devotion, duly constituted the Session at …" or "X,
  drawing on Hebrews 4:16, duly constituted …". From the minutes: "standing on the words from the
  devotion" (Nov, Dec 2025; Feb, Mar 2026), "drawing from/on the words … devotion" (Apr, Jun 2026) —
  the latest wording was used. `#constPreview` mirrors it on the page; the scripture box shows only
  when ticked. Committee minutes (`routes/meetings.js`, `minutesDocx.js`) unchanged.
- **Bug in 0.4.22's layout:** moving a focused pick field during `renderSections()` fires its
  change/blur handler, which called `renderSections()` again mid-move → "node to be removed is no
  longer a child". Now guarded: a nested call is deferred and run once after (`sectionsRendering`).
- Tests: `scripts/test-constitution-word.js` 5/5; `visitors-ui/ui-layout.js` 10–11/11 light/dark,
  1280/390; `ui.js` 9/9, `ui-sem.js` 8/8.

### Built 5 Nov 2026 — 0.4.23: thanksgiving service for an intended marriage

- Third, optional occasion `what: 'thanksgiving service'` in the marriage visitor (`MARRIAGE_KINDS`
  `thanks`), and `dates.thanksgivingDate/Time/Venue` on the marriage case (PUT /cases/:id/dates,
  cases list, Intended Marriages page). Three occasions read "A would be held on …, B on …, and C on
  …." "Where" relabelled **Venue**. Tests: `test-visitors-marriage.js` 25/25; `visitors-ui/ui.js`
  9/9 at 1280 and 390.

### Built 5 Nov 2026 — 0.4.22: Minutes tab, one block per section; night-mode fixes

- **Layout** (the user's choice, from two offered): the "What was captured on the night" card is
  gone. Its fields are wrapped in pick groups inside a hidden `#mParking` (`grpOpening`,
  `grpConstitution`, `grpVisitors`, `grpReview`, `grpCarry`, `grpPrayers`, `grpClosure`), and
  `renderSections()` **moves** each into a `.sec-pick[data-slot]` at the top of its section
  (`SEC_PICKS`; `parkPicks()` before the innerHTML rebuild, `placePicks()` after). Moving, not copying,
  keeps listeners and values; the focused field and caret are restored after a re-render, so Tab
  from a pick field still moves on. A disabled section leaves its group parked.
- **Section bar** `#secJump` (sticky, scrolls sideways on a phone; `renderJump()`, `SEC_SHORT`) jumps to
  each block. Block headers are a tinted band; "PICK" / "TYPE" captions; `.hint` small and muted.
- Presentation no longer repeats the visitors' printed text under the visitors' cards
  (`visitorsLead()` returns '' when there are visitors).
- **Night mode:** `.preview-line` and `.prayer-card` used fixed light colours — now theme variables;
  dark overrides for `.sec-no`, review numbers, AI badge, active tab, proofreading diff colours, warn
  tags.
- Selectors used elsewhere still resolve (`#pCommenced`, `#reviewList`, `.rev[data-rev]`, `[data-mi]`):
  `proofread-ui/ui-source.js` 11/11, `ui.js` 27/27 (its comment-Undo check now waits for the minutes to
  be re-read — it raced). Browser `visitors-ui/ui-layout.js` 6/6 light and dark, 1280 and 390.

### Built 5 Nov 2026 — 0.4.21: seminarians and ministerial probationers as visitors

- New visitor purpose **`seminarian`** ("Seminarian or ministerial probationer"): `studentKind`
  (`seminarian` | `probationer`), `studyYear`, `seminary` (blank = Trinity Theological Seminary),
  `attachFrom`/`attachTo`. Modelled on the minutes: 8 Oct 2026 ("Third-year seminarian from Trinity
  Theological Seminary on attachment", then only under IN ATTENDANCE) and 9 Apr 2026 ("a ministerial
  probationer, who was present as an observer as part of his training", then in the constitution).
- Wording: heading "Seminarian on Attachment — name" / "Ministerial Probationer — name"; "Mr X, a
  third-year seminarian from Trinity Theological Seminary, was introduced to the Session by … He had
  been attached to the Congregation from 1 October 2026 to 31 December 2026." A probationer's reason
  defaults to "He was present as an observer as part of his training."
- Also in the server sanitiser (PURPOSES + fields) and the letter reader's purposes (`aiAssist.js`).
- Not done: a seminarian who sits through the meeting is not added to IN ATTENDANCE automatically
  (visitors never are, by design); the Clerk adds him there if he stays.
- Found while testing: `test-visitors-marriage.js` had sent `{visitors}` instead of
  `{proceedings:{visitors}}` to PUT /proceedings, so its "kept when saved" check passed without
  saving anything. Fixed; 23/23. Browser `scripts/visitors-ui/ui-sem.js` 8/8 at 1280 and 390.

### Built 5 Nov 2026 — 0.4.20: intended marriage — traditional marriage and church wedding

- **What the minutes showed:** none of the 20 Session minutes Oct 2025 – Oct 2026 (the user's
  `2025-2029 Session/Minutes` folder) presents an intended marriage, so there was no house form to
  copy. Modelled on the 22 Oct funeral announcements (heading item, who came, introduced by, the
  arrangements with date/time/place, prayed for, took leave).
- **Visitors, purpose Marriage** (`minutes-visitors.js`): two fixed occasions, **Traditional
  marriage** and **Church wedding**, each date + time (`.ve-time`, put in the minutes' style on blur)
  + where; stored as `events: [{what:'traditional marriage'|'church wedding', date, time, venue}]`.
  `weddingDate` is still written (= the church date) and an older entry with only `weddingDate`
  reads as the church wedding.
- **Wording** (`visitors-text.js`, `marriageSentence`): heading **"Intended Marriage — groom and
  bride"**; why defaults to "to announce their intended marriage"; "The traditional marriage would
  be held on Saturday 14 November 2026 at 10:00 am at …, and the church wedding on Saturday 5
  December 2026 at 1:00 pm at the AOTC Chapel."
- **Marriage case picker never filled anything** — the select's value is a string and case ids are
  numbers (`x.id === e.target.value`). Fixed; it now fills names and both occasions (never over
  something typed).
- **Intended Marriages page:** proposed dates take a time and place for each occasion
  (`dates.customaryTime/Venue`, `marriageTime/Venue`; times normalised with `clock()`); the cases
  list returns them. Clearance still needs only the two dates.
- Tests: `scripts/test-visitors-marriage.js` 16/16; browser `scripts/visitors-ui/` 9/9 at 1280 and
  390. Pre-existing, not from this: `test-minutes-oct2026` ("old form" rawNotes TypeError) and
  `test-permission-pages` ("Other" bucket) fail identically at HEAD; `test-elections` fails only in
  the Mac folder because `server.js` loads `.env`, which puts `SMS_API_KEY` back (passes 89/89 on a
  clean HEAD export).

### Built 5 Nov 2026 — 0.4.9: visitors' letters referenced by item number (supersedes 0.4.8 printing)

- User's decision: a linked letter of THIS meeting prints under Correspondence as usual (with the full
  arrangements in its summary); the visit refers to it — funeral: "Details of the funeral arrangements are
  contained in their letter (see item 7.2 under Correspondence)." and its own arrangements are not
  printed; other purposes: "They also brought a letter (see item …)". No letter → arrangements in the visit.
- Item numbers: `renderRows` builds `letterCtx.letterRef(id)`; this meeting's letters get a marker ⟦L:id⟧,
  correspondence children carry `corrId`, and after numbering the markers become the row numbers.
- A letter from an EARLIER meeting can be linked (form: "Find one from an earlier meeting" → searches
  /correspondence/register). Prints "Their letter was received at the meeting of <date> (item 7.3 of those
  minutes)." and the arrangements print with the visit. `earlierLettersFor(doc)` in routes/minutes.js
  works out that number; passed as `earlierLetters` to every renderRows call that exports.
- visitors-read only fills the register entry of a letter of the meeting being written (body.minutesId);
  the AI summary now writes out every date/time/venue as sentences.

### Built 5 Nov 2026 — 0.4.5–0.4.8: visitors refined, letters

- 0.4.5: Presentation item in the body shows the visitors' printed paragraphs above its (extra-only) box.
- 0.4.6: leader/"Spoke" tick only with 2+ people; prints "spokesperson" for family/couple.
- 0.4.7: one flowing paragraph per group. New group fields `from`, `introducedBy:'__self__'`
  ("introduced themselves/himself/herself" — from the title), funeral `relation` and
  `events[{what,date,time,venue,note}]` → "The one-week observance would be held on <longDate> at
  9.00 a.m. at the AOTC premises." (`clock()` normalises times). Funeral order: who came → "<spokesperson
  or They> announced the passing of their <relation>, <deceased>." → why → details → arrangements.
- 0.4.8: `letterId` on a group links a Correspondence record. Editor: pick a letter of this meeting, or
  📷 upload (POST /:id/correspondence, heading "Letter from visitors") then "Fill in from the letter"
  (POST /correspondence/:cid/visitors-read → `ai.readVisitorLetter`, JSON; fills only empty boxes; gives
  the register entry a heading/summary if it has none). Printing (decided by the user): a linked letter is
  told under Presentation only ("A letter to that effect was received." unless the text already mentions a
  letter) and is filtered out of Correspondence in `renderRows`; its card says so.

### Built 5 Nov 2026 — 0.4.4: Change to visitors (older minutes)

- On minutes with the old `presentationBy`/`presentationTopic`, the "older minutes" row has **Change to
  visitors** (`convertPresentation()` in page-minutes.js): splits the names (, ; and &), adds any
  IN ATTENDANCE guests with position "Presenter" (their details become the role) and removes them from
  the roll, topic → why "to make a presentation on …", Linguist as introducer when present; clears the
  two old fields and opens the new group in the editor. Names split from one line may need tidying.

### Built 5 Nov 2026 — 0.4.3: version easy to find

- The running version (`.app-ver` spans, filled by `showVersion()` in the update snippet at the end of
  `public/js/app.js`) shows under the user's name in the sidebar ("AOTC Track 0.4.3 · About"), as an
  "About AOTC Track" row in the phone's More sheet, and in the page footer. All link to /about.html.

### Built 5 Nov 2026 — 0.4.2: Visitors to the Session

- Visitors are received under the **Presentation** item (title kept; the user will rename it on the
  agenda). `proceedings.visitors` = array of groups, in the order received: `purpose`
  (presentation | funeral | marriage | committee | courtesy | other + `otherLabel`), `people[{name, role}]`,
  `leader`, `introducedBy` + `introducedByLinguist`, `why`, `deceased`/`funeralDetails`,
  `groom`/`bride`/`weddingDate`/`marriageCaseId`, `entityName`, `details`, `response` +
  `responseIsDecision` (prints a "Decision:" line), `withdrew`.
- **One wording file for both sides:** `public/js/visitors-text.js` (UMD) — the page previews with it and
  `utils/sessionMinutes.js` `autoBody('presentation')` prints with it. Change wording there only.
- Editor: `public/js/minutes-visitors.js` (overlay `#visOverlay`, cards with the printed paragraph, move
  up/down). "Introduced by" defaults to the Linguist (`eligibility.linguist`, now also sent by GET
  /minutes/:id) only when the Linguist is marked present; otherwise any present member or a typed name.
  Marriage cases come from /api/marriage/cases, committees/groups from /api/setup/committees + groups
  (either may be unavailable; then the name is typed).
- Visitors are **not** put under IN ATTENDANCE; the old "Add presenters to In attendance" button is gone.
- Older minutes: `presentationBy`/`presentationTopic` still print their one sentence when there are no
  visitor groups; the two fields show (as "older minutes") only on minutes that used them.
- PUT /minutes/:id/proceedings has a `visitors` branch that sanitises each group (20 groups, 40 people).

### Built 5 Nov 2026 — 0.4.1: Minutes recorded by

- **Session minutes → closing details → "Minutes recorded by"** (`proceedings.recordedBy`, picker of
  those present + Other; blank = the Session Clerk). In `docData()` (routes/minutes.js) the left
  signature is the Session Clerk as before, unless the recorder is someone else — then that name signs
  as **Recorder**. Choosing the clerk himself (by name or by roster position) still prints Session Clerk.
  `module.exports._docData` added for checks.

### Built 3 Nov 2026 — 0.4.0: update bar, About, numbered releases

- **Update bar** (end of `public/js/app.js`, the same code as Smart DeonTech 1.1.0): a page notes the
  server's version when it opens (`/api/version`, `no-store`); on return to the app and every 5 minutes
  it asks again, and if the server is newer a bar at the top fetches the page's files fresh ("n of N")
  and offers **Reload**. The service worker still keeps no offline copy (unchanged, on purpose).
- **`/api/version`** now also returns `released`, `started`, `node` and `changes` (from `changes.json`).
- **About page** — running vs server version, released, running since, What's new, Check for updates.
- **Every release has its own number:** bump `package.json` `version` + `released` and add a line at the
  top of `changes.json`. `push.sh` refuses to deploy otherwise (`npm run check-version`).

### Built 9 Oct 2026 — sign-ins reported to DeonTech Pulse

- **Pulse reporter** (`utils/pulse-reporter.js`, copied from `deontech-pulse/connectors/`, added by
  its `scripts/connect-app.js`). The first line of `logLogin()` in `routes/auth.js` sends each entry to
  Pulse. In `server.js`, `activity()` on `/api` (after `cookieParser()`) reports who used the app each
  minute, read from the session cookie. It posts to `http://127.0.0.1:3201`, which is Pulse on the
  same VPS. It does nothing unless `PULSE_APP` and `PULSE_APP_TOKEN` are set, and it never throws. If
  Pulse is down, it logs one line every 10 minutes. It sends name, email, role, IP and user-agent,
  never passwords or records.

### Built 5–8 Oct 2026 (one line each — see the docs above)

- **Church Choir twice** — the Choir secretary archived the group by mistake and re-created it
  as `C-C`. Live data fixed by the user (original restored, copy archived). Board and poster
  now skip archived bodies; **Restore** for archived groups/committees; duplicate names and
  codes (case/punctuation-blind) refused; archive/restore logged as such.
- **Permissions** — `setup.manage` split into `setup.years`, `setup.structure`, `setup.venues`,
  `goals.manage`, `roster.manage`, `members.photos`, `finance.weekly.lines`. Sensitive rights
  admin-only to grant; nobody edits their own. Secretaries propose goal/KPI changes for their
  own body, the Clerk approves. Users page: "+N −M vs role", Reset to role, Who can do what,
  Add what's missing. One-time migration `utils/migrations/permSplit2026.js` (33 accounts).
- **Account on/off switch** beside each name (`utils/accountStatus.js`): signs out at once,
  blocks sign-in, drops from every notification list; a login carries its workspaces.
- **User Accounts page** — search (name, email, phone, position, role, committee/group, with
  highlight) and filters (access level; on/off/differs-from-role/2FA off); one **card per
  person** instead of the 8-column table, so nothing scrolls sideways on a phone.
- **Long minutes** — "read with AI" cap raised, cut-off lists salvaged; tidy-up cap grows with
  the notes, a cut-off tidy-up is refused (notes never replaced by part of themselves),
  **thinks first**, and the original notes are **saved with the item** for good.
- **House style** — `Decision:` lines (italic label, gathered into a searchable **Decisions**
  list), short names after first mention (per-member, learned from the Clerk's corrections),
  bracketed instructions obeyed, more dictation repairs, the 24 Sept proofreading lessons,
  times as **"6:30 pm"** (`SM.minuteTime` normalises old records too).
- **Minutes** — signed by the **chairman** (`constitutedBy`); "The Session Clerk led the review"
  when he did; **Carry to Matters Arising** per item; a continuing matter becomes an **update**
  to the open register entry instead of a twin.
- **Proofreading loop** — upload the proofread .docx: accept/reject each tracked change (written
  into the app), a directive on each comment carried out by Claude, suggested house-style rules
  the Clerk approves (`house_style_rules`, live at once), corrections per 1,000 words.
- **Phone "More" menu** — grouped under the same section headings as the desktop sidebar
  (Plan & Report, The Session, Money…), each foldable (remembered on the phone; the current
  page's section always open), with a "Find a page…" box. Was one flat grid of every page.
- **User Accounts views** — four buttons at the top: Accounts, Who can do what, Backups,
  Login activity (each its own view, remembered; `users.html#logins` links straight in).
  Backups and sign-ins are one line each, no wide tables; sign-ins are searchable
  (email, IP, device) and filterable (successful / failed), with the device and the
  reason in plain words ("iPhone · Safari", "Account switched off").
- **More menu ways out** — ✕ Close button, the grab bar, Escape and the phone's Back
  button all close it, as well as tapping outside. Going to a page from it replaces the
  menu's history step, so Back on the new page returns to where you were.
- **Proofreading review screen** — one list in document order, grouped by item (changes and
  comments together); "X of Y done" bar + **Show only what's left**; **Preview** of a change as it
  will read; accepted text shown clean ("Now in the minutes"); **Undo** on every decision
  (refused, 409, if the paragraph was edited since); the commented words highlighted; "Draft the
  change" for comments; **Go to item** opens the Minutes tab at the item and flashes it.
- **SQLite store** — see §2 and `claude/sqlite-store.md`. Look-first on the server:
  `scripts/sqlite-import.js <data dir>` (reads only). Backups now hold a consistent snapshot
  (`VACUUM INTO`) plus every collection as JSON. `/api/healthz` checks the database.
  `test-sqlite-store.js` 31/31: two processes × 150 inserts keep 300; 2 × 100 `mutate()` reach 200.
- **Blue-green deploys** — `deploy/bluegreen/` (README there), modelled on IFAIMA's. Two code lines
  `/opt/aotc-lines/blue` (3001) and `green` (3002) share the records in `/opt/aotc-track` through
  symlinks; `release.sh` releases to the idle line, health-checks it, switches Apache, then **stops**
  the old line (JSON store: two writers lose records; reminders would double). Rollback =
  `switch.sh <colour>`. `server.js` starts reminders/backups only on the live line (`AOTC_LINE`).
  `push.sh` uses it automatically once `/opt/aotc-lines/live` exists. Rehearsed 29/29, 0 of 352
  requests failed. **Not yet provisioned on the server.**
- **Correspondence export** — **Export** (PDF or Word) on the Correspondence Inbox (the view shown),
  the Session's correspondence register (follows the search), the Correspondence tab of a set of
  minutes (the letters read there), and "Export the ticked ones" in its waiting-for-the-Session box.
  Each letter with from, dated, received, the date it asks for, where it went, action, scanned by,
  summary; optionally the scanned pages (JPG/PNG embedded; PDF pages named only — no PDF-merge
  library, and `push.sh` does not run `npm install`). `utils/correspondenceExport.js`,
  `GET /minutes/correspondence/export`, `openCorrExport()` in `app.js`. See `claude/correspondence-inbox.md`.
- **A changed title carried into the text** — changing a member's title on Session Composition
  (Mrs → Madam) offers to rewrite how she is named in everything **not yet signed**: minutes not
  final, open matters, letters not in signed minutes, and her short form. Signed minutes are left as
  approved. `SM.retitleText`, `POST /minutes/roster/:id/retitle` (`apply` to write).
- **Document viewer** — every PDF opens inside the app with Close/Back, Download, Share and
  Image (PNG); Agenda (image) for WhatsApp. Fixes being stranded in the home-screen app.

### Weekly Finance (built 20 Sept – 1 Oct 2026)

`public/finance-weekly.html` + `routes/financeWeekly.js` + `utils/financeWeekly.js`.

One record per Sunday. **Receipts** (offertory ×4, tithes, communion dues, thanks
offering, building pledge, building project support, Kutunse) and **payments**
(the four earmarked heads, total expenditure, transfer to higher courts).

- Lines are **data, not code** — `finance_weekly_lines`, admin-editable, each carrying
  a `feeds` target naming where it lands in the quarterly panel. Retiring a line keeps
  historic figures.
- **Three states:** draft → entered (Accounts Clerk) → confirmed (Treasurer). Only
  confirmed weeks count. The clerk cannot confirm their own week. Confirming notifies
  the Session Clerk.
- **Announcement text** is built from the lines flagged `announce`, totalling only
  those — it reproduces the congregation's existing wording byte-for-byte. Kutunse is
  recorded but not read out. Payments can never be announced.
- **Reminders** from Tuesday 9am, chasing whoever's turn it is (clerk, then Treasurer),
  escalating to SMS/email on Friday, giving up after a fortnight, chasing the *oldest*
  outstanding Sunday.
- **Quarterly panel** splits Receipts from Earmarked expenditure. Every quarter starts
  **manual**; switching one to the weekly ledger materialises the figures and refuses
  typed writes (409). Q1–Q3 2026 are untouched by design.
- **Giving per member** (CLN's SO-2.1): divided by contributing members — default
  everyone 18+ (Youth + Young Adults + Adults = 964), configurable. Each measure, each
  quarter, is **computed or typed**; the typed value is stored separately so the
  computed one is never destroyed and reverting is one click.

### Submission board + WhatsApp poster (built 1–2 Oct 2026)

`GET /entry/submission-board` + a card at the top of the Reports page. All 25 entities,
**submitted → reopened → not submitted** (that order — the user asked for submitted
first), green/amber/red, with counts and days to deadline. Reopen acts through
`openChangeWindow()`. Visible to `canViewAll`; reopening needs `approvals.manage`.

**The poster** replaces the red/green Excel screenshot the user used to paste into
WhatsApp. `utils/submissionPoster.js` builds a **self-contained SVG** (no server image
library, no CDN, works offline); `GET /entry/submission-board/poster.svg` serves it and
**Download image** on the Reports page rasterises it in the browser — SVG data URL →
`Image` → canvas at 2× → `toBlob` → download. Live data every time, so nothing is
retyped. Bright `#00C853 / #FFB300 / #F5222D`, alphabetical, app names, no crest.

> Red↔green is ΔE 6.6 under deuteranopia — indistinguishable. Every chip therefore
> carries a **second encoding**: its own glyph (tick / bar / dash) *and* the word. Do
> not "simplify" that away.

### Reopening anything that locks (built 3 Oct 2026)

`utils/unlockKinds.js` + `routes/unlocks.js` + `public/unlocks.html`.

Five things in the app lock. Until this, exactly one — the quarter — could be reopened
by asking; the other four said "ask an admin", which is the software telling people to
leave the software. The reason, the asker and the decision all happened on the phone and
were recorded nowhere. **The approval is not the point; the record is.**

- **One request model, not five.** Each kind declares four things — where the record
  lives (`find`), whether it is locked (`isLocked`), who may judge it (`approvers`), and
  how to open it (`open`). `routes/unlocks.js` does the rest once. A sixth lockable
  thing later means one entry in that file and nothing else.
- Each `open` does exactly what that module's existing admin unlock does, so an approved
  request and an admin acting by hand leave **identical** records.
- **Who decides** (the user's routing, confirmed in his own words): money → Treasurer
  (`fundraising.approve`, `finance.weekly.confirm`); the rest → Session Clerk
  (`approvals.manage`); **admin always**. One queue, filtered per person — not one
  person approving everything. A secretary approves nothing.
- **Who may ask:** anyone who can sign in. Asking is harmless and the approver is the
  control; making people qualify for the right to ask would send them back to the phone.
- A **reason is mandatory** on asking and requested on declining. Duplicate pending
  requests are refused (409); asking about something not locked is refused (400).
- `quarter` is the only **timed** kind (48 hours or until the quarter's deadline) because
  it re-locks itself on resubmission. The other four open and are re-locked by their
  owner when the correction is in. `resolveWindow()` lives in `unlockKinds.js` so the
  board's reopen and this one cannot drift to different lengths.
- **Self-correction without asking:** `SELF_CORRECT_HOURS = 12` in `routes/meetings.js`
  lets whoever recorded a meeting's attendance fix their own entry for 12 hours. Most
  "errors recorded while taking attendance" are caught in the same evening; those should
  never need an approver.
- **Client side:** `reopenButtonHtml()` + one delegated click handler in `app.js`, so
  every locked screen offers the same button and there is one code path to get wrong.
  `page-entry.js` is deliberately left alone — the quarterly entry already had its own
  change-request flow and does not need a second way to ask.

---

## 7. Testing

`scripts/test-*.js` — each boots the app against a **throwaway copy** of `data/`
(`AOTC_DATA_DIR`), stubs auth, and drives the real routes over HTTP. Several load the
real HTML and JS in jsdom. `npm test` runs `node --test`, which also picks up the
older server-dependent suites (they need a live server on :4321 and fail with
`fetch failed` otherwise — environmental, not a regression).

```
test-global-clashes.js        every page script against app.js (run before deploy)
test-submission-board.js      the board
test-board-reopen.js          reopening + the traffic light
test-weekly-finance-page.js   the weekly page in jsdom
test-weekly-totals.js         running totals
test-per-member-giving.js     per-member figures
test-per-member-override.js   typed vs computed
test-part-year-coverage.js    a part-year must not read as a full year
test-session-regression.js    CLN-02, scoping, weekly finance, the quarterly panel
test-nav-visibility.js        who sees which nav entries
test-dates.js                 run in three timezones
test-fundraising-roles.js     the money-office separation
test-derived-kpi-reporting.js CLN-02 derived server-side, in the report as well as the form
test-submission-poster.js     the poster SVG (layout, wrapping, colourblind encoding)
test-unlock-requests.js       the request model: routing, duplicates, real unlocking
test-reopen-buttons.js        the client half — who is offered the button, on which screen
test-board-archived.js        the board/poster leave archived bodies off
test-permission-split.js      the split, the migration, real middleware over HTTP
test-permission-pages.js      Users page (sensitive, vs role, search, cards) + Goals page, jsdom
test-account-switch.js        account on/off with the real login and cookie
test-matters-truncation.js    cut-off "read with AI" lists salvaged
test-minutes-oct2026.js       tidy-up safety + thinking, house style, decisions, chairman, carry, updates, times
test-proofread.js             export → tracked changes/comment → upload → accept/directive/rules, undo (34)
test-sqlite-store.js          the SQLite store: import, contract, two processes, export round trip, laptop guard
test-corr-export.js           correspondence export (all scopes, access, pages) + Mrs → Madam carried into text
scripts/proofread-ui/         the review screen in Chromium (21 checks, needs Playwright — cloud sandbox; see its README)
```

**Run them one at a time against a fresh sandbox.** Most suites hard-code
`AOTC_DATA_DIR = $HOME/sbx` on line 1 (no `||`), so they share one directory: run them
in a loop without re-copying `data/` between them and earlier suites' rows poison later
ones. The symptom is a tidy row of plausible wrong numbers, not a crash.

```bash
for f in scripts/test-*.js; do
  rm -rf $HOME/sbx && mkdir -p $HOME/sbx && cp data/*.json $HOME/sbx/
  node "$f"
done
```

`test-harvest.js` and the three `test-marriage*.js` need a live server on **:4321** *and*
a seeded fixture dataset (`harvest@test.com` etc., passwords unknown). They cannot run
against the live snapshot and their failure is environmental, not a regression.

**The discipline that matters.** Before and after any change, md5 every file in
`data/` and prove it is byte-identical. The user's live dataset is the thing that
must never be disturbed; "I didn't mean to write" is not evidence.

---

## 8. Traps that have actually bitten

1. **`const money` in a page script collided with `function money` in `app.js`.**
   Entire page script never parsed. Blank page, no error, API returning perfect data.
   `scripts/test-global-clashes.js` now guards it and runs pre-deploy.
2. **`e instanceof SyntaxError` across a `vm` realm is always false.** The first version
   of that guard reported "no clashes" on the very file that was broken. Compare
   `e.name`. *A test that passes for the wrong reason is worse than no test.*
3. **`routes/documents.js` was never mounted.** Complete module, dead for its whole life.
4. **Permissions declared but not offered in the Users UI** — ungrantable. Twice.
5. **Over-broad gates.** The attendance footnote and the CLN-02 group breakdown were
   gated on "not a group", which is *every committee* — DSS opened its return to a table
   of other groups' headcounts. Gate on the page's own content, not the entity type.
6. **An admin-unlocked quarter read as Submitted** on the board — the opposite of the truth.
7. **`window` as a parameter name** shadowed the global.
8. **Local `data/` is a stale snapshot of the server.** Conclusions drawn from it about
   what exists live are unreliable — the user has corrected this before.
9. **A stale tab.** A blank page was an old tab from days earlier; the date picker gave
   it away. Check what the page *says* before assuming the code is wrong.
10. **The desktop folder mount wedges** ("Resource deadlock avoided"). Every read fails
    while directory listings still work. Say so and wait; do not report conclusions
    drawn from failed greps.
11. **`n - (fail ? 1 : 0)` as a test summary.** Printed "17/18" while five checks were
    red. Count real failures. (Found in eight suites; all now use `n - fail`.)
12. **Python `.replace()` that silently matches nothing** — an em dash against `\u2014`.
    It reported success and changed nothing. Assert the match count before writing.
13. **Backticks inside a `w.eval(\`...\`)` harness block.** Adding a template-literal
    stub to `test-fundraising-entry-dom.js` closed the outer template. String
    concatenation inside those blocks, always.
14. **`innerHTML` re-escapes attribute quotes.** A regex for `"meetingId":7` over
    serialised HTML fails on `&quot;meetingId&quot;:7`. Parse the attribute instead.
15. **Two pre-existing `test-dates.js` source-scan failures** (`routes/meetings.js:486`
    builds a year from `new Date(rec.date)`; `page-finance-weekly.js` hand-rolls
    `+ 'T00:00:00'` instead of using the shared helper). Harmless while the server sits
    in Accra at UTC+0; latent everywhere else. Neither was introduced by recent work —
    do not assume a fresh failure when the scan goes red.

16. **An archive with no way back.** The red Archive button sat beside Edit for 30 secretaries
    and nothing could restore an archived group, so the Choir was re-created as a twin. Any
    one-way action needs an undo before it ships.
17. **A length cap that silently truncates.** Tidy-up (2,000 tokens) and "read with AI" (3,000)
    stopped mid-answer on long minutes; the page then saved the half-answer over the notes.
    Check `stop_reason`, and never replace user text with a partial result.
18. **The home-screen app has no browser chrome.** `target=_blank` / `window.open` strands the
    user. Route every document through `openDocViewer`.
19. **Express route order.** `GET /:id` swallows `/house-rules`, `/proofreads/trend` etc.
    Literal paths go **before** `/:id`.
20. **Another session edits the same files.** `push.sh` changed under us on 8 Oct (SSH alias).
    Re-read a file before editing it if time has passed.
21. **`sed -i` on `deploy/push.sh` dropped its execute bit** (8 Oct) — it rewrites the file as a
    new one. The deploy then failed with "permission denied". After any `sed -i` on a script,
    `chmod +x` it; or edit with Python, which keeps the mode.
22. **Rehearsal stand-ins can lie.** A `( cd x && node … & )` records the subshell's pid, so "stop"
    left node running; a proxy that re-read its file on every request "failed" during undo where
    Apache (which waits for reload) would not. Make stand-ins behave like the real thing first.
23. **`LINES` is a bash variable.** The blue-green folder variable was called `LINES`; under
    `ssh -t` bash resets it to the terminal height (24) after each command, so the first real
    `--apply` (8 Oct) made the lines in `~/24/` and wrote a relative WorkingDirectory — systemd
    refused the unit and nothing switched. Renamed `LINES_DIR`; every path is now checked to be
    absolute; the rehearsal runs `--apply` under a terminal (`script`). Never name a shell variable
    LINES, COLUMNS, PWD, HOME, PATH, UID, RANDOM, SECONDS.
24. **Opening a database is not reading a file.** With SQLite, merely using `db` creates
    `data/aotc.db` and moves the JSON files in. A page test that required `utils/unlockKinds` for a
    list of names did that to the Mac's own `data/` (9 Oct; stopped by a disk I/O error on OneDrive,
    files intact). Hence: open on first use, and outside production only a throwaway copy. Tests
    that set rows mid-run use `db.writeAll`, not `fs.writeFileSync(<c>.json)`.
25. **A symlinked folder is copied as a symlink.** The first automatic backup on blue (9 Oct 01:55)
    did `fs.cpSync(<line>/data → backup/data)`; on a line `data` is a link, so the backup's `data`
    became a link to the live folder, and `db.snapshot()` then deleted the live `aotc.db` (and its
    WAL) and wrote the snapshot in their place, through the link. Blue kept the real database open
    (deleted but alive). Shown by an 8 KB backup. Fixed: `backup.js` resolves real paths and copies
    with `dereference`; `snapshot()` refuses the live folder; the rehearsal now backs up on a line.
    Recovery: `deploy/bluegreen/recover-2026-10-09.sh` (copies db + WAL out of `/proc/<pid>/fd`,
    rehearsed: all rows back, integrity ok).

---

## 9. Outstanding

### 0.4.32 inflow list fits the page — built, not deployed (21 Nov 2026)

Release with the usual order. Check: Fundraising → Inflow entries is full width, no sideways scroll on a
laptop or phone; each day shows Open, its next step and More ▾. In a sheet, the cheque and transfer Bank
boxes are dropdowns; Other shows a box to type in. Print a sheet and type it: the screen reads like the
paper (B Cheques, C MoMo on both) and Enter walks it top to bottom.

### 0.4.31 the day is set up first — deployed (checked 21 Nov 2026: healthz 0.4.31, green live)

0.4.30 was released 19 Nov from the phone (files uploaded to ~/aotc-staging, release.sh run) and checked
live (healthz 0.4.30, blue). Release 0.4.31 with the usual order. Check: Record fundraising day on a new
date shows only "Set up the day"; after it, the day appears in the inflows list.

### 0.4.30 Record fundraising day = harvest sheets — deployed 19 Nov 2026 (from the phone; healthz 0.4.30 on blue)

Release with the usual order (check-version, commit, push, deploy/push.sh). Check on the live site:
"+ Record fundraising day" opens the day window; sheet 01 is Gratitude & Thanksgiving; Tally & report shows
the event's target.

### 0.4.29 harvest basket sheets — deployed 18 Nov 2026 (blue live)

Released 18 Nov 09:50 (carries 0.4.28). Checked from the browser pane: /api/healthz 0.4.29 on blue,
page-fundraising-sheets.js served, the Enter harvest sheets button in the page, /api/fundraising/sheets and
/basket-sheets.pdf answer 401 (mounted, want a login). push.sh markers 'group chart' and 'merge into mine'
printed 0 — this release touched neither (fundraising files, an appended style.css block, server.js body
limit); check against an earlier deploy log whether they were 0 before. Still to do on the live site,
signed in: Fundraising → ⌨ Enter harvest sheets → choose the event and date → Print sheets opens the
PDF; type one sheet (wrong total refused, right total saves, tile turns green); Day summary opens.
Before the harvest: print the set, clip each sheet to its basket, and run one practice sheet with the
desk team.

### 0.4.9 letters by item number — built, not deployed (5 Nov 2026)

Release with `push.sh` (carries 0.4.3–0.4.8).

### 0.4.8 visitors' letters — built, not deployed (5 Nov 2026)

Release with `push.sh` (carries 0.4.3–0.4.7). "Fill in from the letter" needs ANTHROPIC_API_KEY on the
server (already used for letter drafting).

### 0.4.4 Change to visitors — built, not deployed (5 Nov 2026)

Release with `push.sh` (carries 0.4.3 too).

### 0.4.3 version in sidebar / More / footer — built, not deployed (5 Nov 2026)

0.4.2 was deployed on 5 Nov. Release 0.4.3 with `push.sh`.

### 0.4.2 Visitors to the Session — deployed 5 Nov 2026

Release with `push.sh` (carries 0.4.1 as well if that is not yet out). Check: Minutes → + Add visitors;
the Presentation item prints one paragraph per group; nothing is added to In attendance.

### 0.4.1 Minutes recorded by — built, not deployed (5 Nov 2026)

Release with `push.sh`.

### 0.4.0 update bar — built, not deployed (3 Nov 2026)

Commit `d82d0d6`. Release with `push.sh` as usual (it now checks the version first). Check: About shows
0.4.0 · 3 November 2026 and What's new; with a page open, the next release shows the bar.

### Pulse sign-ins — built, not deployed (9 Oct 2026)

Code is in place (see §6). To switch it on:

1. Run `sudo bash /opt/pulse/scripts/app-token.sh aotc-track` on the server. It writes
   `PULSE_APP` and `PULSE_APP_TOKEN` into the line env files.
2. Release with `push.sh` as usual.

Check: AOTC Track's card on Pulse → Sign-ins turns live within a minute of a sign-in.
`clientIp()` in `routes/auth.js` no longer trusts the first `X-Forwarded-For` value, which a client can
spoof. It now uses `req.ip` (with `trust proxy`), or the last value, which Apache appends. That value
feeds the login log, new-device detection and the reports sent to Pulse. Fixed 9 Oct; ships with the
next `push.sh`.

### Proofreading review screen — finished 8 Oct 2026 (night)

Written earlier on 8 Oct, tested and finished in the next session:

- **Browser check** (`scripts/proofread-ui/`, Chromium, desktop 1280px and phone 390px): 21/21 —
  grouping, progress, filter, Preview, Accept, Go to item (tab, scroll, flash), Undo on a change
  and a comment, Draft → Apply, Accept all, no sideways scroll, no page errors.
- **Fixed from looking at it:** the Go-to button rendered as a grey browser-default button
  (`.btn-link` does not exist in `style.css`). `.pr-go` in `minutes.html` is now a plain blue link.
- **`test-proofread.js`** gained undo checks (accept → undo → re-accept; reject → undo; undo after a
  hand edit → 409 with the edit kept; comment apply → undo keeps directive and draft; `para` stored).
  34/34.
- **All suites, one at a time on a fresh `$HOME/sbx`:** green except the two known `test-dates.js`
  source-scan failures (§8 #15). `test-submission-poster.js` hard-coded "days left" and went red
  once the Q3 deadline passed (5 Oct); it now accepts "days overdue" too. `data/` md5-identical
  before and after (37 files).
- **`push.sh` marker:** `review screen` — must print **1**.

**Follow-up the same night, from the Clerk using it live on the 24 Sept file:**

- **A way back from "Go to item".** A floating **← Back to proofreading** button (above the phone
  tab bar), and the phone/browser **Back** button, return to the Documents tab at the very card you
  left, flashed. (`prReturn`, `prBackPill`, `prBack`, `prReturnNow`; a `{prGo:1}` history entry.)
- **Why so many corrections had no Accept** — read from the live record (doc 3, 20 changes, 5
  comments). Four had a false "edited since export": the app stores `Rev.`/`Ms.` while the printed
  minutes say `Rev`/`Ms` (changes 18, 20; comments 4, 5). Also latent: list points print with `•`
  (stored bare or with `-`), and item **headings** were never matchable. `utils/proofread.js` now
  compares with `bare()` (no bullet marker, no title full stop), keeps the stored marker when writing
  back (`withMarker`), and matches/edits headings (`headingMatches`, `subjectFrom`, `li: 'subject'`).
- **Matching is re-done on every read** (`prOut`), not frozen at upload — so the file already
  uploaded gains its Accept buttons after deploy, without uploading again.
- **Still no Accept, correctly:** text the app writes from the meeting details — devotion (change 1),
  constitution (3), a Review-of-Minutes correction (4, "the following was added to item '5.2'…" —
  fix it in that correction on the Agenda tab), and a correspondence letter (17, from the
  Correspondence tab). Possible next step: let Accept reach the correspondence summary and the
  review corrections.
- **Changed since export → settle first, by merging** (the Clerk chose "merge his fixes into mine").
  Pending changes whose paragraph was edited after export are listed first under "⚠ Changed in the
  app since you sent it". Each shows his corrections, the Clerk's wording now, and the result of
  `PR.mergeSegs()` — every tracked change re-found in the new wording by its own words plus a little
  context either side, unique match only, never guessed; what no longer fits is listed "to make by
  hand". Buttons: **Merge into my wording** (action `merge`, status `merged`, `mergedFrom/To`,
  undoable) and **Merge all N that fit** (`accept-all` with `{merge:true}`, only clean merges).
- **Live, then refined (8 Oct, late):** on the real file the "changed" group held a comment that
  the Clerk had not changed at all — Dr Tweneboa's comment 3 sits on "inducted", a word **his own**
  tracked change (7) put in; accepting 7 made the paragraph differ from the copy he commented on.
  `prOut` now tries the paragraph as corrected (`paragraphAfter`, else the same-paragraph change's
  `after`/`mergedTo`) before calling it changed (`at.viaCorrection`), returns `current` (the
  paragraph as it reads now) for comments, and the propose route uses that. Every card in the
  "changed" group now shows **exactly what changed** (`prWordDiff`, word-level, sent → now). The
  bulk buttons say which corrections they act on: "Accept his N corrections on unchanged
  paragraphs" / "Merge his N corrections into your newer wording". Marker: `shows what changed` (1).
- **"Written from the meeting details, or not found" now has a way in and back.** `prSource(text)`
  works out where such text comes from — the closest correspondence summary (Correspondence tab, at
  that letter: `.corr-card[data-cid]`), a Review of Minutes correction (`.rev[data-rev]`), or the
  opening/devotion, constitution, presentation, prayers or closure fields — and the card offers
  "Open the … →" (`prGoTarget(pane, sels, ref)`: opens the tab, flashes the box, puts the cursor in
  the field). "← Back to proofreading" / phone Back return to the card. Going back to Documents by
  hand now ends the offer (it used to end on leaving the Minutes tab, which would have killed the
  way back from the Correspondence tab). Browser check `ui-source.js` 11/11.
- **Found while testing it: the correspondence register was broken.** `loadRegister()` on the
  minutes list page called `pageLinks()`, which did not exist, so any register with a letter in it
  threw and stayed empty. Defined it. Marker: `open where it comes` (1).
- **Tidy-up leaves no empty lines between paragraphs** (`tightParagraphs()` in `aiAssist.js`), except
  the one blank line that ends an unmarked list — that blank line is what keeps the next sentence
  prose in `bulletise()`. The printed minutes were never affected; this is the text in the box.
- Tests: `test-proofread.js` 50/50, `test-minutes-oct2026.js` 50/50; browser checks 27/27 + 7/7
  (`ui-merge.js`), desktop and phone. Markers: `back to proofread` (≥1), `bullets+headings` (1),
  `merge into mine` (≥1), `tidy no blank lines` (1).

**Deploy status (8 Oct 2026):** the 5 Oct deploy (board skips archived bodies) is **live and
checked**. Everything else in "Built 5–8 Oct 2026" in §6 is **built and tested but NOT yet
deployed** — one `push.sh` run takes it all; its markers run from `board skips archived`
through `users tabs` (plus `review screen`, which must print **1**), and `migration ran (1)`
must print exactly **1**.
**SQLite — DEPLOYED 9 Oct 2026.** Look-first on the server: 63 collections, 8,272 records, no id
problems, node 22.23.3. push.sh (single service): `SQLite records: 8272`, `JSON read in (1): 1`,
`migration ran (1): 1`. The JSON files are in `/opt/aotc-track/data/json-before-sqlite/`. Also on that
deploy, every 5–8 Oct item (correspondence export, title carried over, review screen…) is now live.
Marker quoting fixed afterwards (`chairman signs`, `corr export API` printed 000, `users search+cards`
and `users tabs` printed 0 — all were quoting inside the ssh string, not the app).
**Letter-page tray REBUILT and DEPLOYED 9 Oct 02:20 (second blue-green release, green → blue; `camera tray` 2):** `openTray/trayAdd/trayMove/trayDrop/trayUpload`
in `page-correspondence.js`, markup + styles in `correspondence.html`; IndexedDB `aotc-tray`; photos
over 900 KB shrunk to 2000 px JPEG; max 10 pages (server MAX_PAGES). CSP `img-src` now allows `blob:`
(thumbnails and the viewer's image view were blank). Browser check 19/19 at 390 and 1280 px
(`scripts/tray-ui/`). Marker `camera tray` should now print ≥1.
**Found (before the rebuild):** `camera tray` prints 0 and the local `page-correspondence.js` has no `trayAdd` — the photo
tray described in `claude/correspondence-inbox.md` (25 Sept) is NOT in this code (no snapshot since
25 Sept has it). Ask the user before rebuilding.
**SQLite: how it was switched on (before blue-green)** — (1) look first, reads only:
`rsync -avR utils/jsonImportPlan.js scripts/sqlite-import.js deploy@track.pcg-aotc.com:aotc-staging/`
(from the app folder) then `ssh -t deploy@track.pcg-aotc.com "node --version; sudo node
~/aotc-staging/scripts/sqlite-import.js /opt/aotc-track/data"` — must end "ready", node ≥ 22.13;
(2) one ordinary `push.sh`: the restart reads the JSON in (markers `SQLite records` > 0,
`JSON read in (1)` = 1, `migration ran (1)` = 1); (3) sign in and look. Rollback to the JSON code:
stop, `sqlite-export.js` into data/, move `aotc.db*` aside, restore the code tarball.
**9 Oct 02:06–02:08 UTC:** the 01:55 backup had replaced the live `aotc.db` through the data/ link
(trap 25). `recover-2026-10-09.sh --apply` copied the real database + WAL out of blue's open files:
integrity ok, 8,274 records, ~3 s down; the replaced files are in `/root/aotc-recover-20261009-020624/`.
Then the **first blue-green release** (push.sh): records copied to `/var/backups/aotc-track/`, green
healthy on 3012, switched, blue stopped; every marker correct (`SQLite records 8274`), except
`camera tray` 0 (that feature is missing from the code — see above). Confirmed 02:09: green's first
automatic backup is 9.6 MB with a real data/ (aotc.db snapshot, json/, settings, photos).
**Blue-green — PROVISIONED 9 Oct 2026 (01:54 UTC).** Ports **3011 (blue) / 3012 (green)** (3001 and
3100 are other apps; 3101/3102 are IFAIMA). Both Apache files (`track.pcg-aotc.com.conf` and
`-le-ssl.conf`) now `Include /etc/apache2/aotc-live.conf`; backups `*.pre-bluegreen`. Blue healthy
(`database:true`), live; old `aotc-track` service stopped and disabled, kept. HTTPS login page 200.
Every `push.sh` now releases to the idle line. Still to see: the first real release (→ green) and a
rollback. Leftover `~/24` from the failed first run may still be in /home/deploy (harmless; delete).
**Blue-green: how it was switched on** (in this order): (1) one ordinary `push.sh` (puts the scripts and the
`AOTC_LINE` gate on the server); (2) `ssh -t deploy@track.pcg-aotc.com "sudo bash
~/aotc-staging/deploy/bluegreen/provision.sh"` — checks only, paste the output to Claude; (3) the same
with `--apply`. After that `push.sh` is unchanged for the user. **8 Oct:** the first check stopped at "port 3001 is already in use" (as designed, nothing changed). Ports are now chosen at provisioning (`sudo env AOTC_BLUE_PORT=… AOTC_GREEN_PORT=… bash provision.sh`) and remembered in `/etc/aotc-lines/*.env`. Marker: `blue-green ready` (≥1).
**Built 8 Oct, late night, NOT deployed:** correspondence export and the title change carried into
the text (§6). `test-corr-export.js` 37/37; all suites green except the two known `test-dates.js`
scan failures; `data/` md5-identical. Markers: `corr export API` (401), `corr export button` (1),
`title carried over` (1).
**Madam Cecilia Pokua Anto** — the user confirmed "Madam" (8 Oct). After the deploy: Session
Composition → her title → untick Mrs, tick Madam → Save → accept "Change them all". Only her
roster record is live data; the local snapshot has no session_members.
Still for the user: his four 24 Sept
comments; whether the chairman of a meeting should also be able to press Confirm.

**Deployed and in use:** the submission board, board reopening, the green
`badge-done`, `correspondence.intake` in the Users UI, the row ordering, the unlock-request
model, the WhatsApp poster.

**Built but NOT yet deployed as of 3 Oct 2026 (now live)** — the derived-KPI report fix
(`utils/derivedKpi.js`; CLN-02 showed 46 on the entry form and printed 0 in the exported
report, because derived values only persisted while the quarter was unlocked and the
report reads stored entries), the WhatsApp poster and its Download image button, and the
whole reopen-request model above. `deploy/push.sh` carries markers for all of them —
`unlock API`, `unlock page`, `unlock nav`, `ask-to-reopen btn`, `five lock kinds`,
`poster API`, `download button`, `bright chips`, `server-side derive`.

**From the naming audit** (`claude/naming-and-categorisation.md`): §2.3 the two
"minutes", §2.4 entity/workspace vocabulary, §2.5 **one lifecycle vocabulary**
(the one that touches strings a secretary reads weekly), §2.7 permission-key grammar note.

**Open questions for the user:**
- Should Treasurer, Accounts Clerk and Viewer see the submission board? They do today,
  through `congregation.view`.
- Does the green `badge-done` look right across all 17 pages it repaints?
- SO-2.1's January 2026 baseline — enter it once and the percentages self-report; without
  it they stay honestly blank.
- Where do Building Pledge and Building Project Support belong in the quarterly panel?
- Is 12 hours the right self-correction window for meeting attendance?
- Should the Reopen Requests queue show a pending count in the nav, as Access Requests does?

**Known-but-unbuilt:** no "Share this goal with…" action (`POST /goals` rejects duplicate
codes); the `supporting` field is dormant; year-on-year comparison will be misleading in
2027 because 2026 holds only a part-year of weekly finance.

---

## 10. How the user works

- Speaks in voice notes — transcripts arrive with run-on phrasing and homophones
  ("clan" = CLN, "ulna" = unlock). Read for intent, confirm when a word changes the build.
- Wants the real answer, not a cheerful one. Flag over-broad gates, wrong assumptions and
  your own mistakes plainly.
- **Must not disturb the live dataset.** Say this with evidence, every time.
- Checks the work on a real device and comes back with precise symptoms. Take them literally.
- Prefers building to discussing, but asks "what do you suggest?" when the shape is unclear —
  that is a real request for a recommendation, not a prompt to start coding.
