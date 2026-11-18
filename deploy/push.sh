#!/usr/bin/env bash
#
# AOTC Track — deploy to the VPS.
#
# Run this from Terminal on the Mac, from anywhere:
#     ~/Library/CloudStorage/OneDrive-Personal/Projects/Software/"AOTC Reports Software"/aotc-track/deploy/push.sh
#
# It does exactly what deploy/DEPLOYMENT.md describes, in order, and stops at
# the first thing that fails:
#   0. snapshot the live app on the server, so there is a way back
#   1. push this folder to the deploy user's staging directory
#   2. promote staging into /opt/aotc-track and restart the service
#   3. ask the LIVE server to prove the new code is being served
#
# It never touches data/, .env, minutes/, generated/, backups/ or uploads on
# the server — those are the live records and they stay where they are.
set -euo pipefail

# The server is addressed by NAME — an alias in ~/.ssh/config on the Mac:
#
#     Host deontech-vps
#         HostName 172.93.52.195
#         User deploy
#
# The IP lives in that one place, so if the server ever moves (e.g. to
# Hetzner) only ~/.ssh/config changes, not this script. A public DNS name such
# as track.pcg-aotc.com is NOT used: it has not resolved for SSH from the Mac.
# One-off override:  AOTC_HOST=deploy@track.pcg-aotc.com push.sh  (IPv6-only
# networks, e.g. a phone hotspot)
# Every release has its own number, noted in changes.json (About page, update bar).
( cd "$(dirname "$0")/.." && node scripts/check-version.js ) || { echo "Bump the version in package.json and add a line to changes.json first."; exit 1; }

SSH_ALIAS="deontech-vps"
if [[ -n "${AOTC_HOST:-}" ]]; then
  HOST="$AOTC_HOST"
elif [[ "$(ssh -G "$SSH_ALIAS" 2>/dev/null | awk '/^hostname /{print $2}')" != "$SSH_ALIAS" ]]; then
  HOST="$SSH_ALIAS"
else
  echo "SSH alias '$SSH_ALIAS' is not set up in ~/.ssh/config yet. Add it with:"
  echo
  echo "  printf '\\nHost $SSH_ALIAS\\n    HostName 172.93.52.195\\n    User deploy\\n' >> ~/.ssh/config"
  echo
  exit 1
fi
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"
echo "Deploying from: $APP_DIR"
echo "To:             $HOST"
echo
echo "── Pre-flight: global script clashes ────────────────────────────────"
if ! node scripts/test-global-clashes.js; then
  echo
  echo "A page script clashes with app.js. In the browser that is a SyntaxError"
  echo "and the whole page script never runs - a silent dead page. Fix it first."
  exit 1
fi
echo
read -r -p "Continue? [y/N] " reply
[[ "$reply" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }

echo
# Blue-green (Oct 2026, deploy/bluegreen/): once provisioned, the server runs
# two lines and the release goes to the idle one. Before that, the single
# service is updated in place as it always was.
LINE_NOW=$(ssh "$HOST" 'cat /opt/aotc-lines/live 2>/dev/null || echo single')
if [[ "$LINE_NOW" == blue || "$LINE_NOW" == green ]]; then
  echo "── 0/3  Blue-green: live line is $LINE_NOW — the release goes to the other one,"
  echo "        and $LINE_NOW keeps the current release for a rollback."
else
echo "── 0/3  Rollback snapshot on the server ─────────────────────────────"
  ssh -t "$HOST" "sudo tar czf /opt/aotc-track-\$(date +%Y%m%d-%H%M).tar.gz \
    --exclude=node_modules --exclude=data --exclude=backups -C /opt aotc-track && \
    ls -lh /opt/*.tar.gz | tail -3"
fi
echo
echo "── 1/3  Push to staging ─────────────────────────────────────────────"
rsync -av --delete \
  --exclude node_modules --exclude .env --exclude data --exclude backups \
  --exclude minutes --exclude generated --exclude 'public/uploads' \
  --exclude marriage-files --exclude document-files --exclude 'LAYOUT-RESEARCH-*.md' --exclude layout-preview.html \
  --exclude '*.zip' --exclude '.DS_Store' \
  --exclude '.git' --exclude '_preview' --exclude '_to_delete' --exclude '_pre-headings-backup' \
  ./ "$HOST:aotc-staging/"

echo
if [[ "$LINE_NOW" == blue || "$LINE_NOW" == green ]]; then
  echo "── 2/3  Release to the idle line, check it, switch ─────────────────"
  ssh -t "$HOST" "sudo bash ~/aotc-staging/deploy/bluegreen/release.sh ~/aotc-staging"
else
echo "── 2/3  Promote and restart ─────────────────────────────────────────"
  ssh -t "$HOST" "sudo rsync -a --chown=aotc:aotc \
    --exclude data --exclude .env --exclude minutes --exclude generated --exclude document-files \
    ~/aotc-staging/ /opt/aotc-track/ && sudo systemctl restart aotc-track && \
    echo -n '  Opus 5.5 default:  ' && sudo grep -c \"claude-opus-5-5\" /opt/aotc-track/utils/aiAssist.js && \
    echo -n '  .env model line:   ' && (sudo grep '^ANTHROPIC_MODEL' /opt/aotc-track/.env || echo 'none - the default (Opus 5.5) is used')"
fi
echo
echo "── 3/3  Verify the live server is serving the new code ──────────────"
echo "   401 on the API lines means the route exists and wants a login (correct)."
echo "   404 means the promote did NOT take. Counts should be above zero."
echo
# -t so the sudo checks below can ask for the password. The wait loop: these
# checks used to run the instant the service restarted, before Node was
# listening, and printed a wall of 000s on a deploy that had in fact worked.
ssh -t "$HOST" "
  L=\$(cat /opt/aotc-lines/live 2>/dev/null)
  if [ -n \"\$L\" ]; then P=\$(sudo sed -n 's/^PORT=//p' /etc/aotc-lines/\$L.env); [ -n \"\$P\" ] || P=\$(grep -o '127.0.0.1:[0-9]*' /etc/apache2/aotc-live.conf | tail -1 | cut -d: -f2); C=/opt/aotc-lines/\$L; echo \"  live line: \$L (port \$P)\"; else P=3000; C=/opt/aotc-track; fi
  for i in \$(seq 1 30); do
    [ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:\$P/login.html)\" != 000 ] && break; sleep 1
  done
  echo -n '  shared-goal API:   '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/setup/goals/1/rollup
  echo -n '  overview API:      '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/attendance/overview
  echo -n '  shared-goal UI:    '; curl -s http://127.0.0.1:\$P/js/page-goals.js     | grep -c openShared
  echo -n '  group chart:       '; curl -s http://127.0.0.1:\$P/js/page-dashboard.js | grep -c mtgGroupSel
  echo -n '  role names + nav:  '; curl -s http://127.0.0.1:\$P/js/app.js            | grep -c ROLE_LABELS
  echo -n '  badge rename:      '; curl -s http://127.0.0.1:\$P/css/style.css        | grep -c badge-attention
  echo -n '  mobile scroll fix: '; curl -s http://127.0.0.1:\$P/css/style.css | grep -c 'body { overflow-x: hidden; }'
  echo -n '  attendance -> KPI: '; curl -s http://127.0.0.1:\$P/js/page-entry.js      | grep -c syncDerivedKpis
  echo -n '  combined Sundays:  '; curl -s http://127.0.0.1:\$P/js/page-attendance.js | grep -c toggleSvcDetail
  echo -n '  tithes field:      '; curl -s http://127.0.0.1:\$P/js/page-entry.js       | grep -c \"'tithes'\"
  echo -n '  CLN-02 breakdown:  '; curl -s http://127.0.0.1:\$P/js/page-entry.js       | grep -c groupBreakdown
  echo -n '  weekly finance API:'; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/finance-weekly/summary
  echo -n '  weekly finance page:'; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/finance-weekly.html
  echo -n '  weekly finance nav: '; curl -s http://127.0.0.1:\$P/js/app.js               | grep -c 'finance-weekly.html'
  echo -n '  receipts/payments:  '; curl -s http://127.0.0.1:\$P/js/page-entry.js        | grep -c FIN_RECEIPTS
  echo -n '  ShareHub API:       '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/documents
  echo -n '  ShareHub upload perm:'; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/documents/categories
  echo -n '  weekly totals API:  '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/finance-weekly/totals
  echo -n '  per-member card:    '; curl -s http://127.0.0.1:\$P/js/page-finance-weekly.js | grep -c perMemberCard
  echo -n '  typed-or-computed:  '; curl -s http://127.0.0.1:\$P/js/page-finance-weekly.js | grep -c openPerMemberEntry
  echo -n '  tidy check:         '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c tidyGate
  echo -n '  hymn picker:        '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c hymnPhrase
  echo -n '  letter/prayer check:'; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c corrTidyBadge
  echo -n '  handover asks once: '; curl -s http://127.0.0.1:\$P/js/page-session-composition.js | grep -c askIfLeft
  echo -n '  inbox page:         '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/correspondence.html
  echo -n '  inbox API:          '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/minutes/correspondence/inbox
  echo -n '  camera tray:        '; curl -s http://127.0.0.1:\$P/js/page-correspondence.js | grep -c trayAdd
  echo -n '  committee minutes:  '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/meetings/1/write
  echo -n '  write-minutes page: '; curl -s http://127.0.0.1:\$P/js/page-meetings.js | grep -c 'meeting-minutes.html'
  echo -n '  submission board:   '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/entry/submission-board
  echo -n '  board card:         '; curl -s http://127.0.0.1:\$P/js/page-reports.js | grep -c loadBoard
  echo -n '  correspondence perm:'; curl -s http://127.0.0.1:\$P/js/page-users.js | grep -c 'correspondence.intake'
  echo -n '  board reopen API:   '; curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:\$P/api/entry/reopen-quarter
  echo -n '  green done badge:   '; curl -s http://127.0.0.1:\$P/css/style.css | grep -c 'badge-done { background: #E3F2EC'
  echo -n '  poster API:         '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/entry/submission-board/poster.svg
  echo -n '  download button:    '; curl -s http://127.0.0.1:\$P/js/page-reports.js | grep -c downloadBoardImage
  echo -n '  bright chips:       '; curl -s http://127.0.0.1:\$P/css/style.css | grep -c 'badge-bright-ok'
  echo -n '  server-side derive: '; sudo grep -c 'derivedKpiValue' \$C/utils/reportData.js
  echo -n '  board skips archived: '; sudo grep -c 'const live = e => e.active' \$C/routes/entry.js
  echo -n '  permission split:   '; sudo grep -c \"'setup.structure'\" \$C/middleware/auth.js
  echo -n '  restore archived:   '; curl -s http://127.0.0.1:\$P/js/page-groups.js | grep -c loadArchived
  echo -n '  who can do what:    '; curl -s http://127.0.0.1:\$P/users.html | grep -c whoCard
  echo -n '  goal proposals:     '; curl -s http://127.0.0.1:\$P/js/page-goals.js | grep -c 'Propose change'
  echo -n '  migration ran (1):  '; sudo sqlite3 -readonly \$C/data/aotc.db \"SELECT COUNT(*) FROM records WHERE collection='migrations' AND doc LIKE '%perm-split-2026-10%'\" 2>/dev/null || sudo grep -c 'perm-split-2026-10' \$C/data/migrations.json
  echo -n '  SQLite records:     '; sudo sqlite3 -readonly \$C/data/aotc.db 'SELECT COUNT(*) FROM records' 2>/dev/null || echo 'no aotc.db yet'
  echo -n '  JSON read in (1):   '; sudo test -f \$C/data/json-before-sqlite/IMPORTED.txt && echo 1 || echo 0
  echo -n '  account on/off:     '; curl -s http://127.0.0.1:\$P/users.html | grep -c acct-switch
  echo -n '  long-minutes fix:   '; sudo grep -c 'salvageMatters' \$C/utils/aiAssist.js
  echo -n '  tidy-up safe:       '; sudo grep -c 'have NOT been changed' \$C/utils/aiAssist.js
  echo -n '  decisions list:     '; curl -s http://127.0.0.1:\$P/session-matters.html | grep -c decCard
  echo -n '  carry to MA:        '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c carryToMatters
  echo -n '  chairman signs:     '; sudo grep -c \"title: 'Chairman'\" \$C/routes/minutes.js
  echo -n '  tidy-up thinks:     '; sudo grep -c 'budget_tokens' \$C/utils/aiAssist.js
  echo -n '  notes kept:         '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c 'My notes before tidy-up'
  echo -n '  PDF viewer (close): '; curl -s http://127.0.0.1:\$P/js/app.js | grep -c 'openDocViewer'
  echo -n '  agenda as image:    '; curl -s http://127.0.0.1:\$P/session-meetings.html | grep -c 'Agenda (image)'
  echo -n '  proofreading (401): '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/minutes/proofreads/trend
  echo -n '  review screen:      '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c 'Draft the change'
  echo -n '  back to proofread:  '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c 'Back to proofreading'
  echo -n '  bullets+headings:   '; sudo grep -c 'subjectFrom' \$C/utils/proofread.js
  echo -n '  merge into mine:    '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c 'Merge into my wording'
  echo -n '  shows what changed: '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c 'function prWordDiff'
  echo -n '  open where it comes:'; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c 'function prSource('
  echo -n '  tidy no blank lines:'; sudo grep -c 'function tightParagraphs' \$C/utils/aiAssist.js
  echo -n '  long item splits:   '; sudo grep -c 'function splitNotes' \$C/utils/aiAssist.js
  echo -n '  why? on proofread:  '; sudo grep -c 'function carryRule' \$C/routes/minutes.js
  echo -n '  letter action ask:  '; curl -s http://127.0.0.1:\$P/js/page-minutes.js | grep -c 'function actionGate'
  echo -n '  new Home page:      '; curl -s http://127.0.0.1:\$P/css/home.css | grep -c 'hm-todo li'
  echo -n '  Oct 2026 look:      '; curl -s http://127.0.0.1:\$P/css/style.css | grep -c 'Oct 2026 look'
  echo -n '  Sunday grid:        '; curl -s http://127.0.0.1:\$P/attendance.html | grep -c 'sv-daybar{'
  echo -n '  login polish:       '; curl -s http://127.0.0.1:\$P/login.html | grep -c 'login-aside'
  echo -n '  loading shapes:     '; curl -s http://127.0.0.1:\$P/js/app.js | grep -c 'SKEL_SHAPES'
  echo -n '  Recent Sundays fold:'; curl -s http://127.0.0.1:\$P/js/page-attendance.js | grep -c 'listDates'
  echo -n '  attendance details: '; sudo grep -c 'optional .details. line' \$C/lib/deontech-minutes/docx.js
  echo -n '  no-report sentence: '; sudo grep -c 'No report was presented' \$C/utils/sessionMinutes.js
  echo -n '  points justified:   '; sudo grep -c 'justifyPoints: true' \$C/utils/minutesStyle.js
  echo -n '  grace in closure:   '; sudo grep -c 'function closingRiteSentence' \$C/utils/sessionMinutes.js
  echo -n '  blue-green ready:   '; sudo grep -c 'AOTC_LINE' \$C/server.js
  echo -n '  corr export API:    '; curl -s -o /dev/null -w '%{http_code}\n' \"http://127.0.0.1:\$P/api/minutes/correspondence/export?scope=register\"
  echo -n '  corr export button: '; curl -s http://127.0.0.1:\$P/js/app.js | grep -c 'function openCorrExport'
  echo -n '  title carried over: '; sudo grep -c 'function retitleText' \$C/utils/sessionMinutes.js
  echo -n '  users search+cards: '; curl -s http://127.0.0.1:\$P/users.html | grep -c 'id=.uSearch.'
  echo -n '  phone menu grouped: '; curl -s http://127.0.0.1:\$P/js/app.js | grep -c 'more-group'
  echo -n '  menu close button: '; curl -s http://127.0.0.1:\$P/js/app.js | grep -c 'moreCloseBtn'
  echo -n '  users tabs:         '; curl -s http://127.0.0.1:\$P/users.html | grep -c 'data-utab=.logins.'
  echo -n '  unlock API:         '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/unlocks
  echo -n '  unlock page:        '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/unlocks.html
  echo -n '  unlock nav:         '; curl -s http://127.0.0.1:\$P/js/app.js | grep -c 'unlocks.html'
  echo -n '  ask-to-reopen btn:  '; curl -s http://127.0.0.1:\$P/js/app.js | grep -c reopenButtonHtml
  echo -n '  five lock kinds:    '; sudo grep -c \"^  '\" \$C/utils/unlockKinds.js
  echo -n '  self-correct window:'; curl -s http://127.0.0.1:\$P/js/page-meetings.js | grep -c 'meeting-attendance'
  echo -n '  session presets:    '; sudo grep -c 'deputy_senior_presbyter' \$C/middleware/auth.js
  echo -n '  elections API (401):'; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/api/elections
  echo -n '  elections page:     '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/elections.html
  echo -n '  voting link (200):  '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:\$P/v/check
  echo -n '  live stream unbuffered:'; grep -c 'api/vote/stream.*flushpackets=on' /etc/apache2/aotc-live.conf 2>/dev/null || sudo grep -c 'api/vote/stream.*flushpackets=on' /etc/apache2/aotc-live.conf
"

echo
echo "Expected: 401 on the API lines, 200 on the weekly finance page, counts above zero — with ONE exception:"
echo "'mobile scroll fix' must print 0. It checks that the bad CSS rule is GONE,"
echo "so zero is the pass there and anything above zero is the failure."
echo
echo "If anything else printed 404 or 0, the promote did not take —"
echo "do not go looking at the app until it passes."
