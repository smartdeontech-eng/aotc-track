#!/usr/bin/env bash
# AOTC Track — put a release on the line that is NOT live, check it on its own
# port, then switch the site to it. Run by deploy/push.sh:
#
#   sudo bash ~/aotc-staging/deploy/bluegreen/release.sh /home/deploy/aotc-staging
#
# The previous release stays on the other line, untouched, so rolling back is
#   sudo bash /opt/aotc-lines/switch.sh <the other colour>
# with no rebuild and no restore.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"
STAGING="$(cd "${1:?usage: release.sh <staging folder>}" && pwd)"
[ "$(id -u)" -eq 0 ] || [ -n "${AOTC_REHEARSAL:-}" ] || die "run with sudo"
[ -f "$STAGING/server.js" ] || die "$STAGING does not look like AOTC Track (no server.js)."
LIVE=$(live_line)
[ -n "$LIVE" ] || die "no live line recorded in $LINES_DIR/live. Run provision.sh first."
IDLE=$(other_of "$LIVE"); PORT=$(port_of "$IDLE")
OWNER=$(stat -c '%U' "$HOME_DIR/data")
say "live: $LIVE — releasing to $IDLE (port $PORT)"

# The scripts themselves come from this release, so a fix to them takes effect
# on the next run without anyone copying them by hand.
install -m 755 "$HERE/common.sh" "$HERE/switch.sh" "$HERE/release.sh" "$LINES_DIR/"

# A copy of the records before the new code first runs: it may carry a
# one-time migration (as permSplit2026 did). Photos are left out for size; the
# last 10 copies are kept.
mkdir -p "$BACKUPS"; chmod 700 "$BACKUPS"
SNAP="$BACKUPS/data-before-$IDLE-$(date +%Y%m%d-%H%M%S).tar.gz"
tar czf "$SNAP" --exclude='member-photos' -C "$HOME_DIR" data
ls -1t "$BACKUPS"/data-before-*.tar.gz | tail -n +11 | xargs -r rm -f
say "records copied: $SNAP ($(du -h "$SNAP" | cut -f1))"

# The idle line is stopped (switch.sh stopped it); the new code goes in.
systemctl stop "aotc-track@$IDLE" 2>/dev/null || true
EXCL=(); for item in "${SHARED[@]}"; do EXCL+=(--exclude "/$item"); done
rsync -a --delete "${EXCL[@]}" --exclude '/public/img/logo-custom-*' --exclude '.DS_Store' "$STAGING/" "$LINES_DIR/$IDLE/"
# A logo uploaded on Settings lives in public/img on the line that was live
# when it was uploaded. Carry those across so the new line shows it too.
rsync -a --ignore-existing --include 'logo-custom-*' --exclude '*' "$LINES_DIR/$LIVE/public/img/" "$LINES_DIR/$IDLE/public/img/" 2>/dev/null || true
link_shared "$LINES_DIR/$IDLE"
chown -R "$OWNER:$OWNER" "$LINES_DIR/$IDLE"

systemctl start "aotc-track@$IDLE"
H=$(wait_healthy "$PORT" 40) || {
  journalctl -u "aotc-track@$IDLE" -n 40 --no-pager 2>/dev/null || true
  systemctl stop "aotc-track@$IDLE" || true
  die "$IDLE never became healthy. The site is untouched and still on $LIVE."
}
say "$IDLE healthy on its own port: $H"
exec bash "$LINES_DIR/switch.sh" "$IDLE"
