# Visitors to the Session — intended marriage, browser check (5 Nov 2026)

Needs Playwright + Chromium (run it in the cloud sandbox). Throwaway data only.

```bash
export AOTC_DATA_DIR=$HOME/sbx-vis JWT_SECRET=$(printf 'x%.0s' {1..48}) TZ=Africa/Accra PORT=4556
node scripts/visitors-ui/setup.js          # one set of minutes, a Linguist, one marriage case with both occasions
(node server.js &) ; sleep 3
cd scripts/visitors-ui
node -e "console.log(require('../../node_modules/jsonwebtoken').sign({id:1,name:'Clerk',email:'c@t',role:'admin',sv:0},process.env.JWT_SECRET,{expiresIn:'2h'}))" > token.txt
mkdir -p shots && node ui.js               # W=390 node ui.js for phone width
```

9 checks: Marriage shows Traditional marriage and Church wedding (date, time, where); choosing the
marriage case fills names and both occasions; the preview heading and paragraph; a time typed any
way is corrected; saved with both occasions; reopening shows them again; no page errors.

`ui-sem.js` (8 checks): "Seminarian or ministerial probationer" in the list; a seminarian with year,
seminary and dates; switching to probationer puts year and seminary away and keeps the name; the
preview; saved. Restart the server after re-running `setup.js` (the store keeps its file open).

`ui-layout.js` (6 checks; `DARK=1` for night mode): the Minutes tab has one block per section with
its pick fields in it (opening, constitution, visitors, review, carried forward, prayers, closure),
the section bar lists them in order and jumps, Tab after a pick field moves on (fields are moved, not
redrawn, so the cursor is kept), and in night mode the prayers and closure preview are dark.
