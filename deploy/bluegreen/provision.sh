#!/usr/bin/env bash
# AOTC Track — turn the single service into two lines, blue and green. ONCE.
#
#   sudo bash ~/aotc-staging/deploy/bluegreen/provision.sh            # look only: says what it would do
#   sudo bash ~/aotc-staging/deploy/bluegreen/provision.sh --apply    # do it
#   sudo bash ~/aotc-staging/deploy/bluegreen/provision.sh --undo     # back to the single service
#
# What changes:
#   /opt/aotc-track         stays where it is and keeps every record (data/, .env, minutes/,
#                           uploads …). It is no longer where the code runs from.
#   /opt/aotc-lines/blue    a copy of the code, port 3001 } each reaches the records in
#   /opt/aotc-lines/green   a copy of the code, port 3002 } /opt/aotc-track through symlinks
#   /opt/aotc-lines/live    the line the site is using
#   aotc-track@blue, aotc-track@green   the two services (one systemd template)
#   Apache                  the vhost's "ProxyPass / http://127.0.0.1:3000/" becomes
#                           "Include /etc/apache2/aotc-live.conf", which switch.sh rewrites
#   aotc-track (old)        stopped and disabled, NOT deleted — --undo brings it back
#
# Nothing is changed unless every check passes first.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/common.sh"
MODE="${1:-check}"
[ "$(id -u)" -eq 0 ] || [ -n "${AOTC_REHEARSAL:-}" ] || die "run with sudo"
PROXY_RE="^[[:space:]]*ProxyPass(Reverse)?[[:space:]]+/[[:space:]]+http://(127[.]0[.]0[.]1|localhost):$LEGACY_PORT/?[[:space:]]*$"

# Apache files that send the site to the old port: the real files behind
# sites-enabled (certbot's -le-ssl.conf included).
apache_files() {
  local f
  for f in "$APACHE"/sites-enabled/*; do [ -e "$f" ] && readlink -f "$f"; done | sort -u | while read -r f; do
    grep -qE ":$LEGACY_PORT\b" "$f" && echo "$f"
  done
}

if [ "$MODE" = --undo ]; then
  say "── Undo: back to the single aotc-track service"
  for f in $(ls "$APACHE"/sites-available/*.pre-bluegreen 2>/dev/null); do cp "$f" "${f%.pre-bluegreen}"; say "  restored ${f%.pre-bluegreen}"; done
  apache2ctl configtest || die "Apache rejects the restored files — look at them before reloading."
  systemctl enable aotc-track >/dev/null 2>&1 || true
  systemctl start aotc-track
  wait_healthy "$LEGACY_PORT" 30 >/dev/null || die "the old service did not come up on $LEGACY_PORT."
  systemctl reload apache2
  for l in blue green; do systemctl stop "aotc-track@$l" 2>/dev/null || true; systemctl disable "aotc-track@$l" >/dev/null 2>&1 || true; done
  rm -f "$LINES_DIR/live"
  say "Done: the site is on the old service again (port $LEGACY_PORT). /opt/aotc-lines is left in place."
  exit 0
fi

say "── Checks (nothing is changed here)"
[ -f "$HOME_DIR/server.js" ] && [ -d "$HOME_DIR/data" ] || die "$HOME_DIR does not look like the live app."
grep -q "AOTC_LINE" "$HOME_DIR/server.js" || die "the code on the server is older than blue-green (server.js has no AOTC_LINE). Run push.sh once first, then this."
[ ! -e "$LINES_DIR/live" ] || die "already done: $LINES_DIR/live says $(live_line). Deploy with push.sh; roll back with switch.sh."
[ "$(systemctl is-active aotc-track 2>/dev/null || true)" = active ] || die "the aotc-track service is not running — fix that first."
U=$(systemctl show aotc-track -p User --value); G=$(systemctl show aotc-track -p Group --value)
[ -n "$U" ] || die "the aotc-track service has no User= — not going to run the lines as root."
NODE=$(systemctl show aotc-track -p ExecStart --value | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -1)
[ -x "${NODE:-}" ] || die "could not find the node binary the service uses (got '${NODE:-}')."
WD=$(systemctl show aotc-track -p WorkingDirectory --value)
[ "$WD" = "$HOME_DIR" ] || die "the service runs from '$WD', not $HOME_DIR."
ENVS=$(systemctl show aotc-track -p Environment --value)
for p in "$BLUE_PORT" "$GREEN_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    say "  port $p is taken by: $(ss -ltnp 2>/dev/null | grep -E "[:.]$p[[:space:]]" | grep -o 'users:(("[^"]*"' | cut -d'"' -f2 | sort -u | tr '\n' ' ')"
    say "  Free ports nearby: $(for q in $(seq 3003 3099); do ss -ltn | awk '{print $4}' | grep -qE "[:.]$q\$" || printf '%s ' $q; done | cut -d' ' -f1-6)"
    die "port $p is already in use. Choose two free ports, e.g.:  sudo AOTC_BLUE_PORT=3011 AOTC_GREEN_PORT=3012 bash …/provision.sh"
  fi
done
FILES=$(apache_files)
[ -n "$FILES" ] || die "no enabled Apache site sends anything to port $LEGACY_PORT."
BAD=""
for f in $FILES; do
  while IFS= read -r line; do
    echo "$line" | grep -qE "$PROXY_RE" || BAD="$BAD\n  $f: $line"
  done < <(grep -E ":$LEGACY_PORT\b" "$f")
done
[ -z "$BAD" ] || die "these Apache lines use port $LEGACY_PORT in a way this script does not know how to change:$(printf "$BAD")"
say "  app:        $HOME_DIR (runs as $U, node $NODE)"
say "  env:        $ENVS"
say "  ports:      blue $BLUE_PORT, green $GREEN_PORT — both free"
for f in $FILES; do say "  Apache:     $f"; grep -nE "$PROXY_RE" "$f" | sed 's/^/                line /'; done

if [ "$MODE" != --apply ]; then
  say ""
  say "All checks pass. Run again with --apply to make the change. The site keeps running throughout."
  exit 0
fi

say ""
say "── 1. The two lines"
mkdir -p "$LINES_DIR" "$CONF"
EXCL=(); for item in "${SHARED[@]}"; do EXCL+=(--exclude "/$item"); done
for l in blue green; do
  mkdir -p "$LINES_DIR/$l"
  rsync -a "${EXCL[@]}" --exclude '/*.tar.gz' "$HOME_DIR/" "$LINES_DIR/$l/"
  link_shared "$LINES_DIR/$l"
  chown -R "$U:${G:-$U}" "$LINES_DIR/$l"
  printf 'PORT=%s\nAOTC_LINE=%s\nAOTC_LIVE_FILE=%s\n' "$(port_of $l)" "$l" "$LINES_DIR/live" > "$CONF/$l.env"
  say "  $l: $LINES_DIR/$l (port $(port_of $l))"
done
install -m 755 "$HERE/common.sh" "$HERE/switch.sh" "$HERE/release.sh" "$LINES_DIR/"

say "── 2. The service template aotc-track@.service"
RW=""; for d in data backups public/uploads minutes generated marriage-files document-files; do RW="$RW -$HOME_DIR/$d"; done
cat > "$UNIT_DIR/aotc-track@.service" <<UNIT
# AOTC Track — one blue-green line (written by deploy/bluegreen/provision.sh).
#   systemctl status aotc-track@blue      journalctl -u aotc-track@green -f
[Unit]
Description=AOTC Track — %i line
After=network.target

[Service]
Type=simple
User=$U
Group=${G:-$U}
WorkingDirectory=$LINES_DIR/%i
Environment=$ENVS
EnvironmentFile=$CONF/%i.env
ExecStart=$NODE server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$RW -$LINES_DIR/%i/public/img

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

say "── 3. Blue starts beside the old service and must answer healthy"
systemctl enable "aotc-track@blue" >/dev/null 2>&1 || true
systemctl start "aotc-track@blue"
H=$(wait_healthy "$BLUE_PORT" 40) || {
  journalctl -u aotc-track@blue -n 40 --no-pager 2>/dev/null || true
  systemctl stop aotc-track@blue || true
  die "blue did not become healthy. The site is untouched, still on the old service."
}
say "  blue healthy: $H"

say "── 4. Apache: send the site to blue"
for f in $FILES; do cp "$f" "$f.pre-bluegreen"; done
point_apache_at_first() {
  printf '# Written by deploy/bluegreen — the live AOTC Track line.\nProxyPass / http://127.0.0.1:%s/\nProxyPassReverse / http://127.0.0.1:%s/\n' "$BLUE_PORT" "$BLUE_PORT" > "$LIVE_CONF"
  for f in $FILES; do
    awk -v re="$PROXY_RE" -v inc="Include $LIVE_CONF" '
      $0 ~ re { if ($0 ~ /ProxyPassReverse/) next; match($0, /^[[:space:]]*/); print substr($0, 1, RLENGTH) inc; next }
      { print }' "$f.pre-bluegreen" > "$f"
  done
}
point_apache_at_first
if ! apache2ctl configtest >/dev/null 2>&1; then
  for f in $FILES; do cp "$f.pre-bluegreen" "$f"; done
  rm -f "$LIVE_CONF"; systemctl stop aotc-track@blue || true
  apache2ctl configtest || true
  die "Apache rejected the new configuration; the old files are back and nothing was reloaded."
fi
systemctl reload apache2
echo blue > "$LINES_DIR/live"
say "  the site now goes to blue (port $BLUE_PORT)"

say "── 5. The old service stops (kept, not deleted)"
sleep "$DRAIN"
systemctl stop aotc-track
systemctl disable aotc-track >/dev/null 2>&1 || true
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --resolve track.pcg-aotc.com:443:127.0.0.1 https://track.pcg-aotc.com/login.html || true)
say "  https://track.pcg-aotc.com/login.html through Apache: $code (200 expected)"
say ""
say "Done. Live line: blue. From now on push.sh releases to the idle line and switches."
say "Roll back a release:   sudo bash $LINES_DIR/switch.sh <other colour>"
say "Undo all of this:      sudo bash $LINES_DIR/blue/deploy/bluegreen/provision.sh --undo"
