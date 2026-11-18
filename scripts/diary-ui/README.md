# Church Diary — browser check (7 Nov 2026)

Needs Playwright + Chromium (cloud sandbox). Throwaway data only.

```bash
export AOTC_DATA_DIR=$HOME/sbx-diary JWT_SECRET=$(printf 'x%.0s' {1..48}) TZ=Africa/Accra PORT=4557
node scripts/diary-ui/setup.js            # a Session meeting, a meeting, an approved marriage, a funeral letter,
                                          # a family's announcement, a programme, a preaching-plan Sunday
(node server.js &) ; sleep 3
cd scripts/diary-ui
node -e "const j=require('../../node_modules/jsonwebtoken');const s=process.env.JWT_SECRET;console.log(JSON.stringify({clerk:j.sign({id:1,name:'Clerk',email:'c@t',role:'admin',sv:0},s,{expiresIn:'2h'}),sec:j.sign({id:2,name:'Choir Secretary',email:'s@t',role:'secretary',sv:0},s,{expiresIn:'2h'})}))" > tokens.json
mkdir -p shots && node ui.js               # W=390 for phone, DARK=1 for night mode
```

16 checks: the Clerk sees Add / Preaching plan and the two found dates; the month shows them; accepting
opens the form filled in; declining clears; list view; details; hiding a kind; the preaching upload
opens; a secretary sees the diary without Add or suggestions; Home's Coming up includes the diary.
