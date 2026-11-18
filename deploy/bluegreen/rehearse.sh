#!/usr/bin/env bash
# AOTC Track — rehearse the blue-green scripts off the server.
#
#   bash deploy/bluegreen/rehearse.sh
#
# Builds a pretend server under $HOME/aotc-bg-rehearsal: /opt/aotc-track with a
# COPY of data/, an Apache site file, and stand-ins for systemctl, apache2ctl
# and journalctl that run the real app (real server.js, real node_modules) as
# plain processes. A small proxy plays Apache. Then it runs provision → release
# → rollback → a broken release → undo, with a request every 0.2 s through the
# proxy the whole time, and counts any that failed. The live data/ is only
# read (copied); .env is NOT copied, so nothing can send a message.
set -uo pipefail
APP="$(cd "$(dirname "$0")/../.." && pwd)"
R="${REHEARSAL_DIR:-$HOME/aotc-bg-rehearsal}"
rm -rf "$R"; mkdir -p "$R"/{opt,etc/apache2/sites-available,etc/apache2/sites-enabled,etc/aotc-lines,units,bin,run,log,backups,staging}
export AOTC_REHEARSAL=1 AOTC_BASE="$R/opt" AOTC_CONF_DIR="$R/etc/aotc-lines" AOTC_APACHE_DIR="$R/etc/apache2" \
  AOTC_UNIT_DIR="$R/units" AOTC_RELEASE_BACKUPS="$R/backups" AOTC_LEGACY_PORT=4300 AOTC_BLUE_PORT=4301 \
  AOTC_GREEN_PORT=4302 AOTC_DRAIN_SECONDS=2 RH="$R" RH_APP="$APP"
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "  PASS $2"; else FAIL=$((FAIL+1)); echo "  FAIL $2"; fi; }
H="$R/opt/aotc-track"

# ---- the pretend server ----------------------------------------------------
rsync -a --exclude data --exclude .env --exclude node_modules --exclude .git --exclude minutes \
  --exclude generated --exclude backups --exclude marriage-files --exclude document-files --exclude 'public/uploads' "$APP/" "$H/"
mkdir -p "$H/data" "$H/minutes" "$H/generated" "$H/backups" "$H/public/uploads"
cp "$APP"/data/*.json "$H/data/"
ln -s "$APP/node_modules" "$H/node_modules"
printf 'JWT_SECRET=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$H/.env"
cat > "$R/etc/apache2/sites-available/aotc-track-le-ssl.conf" <<CONF
<VirtualHost *:443>
    ServerName track.pcg-aotc.com
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:4300/
    ProxyPassReverse / http://127.0.0.1:4300/
</VirtualHost>
CONF
ln -s "$R/etc/apache2/sites-available/aotc-track-le-ssl.conf" "$R/etc/apache2/sites-enabled/aotc-track-le-ssl.conf"

# ---- stand-ins ------------------------------------------------------------
cat > "$R/bin/systemctl" <<'SH'
#!/usr/bin/env bash
# systemctl stand-in: services are plain node processes with pid files.
cmd="$1"; shift
unitname() { echo "${1%.service}"; }
pidf() { echo "$RH/run/$(unitname "$1").pid"; }
alive() { [ -f "$(pidf "$1")" ] && kill -0 "$(cat "$(pidf "$1")")" 2>/dev/null; }
case "$cmd" in
  is-active) alive "$1" && echo active || { echo inactive; exit 3; } ;;
  start|restart)
    u=$(unitname "$1"); alive "$1" && [ "$cmd" = start ] && exit 0
    alive "$1" && kill "$(cat "$(pidf "$1")")" && sleep 1
    if [ "$u" = aotc-track ]; then dir="$AOTC_BASE/aotc-track"; envs="PORT=$AOTC_LEGACY_PORT NODE_ENV=production"
    else l="${u#aotc-track@}"; dir="$AOTC_BASE/aotc-lines/$l"; envs="NODE_ENV=production $(tr '\n' ' ' < "$AOTC_CONF_DIR/$l.env")"; fi
    ( cd "$dir" || exit 1; setsid env TZ=Africa/Accra $envs nohup node server.js >> "$RH/log/$u.log" 2>&1 & echo $! > "$(pidf "$1")" ) ;;
  stop) alive "$1" && { kill "$(cat "$(pidf "$1")")"; for i in $(seq 1 50); do alive "$1" || break; sleep 0.3; done; alive "$1" && kill -9 "$(cat "$(pidf "$1")")"; }; rm -f "$(pidf "$1")" ;;
  show)
    p=""; while [ $# -gt 0 ]; do [ "$1" = -p ] && p="$2"; shift; done
    case "$p" in User|Group) whoami ;; ExecStart) echo "{ path=$(command -v node) ; argv[]=$(command -v node) server.js ; }" ;;
      WorkingDirectory) echo "$AOTC_BASE/aotc-track" ;; Environment) echo "NODE_ENV=production TZ=Africa/Accra" ;; esac ;;
  reload) echo "$(date +%T) reload $*" >> "$RH/log/apache.log" ;;
  enable|disable|daemon-reload) : ;;
esac
SH
cat > "$R/bin/apache2ctl" <<'SH'
#!/usr/bin/env bash
# configtest stand-in: every Include must exist and say ProxyPass; REHEARSE_BAD_APACHE=1 makes it refuse.
[ -n "${REHEARSE_BAD_APACHE:-}" ] && { echo "Syntax error (rehearsal)"; exit 1; }
for f in "$AOTC_APACHE_DIR"/sites-enabled/*; do
  grep -E '^[[:space:]]*Include ' "$f" | awk '{print $2}' | while read -r inc; do grep -q '^ProxyPass / ' "$inc" || { echo "bad include $inc"; exit 1; }; done || exit 1
done
echo "Syntax OK"
SH
printf '#!/usr/bin/env bash\nu=""; while [ $# -gt 0 ]; do [ "$1" = -u ] && u="$2"; shift; done; tail -n 20 "$RH/log/${u%%.service}.log" 2>/dev/null\n' > "$R/bin/journalctl"
printf '#!/usr/bin/env bash\n:\n' > "$R/bin/chown"
chmod +x "$R"/bin/*
export PATH="$R/bin:$PATH"

# Apache stand-in: a proxy on 4399 that follows the site file (and the Include).
cat > "$R/proxy.js" <<'JS'
const http = require('http'), fs = require('fs');
const site = process.env.AOTC_APACHE_DIR + '/sites-enabled/aotc-track-le-ssl.conf';
function target() {
  const s = fs.readFileSync(site, 'utf8');
  const inc = s.match(/^\s*Include\s+(\S+)/m);
  const src = inc ? fs.readFileSync(inc[1], 'utf8') : s;
  return Number(src.match(/ProxyPass \/ http:\/\/127\.0\.0\.1:(\d+)/)[1]);
}
// Like Apache, a changed file takes effect only on reload (the systemctl stand-in logs reloads).
let port = target(), seen = 0;
setInterval(() => { try { const m = fs.statSync(process.env.RH + '/log/apache.log').mtimeMs; if (m !== seen) { seen = m; port = target(); } } catch (e) {} }, 100);
http.createServer((req, res) => {
  const p = http.request({ port, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', () => { res.writeHead(502); res.end('down'); });
  req.pipe(p);
}).listen(4399);
JS
node "$R/proxy.js" & PROXY=$!
trap 'kill $PROXY $LOAD 2>/dev/null; for u in aotc-track aotc-track@blue aotc-track@green; do systemctl stop $u; done' EXIT

echo "── Old single service"
systemctl start aotc-track
for i in $(seq 1 30); do curl -fs http://127.0.0.1:4300/api/healthz >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:4399/api/healthz | grep -q '"ok":true'; ok $? "the site answers through the proxy on the old service"
# The first start of the SQLite code reads the JSON files in (Oct 2026).
[ -f "$H/data/aotc.db" ] && [ -f "$H/data/json-before-sqlite/users.json" ] && [ ! -f "$H/data/users.json" ]; ok $? "first start: JSON read into data/aotc.db, files moved to json-before-sqlite/"
want=$(cd "$APP" && node -e "const fs=require('fs');let n=0;for(const f of fs.readdirSync('data'))if(f.endsWith('.json')&&f!=='settings.json')n+=JSON.parse(fs.readFileSync('data/'+f,'utf8')||'[]').length;console.log(n)")
got=$(cd "$APP" && NODE_ENV=production DB_PATH="$H/data/aotc.db" AOTC_DATA_DIR="$H/data" node -e "const db=require('./utils/db');console.log(db.collections().reduce((a,c)=>a+c.n,0))")
# Per collection: at least as many rows as the JSON had (the app adds a few of its own at start-up).
short=$(cd "$APP" && NODE_ENV=production DB_PATH="$H/data/aotc.db" AOTC_DATA_DIR="$H/data" node -e "
const fs=require('fs'),db=require('./utils/db');const have={};db.collections().forEach(c=>have[c.collection]=c.n);
const bad=[];for(const f of fs.readdirSync('data'))if(f.endsWith('.json')&&f!=='settings.json'){const c=f.slice(0,-5),n=JSON.parse(fs.readFileSync('data/'+f,'utf8')||'[]').length;if((have[c]||0)<n)bad.push(c+' '+(have[c]||0)+'/'+n)}console.log(bad.join(', '))")
[ -z "$short" ]; ok $? "every record is in the database ($got rows from $want JSON records)${short:+ — short: $short}"

# Requests every 0.2 s through the "site" for the whole rehearsal.
( while true; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:4399/login.html); echo "$(date +%T) $c" >> "$R/log/load.log"; sleep 0.2; done ) & LOAD=$!

S="$APP/deploy/bluegreen"
echo; echo "── provision (look only)"
out=$(bash "$S/provision.sh" 2>&1); echo "$out" | sed 's/^/    /' | tail -8
echo "$out" | grep -q "All checks pass"; ok $? "checks pass and nothing changed"
[ ! -e "$R/opt/aotc-lines/live" ]; ok $? "no live line recorded yet"

echo; echo "── provision with a refusing Apache (must put everything back)"
out=$(REHEARSE_BAD_APACHE=1 bash "$S/provision.sh" --apply 2>&1); echo "$out" | tail -3 | sed 's/^/    /'
grep -q "127.0.0.1:4300" "$R/etc/apache2/sites-available/aotc-track-le-ssl.conf"; ok $? "site file is back on the old port"
[ "$(systemctl is-active aotc-track)" = active ]; ok $? "old service still running"
[ "$(systemctl is-active aotc-track@blue)" != active ]; ok $? "blue was stopped again"
rm -rf "$R/opt/aotc-lines" "$R/etc/aotc-lines"/* "$R/etc/apache2/sites-available/"*.pre-bluegreen

echo; echo "── provision --apply"
# Under a terminal, as on the server (ssh -t): bash then resets LINES/COLUMNS
# after every command, which is what broke the first real run on 8 Oct.
if command -v script >/dev/null; then out=$(script -qec "bash '$S/provision.sh' --apply" /dev/null 2>&1)
else out=$(bash "$S/provision.sh" --apply 2>&1); fi
echo "$out" | sed 's/^/    /' | tail -12
[ "$(cat "$R/opt/aotc-lines/live" 2>/dev/null)" = blue ]; ok $? "live line is blue"
grep -q "^    Include $R/etc/apache2/aotc-live.conf" "$R/etc/apache2/sites-available/aotc-track-le-ssl.conf" && ! grep -q 4300 "$R/etc/apache2/sites-available/aotc-track-le-ssl.conf"; ok $? "vhost now Includes aotc-live.conf, old port gone, indentation kept"
grep -q ProxyPreserveHost "$R/etc/apache2/sites-available/aotc-track-le-ssl.conf"; ok $? "the vhost's other lines are untouched"
[ "$(systemctl is-active aotc-track)" != active ]; ok $? "old service stopped"
curl -fs http://127.0.0.1:4399/api/healthz | grep -q '"line":"blue"'; ok $? "the site is served by blue"
for x in data .env minutes node_modules public/uploads; do [ -L "$R/opt/aotc-lines/blue/$x" ] || { ok 1 "blue/$x is a link"; }; done; ok 0 "blue reaches the records through links"
sleep 16
grep -q "\[blue\] is the live line" "$R/log/aotc-track@blue.log"; ok $? "blue started the reminders/backups only once it was live"
grep -q "not the live line yet" "$R/log/aotc-track@blue.log"; ok $? "…and had waited while the old service was live"

echo; echo "── a backup taken on a line (9 Oct: it used to write through the data/ link over the live database)"
ino=$(stat -c %i "$H/data/aotc.db")
(cd "$R/opt/aotc-lines/blue" && NODE_ENV=production node -e "require('./utils/backup').runBackup()" >/dev/null 2>&1)
b=$(ls -dt "$H"/backups/backup-* | head -1)
[ -d "$b/data" ] && [ ! -L "$b/data" ] && [ -f "$b/data/aotc.db" ] && [ -d "$b/data/json" ]; ok $? "the backup holds a real data/ folder with the snapshot and the JSON copy"
[ "$(stat -c %i "$H/data/aotc.db")" = "$ino" ] && [ ! -d "$H/data/json" ]; ok $? "the live database file is the same file afterwards, and nothing was written into data/"
curl -fs http://127.0.0.1:4399/api/healthz | grep -q '"ok":true'; ok $? "the site still answers"

echo; echo "── release R1 → green"
rsync -a --exclude data --exclude node_modules --exclude .git --exclude .env "$APP/" "$R/staging/"
echo "release-R1" > "$R/staging/public/release-marker.txt"
echo "custom" > "$R/opt/aotc-lines/blue/public/img/logo-custom-123.png"
out=$(bash "$S/release.sh" "$R/staging" 2>&1); echo "$out" | sed 's/^/    /' | tail -6
[ "$(cat "$R/opt/aotc-lines/live")" = green ]; ok $? "live line is green"
[ "$(curl -fs http://127.0.0.1:4399/release-marker.txt)" = release-R1 ]; ok $? "the site serves release R1"
[ "$(systemctl is-active aotc-track@blue)" != active ]; ok $? "blue stopped after the switch (one writer)"
[ -f "$R/opt/aotc-lines/green/public/img/logo-custom-123.png" ]; ok $? "an uploaded logo was carried to the new line"
ls "$R/backups"/data-before-green-*.tar.gz >/dev/null 2>&1; ok $? "records copied before the new code ran"
[ -L "$R/opt/aotc-lines/green/data" ] && [ -f "$R/opt/aotc-track/data/aotc.db" ] && [ -f "$R/opt/aotc-track/data/json-before-sqlite/users.json" ]; ok $? "the records were not touched by rsync --delete"

echo; echo "── rollback: switch.sh blue"
out=$(bash "$R/opt/aotc-lines/switch.sh" blue 2>&1); echo "$out" | sed 's/^/    /' | tail -3
[ "$(cat "$R/opt/aotc-lines/live")" = blue ]; ok $? "live line is blue again"
[ "$(curl -s http://127.0.0.1:4399/release-marker.txt)" != release-R1 ]; ok $? "the site serves the previous release"
[ "$(systemctl is-active aotc-track@green)" != active ]; ok $? "green stopped"

echo; echo "── a broken release must never go live"
rm -rf "$R/staging"; rsync -a --exclude data --exclude node_modules --exclude .git --exclude .env "$APP/" "$R/staging/"
echo "this is not javascript (" >> "$R/staging/server.js"
out=$(bash "$S/release.sh" "$R/staging" 2>&1); echo "$out" | tail -2 | sed 's/^/    /'
echo "$out" | grep -q "never became healthy"; ok $? "release refused"
[ "$(cat "$R/opt/aotc-lines/live")" = blue ]; ok $? "the site stayed on blue"
curl -fs http://127.0.0.1:4399/api/healthz | grep -q '"line":"blue"'; ok $? "and is still answering"

echo; echo "── undo: back to the single service"
out=$(bash "$S/provision.sh" --undo 2>&1); echo "$out" | sed 's/^/    /' | tail -3
grep -q "127.0.0.1:4300" "$R/etc/apache2/sites-available/aotc-track-le-ssl.conf"; ok $? "site file restored"
curl -fs http://127.0.0.1:4399/api/healthz | grep -q '"line":null'; ok $? "the site is on the old service"

kill $LOAD 2>/dev/null; sleep 0.5
total=$(wc -l < "$R/log/load.log"); bad=$(grep -vc ' 200$' "$R/log/load.log")
echo; echo "── $total requests through the site during all of this; $bad not 200"
[ "$bad" = 0 ]; ok $? "no request failed (no downtime)"
grep -v ' 200$' "$R/log/load.log" | head -5
echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
