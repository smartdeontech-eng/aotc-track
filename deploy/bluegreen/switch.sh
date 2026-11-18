#!/usr/bin/env bash
# AOTC Track — point the site at the other line. This is also the ROLLBACK:
#
#   sudo bash /opt/aotc-lines/switch.sh blue
#   sudo bash /opt/aotc-lines/switch.sh green
#
# It starts that line if it is stopped, refuses to switch unless it answers
# healthy, points Apache at it, records it as live, then stops the other line
# after a few seconds (in-flight requests finish first). Only one line ever
# runs for longer than that: the records are JSON files, and two processes
# writing them at once lose records (IFAIMA measured 137 of 300).
set -euo pipefail
. "$(dirname "$0")/common.sh"
TARGET="${1:?usage: switch.sh blue|green}"
PORT=$(port_of "$TARGET") || die "the line must be blue or green"
[ "$(id -u)" -eq 0 ] || [ -n "${AOTC_REHEARSAL:-}" ] || die "run with sudo"
[ -d "$LINES_DIR/$TARGET" ] || die "$LINES_DIR/$TARGET does not exist. Run provision.sh first."
OTHER=$(other_of "$TARGET")
WAS=$(live_line)

link_shared "$LINES_DIR/$TARGET"
if [ "$(systemctl is-active "aotc-track@$TARGET" 2>/dev/null || true)" != active ]; then
  say "starting $TARGET …"
  systemctl start "aotc-track@$TARGET"
fi
H=$(wait_healthy "$PORT" 30) || {
  journalctl -u "aotc-track@$TARGET" -n 30 --no-pager 2>/dev/null || true
  die "$TARGET (port $PORT) is not healthy. The site is still on ${WAS:-the old service}."
}
say "$TARGET healthy: $H"

point_apache_at "$PORT" || die "Apache rejected the change. The site is still on ${WAS:-the old service}."
echo "$TARGET" > "$LINES_DIR/live"
say "LIVE LINE IS NOW $TARGET (port $PORT)."

# The site no longer sends anything to the other line. Let what it is still
# answering finish, then stop it.
if [ "$(systemctl is-active "aotc-track@$OTHER" 2>/dev/null || true)" = active ]; then
  sleep "$DRAIN"
  systemctl stop "aotc-track@$OTHER"
  say "$OTHER stopped. It keeps its release on disk: 'switch.sh $OTHER' brings it back."
fi
