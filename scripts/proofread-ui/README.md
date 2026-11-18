# Proofreading review screen — browser check (8 Oct 2026)

Needs Playwright + Chromium (not on the Mac by default; run it in the cloud sandbox).
Throwaway data only — never point AOTC_DATA_DIR at data/.

```bash
export AOTC_DATA_DIR=$HOME/sbx-ui JWT_SECRET=$(printf 'x%.0s' {1..48}) TZ=Africa/Accra PORT=4555 ANTHROPIC_API_KEY=test-key
node scripts/proofread-ui/setup.js
(node -r ./scripts/proofread-ui/stub-ai.js server.js &) ; sleep 3
cd scripts/proofread-ui
node -e "console.log('token='+require('../../node_modules/jsonwebtoken').sign({id:1,name:'Clerk',email:'c@t',role:'admin',sv:0},process.env.JWT_SECRET,{expiresIn:'2h'}))" > cookie.txt
node makedocx.js http://127.0.0.1:4555 "$(cat cookie.txt)" 1
mkdir -p shots && node ui.js          # W=390 node ui.js for phone width
```

21 checks: grouping by item in document order, progress bar, Show only what's left,
Preview / Show the marks, Accept → "Now in the minutes", Go to item (tab, scroll, flash),
Undo on a change and on a comment, Draft the change → Draft it again → Apply,
Accept all, no sideways scroll, no page errors. Screenshots go to shots/.

`ui-merge.js` (7 checks): a paragraph edited in the app after export is listed first under
"Changed in the app since you sent it", with the Clerk's wording, his corrections merged into it,
**Merge into my wording**, **Merge all N that fit**, and Undo. Run after `setup.js` + `makedocx.js`.

`ui-source.js` (11 checks): a correction on text the app writes from details kept elsewhere offers
"Open the opening & devotion details" / "Open the letter on the Correspondence tab" (etc.), which
opens that tab at the field or letter, and Back to proofreading returns. Run after `setup.js`
(empty `correspondence.json` first); it seeds its own proofreading record.
