# AOTC Track — where the work stands

Written 27 August 2026, revised the same evening. Read this first if you are
picking the work up cold. `MATTERS-ARISING-HEADINGS.md` beside it covers the
Matters Arising heading work, which is now finished and tested but **not yet
deployed**; this file covers everything else.

---

## 1. Where the code lives

| | |
|---|---|
| Working copy | `Projects/Software/AOTC Reports Software/aotc-track` |
| Server | `172.93.52.195`, app at `/opt/aotc-track`, runs as user `aotc` |
| Public address | `https://track.pcg-aotc.com` — **does not resolve from the Mac for SSH; always use the IP** |
| Service | `systemd` unit `aotc-track`, node on port 3000, Apache in front |

**There is no git repository.** Files move Mac → server by rsync, and this
session's sandbox → Mac by hand. Nothing is versioned. That is the single
biggest risk to this project: an interrupted session loses whatever has not
been copied back to the folder.

### Deploy — one block, two legs

Both legs and the verification in one paste. The `&&` chain matters: a failed
push must not promote, and a failed promote must not report success.

```bash
cd ~/Library/CloudStorage/OneDrive-Personal/Projects/Software/"AOTC Reports Software"/aotc-track \
&& rsync -av --exclude node_modules --exclude .env --exclude data --exclude backups \
  --exclude minutes --exclude generated --exclude 'public/uploads' \
  --exclude marriage-files --exclude 'LAYOUT-RESEARCH-*.md' --exclude layout-preview.html \
  --exclude '*.zip' --exclude '.DS_Store' --exclude '_*' \
  ./ deploy@172.93.52.195:aotc-staging/ \
&& ssh -t deploy@172.93.52.195 "sudo rsync -a --chown=aotc:aotc \
  --exclude data --exclude .env --exclude minutes --exclude generated \
  ~/aotc-staging/ /opt/aotc-track/ && sudo systemctl restart aotc-track" \
&& sleep 3 \
&& echo "--- promoted? (above zero is good) ---" \
&& ssh deploy@172.93.52.195 "curl -s http://127.0.0.1:3000/js/page-session-matters.js | grep -c groupsOf"
```

The `ssh -t` on the second leg asks for the sudo password, so this is not
unattended — expect one prompt part way through.

**The last line is not optional.** Twice a change has looked broken when the real
fault was that it had never been promoted. Above zero means the new file is
being served; `0` means the promote did not take, and nothing about the app is
worth debugging until it passes. Change the file and the string being grepped to
whatever you have just shipped.

`data` is excluded on **both** legs deliberately. The live accounts, minutes and
settings are on the server; a stray copy from a laptop or a sandbox would
overwrite real records.

### Known deploy traps

- rsyncing from the parent folder drags `aotc-track copy.zip` (30 MB) along and
  appears to hang. `cd` into `aotc-track` — note the `./` source.
- `ls /opt/aotc-track` gives *Permission denied*. Expected: `deploy` cannot read
  into an `aotc`-owned directory. Verify over curl, never `ls`.
- `deploy/DEPLOYMENT.md` still documents an older single-step `root@` deploy
  straight into `/opt/aotc-track`. It will fail on permissions now. The correct
  commands are in that file under *"The deploy you actually run"*.

---

## 2. Tests

Run from the project root. There is no runner; each is a plain node script that
prints `ALL n CHECKS PASSED` or lists failures.

```bash
for f in smoke7 format-check agenda-format-check matters-headings-check \
         register-dom-check agenda-pick-check review-pick-check; do
  printf '%-26s ' "$f"; node $f.js 2>&1 | grep -Eo 'ALL [0-9]+ CHECKS PASSED|[0-9]+ FAILED.*' | tail -1
done
node --test test/db.test.js test/logic.test.js
```

That is **506 checks plus 10**, all passing as of 27 August 2026 evening.

### The missing test scripts — read this before believing an earlier note

An earlier version of this file listed `smoke2` … `smoke6`, `agenda-check`,
`proc-check`, `corr-check`, `test-minutes` and `test-workspaces`, and put the
total at roughly 470 checks. **Those files are not in the project folder and
never were.** They were written inside a previous session's cloud sandbox and
never copied back — precisely the risk section 1 warns about. Do not go looking
for them; either rewrite what is worth having, or treat the four scripts above
as the suite. `format-check.js` survived but had `/tmp/aotc/utils/...` hardcoded
in four requires, so it could not run outside that sandbox either; it now
requires `./utils/...` and passes.

`adm-zip` and `jsdom` are needed by the checks and were missing from
`package.json`; they are now `devDependencies`. Install with a plain
`npm install` — a production install on the server skips them, as it should.

### browser-check.js — could not be run on 27 August

`browser-check.js` drives a real Chromium via Playwright and starts its own
server on port 4455. It expects the binary at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, which is a **cloud sandbox
path, not a path on any machine of the user's**. On the Mac's session VM there is
no Chromium, and Playwright's browser CDN is outside the egress allowlist, so
`npx playwright install chromium` fails at the download. Copying the source up
to a sandbox that does have Chromium was blocked too — file staging refused with
`untrusted_device`, which needs the user to sign in again in the Claude desktop
app.

So the heading work has **not** been through a browser. `register-dom-check.js`
was written to cover as much of the gap as honestly possible: it loads the real
`session-matters.html` and `page-session-matters.js` into a jsdom DOM and drives
`render()` over fixtures, checking the heading cards, the per-sub-note *Mark
cleared* buttons and their targets, the datalist, the open filter and escaping.
It is not a browser. Run `browser-check.js` when a Chromium is to hand, and fix
its `executablePath` to be discovered rather than hardcoded while you are there.

**Method that has repeatedly paid off, and should be kept:**

1. **Measure the real documents before changing behaviour.** Every formatting
   decision in this app came from counting what the congregation's own 2026
   minutes actually do, not from what anyone remembered them doing. When a
   guess was made instead, it was wrong — the underline was put on the review
   headings when it belonged on the document title, because the search only
   looked inside the table.
2. **Render and look at the output.** Word and PDF have both shipped visually
   broken output that passed the XML assertions — a bullet flush against its
   word because `<w:tab/>` landed outside the run, a signature panel split
   across a page break. Convert with `soffice --headless --convert-to pdf`,
   rasterise with `pdftoppm`, and actually look.
3. **Reproduce "it doesn't work" in a browser** before theorising. Two rounds of
   guessing were wasted before this became the rule.
4. **Check it is deployed before diagnosing.** See the curl above.

---

## 3. The house style, as measured

All figures counted across the ten 2026 minutes documents.

| | |
|---|---|
| Title | Times New Roman 12pt, bold, centred, **underlined** (10 of 10) |
| Roster, headings | Times New Roman 12pt |
| No. column | Times New Roman 12pt **bold** |
| Subject headings | Times New Roman 12pt bold, **1.5 line spacing** |
| Body, Action column | **Verdana 10pt**, 1.5 line spacing (`w:line="360"`, 273 of 281 paragraphs) |
| Justification | `w:jc both` on body prose (179 of 180); bullets left-ragged |
| Underlines inside the table | **none** — the underline belongs to the title alone |
| Prayer points | real bulleted list, 720-twip indent, 360 hanging |
| Page 1 | attendance only; the No./Subject/Action table opens page 2 (explicit page break) |
| Signature panel | ruled table, heading row filled `#D9E2F3`, headings Times New Roman 12pt, names and offices Verdana; follows the table directly; no date line |

Fonts in the PDF are embedded from `ttf-mscorefonts-installer` on the server
(`/usr/share/fonts/truetype/msttcorefonts/`). pdfkit's built-in "Times" is
Nimbus Roman, a different face — hence the real files. Liberation Serif and
DejaVu Sans are the fallbacks if the package is ever missing.

**pdfkit keeps its font table per document.** Every document the module builds
must call `registerFonts(doc)`. The agenda PDF was missed once and died with
`ENOENT: 'Head-Bold'`; there is now a check that builds it.

---

## 4. Rules of the Session the app encodes

- **Only an agent may constitute a meeting** or pronounce the benediction —
  Reverend Ministers and Catechists. Presbyters may not.
- **Adoption of minutes** may only be moved or seconded by someone who was at
  *that* meeting and is also present tonight.
- **Non-constitutional offices** — Deputy Senior Presbyter, Assistant Session
  Clerk, Linguist — print as **MEMBER** in the roster. The office is still held
  and shown everywhere else in the app; the printed roster stays to the
  constitution.
- **Titles** have two forms and the app knows both: listing form brackets the
  academic title (`Rev Martin Owusu Boamah (Dr)`), running text runs them in
  front (`Rev Dr Martin Owusu Boamah`). Names are converted to prose form when
  the rows are **built**, not only when saved, so documents captured before the
  rules existed correct themselves on the next export.
- **Closing** may be the Grace, the benediction, both or neither, and the
  sentence frames itself accordingly.

---

## 5. What is unfinished

### Immediately

- **Deploy the agenda work — Matters Arising headings, the Review of minutes
  dropdown, emergency sittings, and the agenda's look.** Written, tested, 242
  new checks passing, **not on the server**. `MATTERS-ARISING-HEADINGS.md` describes it in
  full. The files that changed: `utils/sessionMinutes.js`, `utils/aiAssist.js`,
  `routes/minutes.js`, `public/session-matters.html`,
  `public/js/agenda-editor.js`, `public/js/page-minutes.js`,
  `public/js/page-session-meetings.js`, `public/js/page-session-matters.js`,
  `public/session-meetings.html`.
  Also `utils/sessionDocx.js` and `utils/sessionMinutesPdf.js` for the agenda's
  look — see `AGENDA-LOOK.md`.
  New test files: `matters-headings-check.js`, `register-dom-check.js`,
  `agenda-pick-check.js`, `review-pick-check.js`, `agenda-format-check.js`,
  and `agenda-preview.js` (not a test — it renders the agenda so it can be
  looked at).
  The pre-change originals are in `_pre-headings-backup/` — there is no git, so
  that folder is the only way back. Verify the promote with the curl in
  section 1, looking for `groupByHeading` in `/js/page-session-matters.js`.
- **The 17 open matters extracted from the 2026 minutes were never loaded into
  the app.** This is why an agenda for the 27 August meeting came up with no
  Matters Arising at all: the register is empty, so the button has nothing to
  bring in, with or without headings. Re-run the extraction rather than loading
  the old 17 by hand — the prompt now returns the heading, so the entries will
  arrive grouped. The Clerk reviews the list before anything is saved. 2025 has
  not been done at all.
- **Rev Kofi Manukure Akyeampong took over as District Minister on 1 September
  and nothing is recorded about the handover.** This was flagged as
  time-critical and the date has passed.

### Waiting on the user

- **Session members' phone numbers are not in the app**, so SMS notices cannot
  be sent. Everything else about notification works.

### Housekeeping

- ~~`apt install fonts-crosextra-carlito` on the VPS.~~ **Done differently:**
  Carlito now ships in `utils/fonts/`, tried before anything on the box, so the
  agenda PDF is set in Calibri metrics wherever it runs. Nothing to install.

- **Ubuntu 23.10 on the VPS is end-of-life.** Needs the 24.04 LTS upgrade.
- **Put this project under git.** See the risk note in section 1.
- Offered and never answered: dropping the CLAN report slot from `REPORT_SLOTS`.

### Possible

- Transcription of the five meeting recordings (172/101/134/58/132 minutes) via
  Whisper or Deepgram, roughly $0.82 a meeting. The Anthropic API does not
  accept audio, so this needs a separate service.

---

## 6. Things that bit, and why

- **Data loss — roll and agenda wiped.** Two faults at once: `queueRoll` and
  `queueAgenda` shared one timer so each cancelled the other's save; and a
  `ReferenceError` in `openDoc` was swallowed by a bare `catch`, leaving the
  editor open and empty. Timers are now one per concern with a
  `beforeunload` flush, and boot errors are visible. **Do not add a silent
  catch to this code.**
- **Correspondence photo failing on first attach.** A shared file input plus a
  module-level `addingPagesTo` variable discarded the upload when the page
  reloaded behind the camera. Now one input per card, delegated handler, and it
  never fails silently.
- **The AI restating what the app already wrote.** The devotion and the
  constituting of the Session write their own opening sentence; the tidy request
  now carries that sentence so the model continues from it instead of
  introducing the same person twice.
- **Prompt quality is the developer's job, not the user's.** Early on the user
  was asked to validate prompts and rightly pushed back. Measure his documents,
  build the examples from them, and show the result.
- **A note that lists tests which do not exist is worse than no note.** The test
  inventory in section 2 was carried forward from a sandbox and most of the
  files had never reached the folder; `format-check.js` had that sandbox's paths
  baked into its requires. Half an hour went into looking for scripts that were
  never there. **Before writing a handover note, run what the note claims can be
  run.**
- **Half-finished work parked in a folder is work that does not exist.** The
  heading feature sat complete-but-unapplied in `_wip-matters-headings/` while
  the app was run and deployed without it, so the missing Matters Arising looked
  like a bug in the feature rather than the feature being absent. If work is
  worth finishing, finish it into the files; if it is not, say so in the note.
- **A generated document is only as good as the one it was measured against.**
  The agenda was rebuilt from constants that were close to the congregation's own
  but not equal to them, and every difference showed: narrower columns wrapped
  the Time column, a bold duration tipped it over, and the display face was set
  on forty lines of table that their document sets in Calibri. The fix was to
  unzip their file and count. `AGENDA-LOOK.md` records what was counted, so the
  next change argues with the measurements rather than with taste.
