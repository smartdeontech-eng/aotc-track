# AOTC Track — blue-green: shared settings for provision.sh, release.sh, switch.sh.
# Every path can be overridden from the environment, which is how the scripts
# are rehearsed off the server (deploy/bluegreen/rehearse.sh). On the server,
# nothing needs setting.
BASE="${AOTC_BASE:-/opt}"
HOME_DIR="${AOTC_HOME_DIR:-$BASE/aotc-track}"      # the shared records live here, as they always have
LINES_DIR="${AOTC_LINES_DIR:-$BASE/aotc-lines}"        # blue/ and green/ (code only) + live
CONF="${AOTC_CONF_DIR:-/etc/aotc-lines}"           # blue.env, green.env (PORT=...)
APACHE="${AOTC_APACHE_DIR:-/etc/apache2}"
UNIT_DIR="${AOTC_UNIT_DIR:-/etc/systemd/system}"
BACKUPS="${AOTC_RELEASE_BACKUPS:-/var/backups/aotc-track}"
BLUE_PORT="${AOTC_BLUE_PORT:-3001}"
GREEN_PORT="${AOTC_GREEN_PORT:-3002}"
LEGACY_PORT="${AOTC_LEGACY_PORT:-3000}"
LIVE_CONF="$APACHE/aotc-live.conf"
DRAIN="${AOTC_DRAIN_SECONDS:-8}"

# Every path must be absolute. (8 Oct 2026: this folder variable used to be
# called LINES, which bash itself resets to the terminal height under ssh -t —
# the lines were made in ./24/ and the service file got a relative path.)
for _p in "$BASE" "$HOME_DIR" "$LINES_DIR" "$CONF" "$APACHE" "$UNIT_DIR" "$BACKUPS"; do
  case "$_p" in /*) ;; *) printf 'STOPPED: path "%s" is not absolute.\n' "$_p" >&2; exit 1 ;; esac
done

# The live records. Each line reaches them through a symlink of the same name,
# so the app's own paths (data/, minutes/ …) do not change. node_modules is
# shared too: deploys never run npm install, so both lines use the same set.
SHARED=(data .env minutes generated backups public/uploads marriage-files document-files node_modules)

# A line's port: what provision.sh recorded in $CONF/<line>.env, so the pair
# chosen once (AOTC_BLUE_PORT / AOTC_GREEN_PORT) holds for every later release
# and switch; before provisioning, the defaults above.
port_of() {
  case "$1" in blue|green) ;; *) return 1 ;; esac
  local f="$CONF/$1.env" p=""
  [ -f "$f" ] && p=$(sed -n 's/^PORT=//p' "$f")
  if [ -n "$p" ]; then echo "$p"; elif [ "$1" = blue ]; then echo "$BLUE_PORT"; else echo "$GREEN_PORT"; fi
}
other_of() { [ "$1" = blue ] && echo green || echo blue; }
live_line() { cat "$LINES_DIR/live" 2>/dev/null || true; }
say() { printf '%s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

# Healthy = /api/healthz answers 200 with "ok":true (the data folder is
# writable through the symlink). Waits up to $2 seconds.
wait_healthy() {
  local port="$1" secs="${2:-30}" i body
  for i in $(seq 1 "$secs"); do
    body=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/healthz" 2>/dev/null || true)
    case "$body" in *'"ok":true'*) echo "$body"; return 0 ;; esac
    sleep 1
  done
  return 1
}

# Point Apache at a port. The vhosts Include $LIVE_CONF (provision.sh put that
# line where their ProxyPass to :3000 used to be). A config Apache rejects is
# put back at once and nothing is reloaded.
point_apache_at() {
  local port="$1"
  [ -f "$LIVE_CONF" ] && cp "$LIVE_CONF" "$LIVE_CONF.prev"
  # The live election displays (Server-Sent Events, /api/vote/stream) must
  # reach the screens unbuffered, exactly as DeonTech Pulse's /api/stream does
  # (flushpackets=on). The more specific ProxyPass has to come first.
  printf '# Written by deploy/bluegreen — the live AOTC Track line.\nProxyPass /api/vote/stream http://127.0.0.1:%s/api/vote/stream flushpackets=on timeout=600\nProxyPassReverse /api/vote/stream http://127.0.0.1:%s/api/vote/stream\nProxyPass / http://127.0.0.1:%s/\nProxyPassReverse / http://127.0.0.1:%s/\n' "$port" "$port" "$port" "$port" > "$LIVE_CONF"
  if ! apache2ctl configtest >/dev/null 2>&1; then
    [ -f "$LIVE_CONF.prev" ] && mv "$LIVE_CONF.prev" "$LIVE_CONF"
    apache2ctl configtest || true
    return 1
  fi
  systemctl reload apache2
}

# Make sure a line's folder reaches the shared records through symlinks.
link_shared() {
  local dir="$1" item
  for item in "${SHARED[@]}"; do
    [ -e "$HOME_DIR/$item" ] || continue
    mkdir -p "$(dirname "$dir/$item")"
    if [ -L "$dir/$item" ]; then continue; fi
    [ -e "$dir/$item" ] && die "$dir/$item is a real folder/file, not a link to the shared records. Nothing switched."
    ln -s "$HOME_DIR/$item" "$dir/$item"
  done
}
