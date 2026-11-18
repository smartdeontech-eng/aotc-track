#!/usr/bin/env bash
# AOTC Track — one-off recovery, 9 Oct 2026.
#
# What happened: the first automatic backup on the blue line (01:55) copied
# data/ — which on a line is a SYMLINK to /opt/aotc-track/data — as a symlink,
# then wrote its database snapshot THROUGH that link: it deleted the live
# data/aotc.db and put the snapshot in its place. The running blue process
# still holds the real database open (Linux keeps a deleted file alive while a
# process has it open) and has kept writing to it, so nothing is lost yet. If
# blue stops before this runs, everything written since 01:55 is lost and the
# site falls back to the 01:55 snapshot.
#
#   sudo bash ~/aotc-staging/deploy/bluegreen/recover-2026-10-09.sh            # look only
#   sudo bash ~/aotc-staging/deploy/bluegreen/recover-2026-10-09.sh --apply    # recover
#
# --apply: freezes blue (a second or two), copies the real database and its
# WAL out of the process, stops blue, checks the copy, puts it back as
# data/aotc.db, and starts blue again. About 10 seconds of downtime. The
# snapshot that replaced it, the stale WAL and the broken 01:55 backup are kept
# in /root/aotc-recover-*/replaced/.
set -euo pipefail
DATA=/opt/aotc-track/data
UNIT=aotc-track@blue
PORT=$(sed -n 's/^PORT=//p' /etc/aotc-lines/blue.env)
MODE="${1:-check}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is not installed (apt install sqlite3)"; exit 1; }

PID=$(systemctl show -p MainPID --value "$UNIT")
[ "${PID:-0}" -gt 0 ] || { echo "STOPPED: $UNIT is not running, so there is no held database to recover. Do not start anything; ask Claude."; exit 1; }
# The snapshot's own open of the path also deleted the WAL that blue writes
# to (rehearsed 9 Oct: both come back "(deleted)"), so both are taken from
# the process, not from the folder.
FD=""; WFD=""
for f in /proc/$PID/fd/*; do
  t=$(readlink "$f" || true)
  [ "$t" = "$DATA/aotc.db (deleted)" ] && FD=$(basename "$f")
  [ "$t" = "$DATA/aotc.db-wal (deleted)" ] && WFD=$(basename "$f")
  [ "$t" = "$DATA/aotc.db-wal" ] && [ -z "$WFD" ] && WFD=$(basename "$f")
done

echo "── What is there"
echo "  blue pid $PID (port $PORT), live line: $(cat /opt/aotc-lines/live)"
if [ -z "$FD" ]; then
  echo "  blue does NOT hold a deleted aotc.db — the live file was not replaced. Nothing to recover."
  ls -la "$DATA"/aotc.db* 2>/dev/null
  exit 0
fi
echo "  the database blue is using:   /proc/$PID/fd/$FD  ($(stat -Lc %s /proc/$PID/fd/$FD) bytes, deleted from the folder)"
echo "  in the folder now (snapshot):  $DATA/aotc.db  ($(stat -c %s $DATA/aotc.db 2>/dev/null || echo none) bytes)"
echo "  its WAL (pending writes):      ${WFD:+/proc/$PID/fd/$WFD  ($(stat -Lc %s /proc/$PID/fd/$WFD) bytes; $(readlink /proc/$PID/fd/$WFD | grep -q deleted && echo deleted from the folder || echo in the folder))}${WFD:-none open}"
echo "  records in the snapshot:       $(sqlite3 -readonly "file:$DATA/aotc.db?immutable=1" 'SELECT COUNT(*) FROM records' 2>/dev/null || echo '?')"
BROKEN=$(find /opt/aotc-track/backups -maxdepth 2 -type l -name data -printf '%h\n' 2>/dev/null || true)
[ -n "$BROKEN" ] && echo "  backup folders whose data/ is a link to the live folder: $BROKEN"
[ -d "$DATA/json" ] && echo "  $DATA/json/ was written through the link too (harmless; will be moved aside)"
if [ "$MODE" != --apply ]; then
  echo; echo "Looks as expected. Run again with --apply to recover (about 10 seconds of downtime)."; exit 0
fi

R=/root/aotc-recover-$(date +%Y%m%d-%H%M%S); mkdir -p "$R/replaced"; chmod 700 "$R"
echo; echo "── Recovering into $R"
kill -STOP "$PID"
cp "/proc/$PID/fd/$FD" "$R/aotc.db"
[ -n "$WFD" ] && cp "/proc/$PID/fd/$WFD" "$R/aotc.db-wal"
# systemd sends SIGTERM then SIGCONT: node has no SIGTERM handler, so it ends
# at once, before it can answer anything that queued while it was frozen.
systemctl stop "$UNIT"
echo "  copied and blue stopped (site down from here)"
CHECK=$(cd "$R" && sqlite3 aotc.db 'PRAGMA integrity_check;')
if [ "$CHECK" != ok ]; then
  echo "  the copy fails its integrity check: $CHECK"
  echo "  Starting blue again on the 01:55 snapshot so the site is up; the copy is kept in $R. Tell Claude."
  systemctl start "$UNIT"; exit 1
fi
(cd "$R" && sqlite3 aotc.db 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null)
N=$(sqlite3 "$R/aotc.db" 'SELECT COUNT(*) FROM records')
echo "  copy is sound: $N records"
OWNER=$(stat -c %U:%G "$DATA/aotc.db"); MODEBITS=$(stat -c %a "$DATA/aotc.db")
for f in aotc.db aotc.db-wal aotc.db-shm; do [ -e "$DATA/$f" ] && mv "$DATA/$f" "$R/replaced/"; done
[ -d "$DATA/json" ] && mv "$DATA/json" "$R/replaced/json-written-into-data"
for b in $BROKEN; do mv "$b" "$R/replaced/"; done
install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m "$MODEBITS" "$R/aotc.db" "$DATA/aotc.db"
systemctl start "$UNIT"
for i in $(seq 1 30); do
  H=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/healthz" 2>/dev/null || true)
  case "$H" in *'"ok":true'*) break ;; esac; sleep 1
done
echo "  blue: $H"
echo "  records now: $(sqlite3 -readonly "$DATA/aotc.db" 'SELECT COUNT(*) FROM records')"
echo; echo "Done. Next: push.sh (it carries the fixed backup) before 01:55 tomorrow, when blue's next automatic backup would run."
