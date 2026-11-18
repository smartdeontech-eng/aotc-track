#!/bin/bash
#
# Nightly off-server backup, with an email when anything goes wrong.
#
# Runs /usr/local/bin/aotc-offsite-backup.sh (unchanged), then checks:
#   1. the upload printed no errors (expired OneDrive sign-ins show up here)
#   2. each app made its own on-server backup in the last 26 hours
#   3. today's copy of each app actually landed in each OneDrive account
# Any problem -> an email listing what failed.
# Every Monday, an "all OK" email too, so silence never hides a broken alert.
#
# Mail settings live in /etc/backup-alert.conf (root-only, chmod 600):
#   SMTP_URL=smtp://smtp.gmail.com:587
#   SMTP_USER=you@gmail.com
#   SMTP_PASS=xxxxxxxxxxxxxxxx        # Gmail app password, not your normal one
#   ALERT_TO=you@gmail.com
#
# Test without running a backup:  sudo backup-alert.sh --test-email

CONF=/etc/backup-alert.conf
LOG=/var/log/aotc-offsite.log
BACKUP=/usr/local/bin/aotc-offsite-backup.sh
ACCOUNTS=(onedrive: minutes:)
FOLDERS=(AOTC-Track Smart-DeonTech GinasAngel-Hub)
APP_BACKUP_DIRS=(/opt/aotc-track/backups /opt/smart-deontech/backups /opt/ginasangel/backups)

# shellcheck source=/dev/null
. "$CONF" || { echo "$(date) backup-alert: cannot read $CONF" >> "$LOG"; exit 1; }
HOSTNAME_SHORT=$(hostname -s)

send_mail () {   # $1 = subject, $2 = body
  local MSG
  MSG=$(mktemp)
  printf 'From: Server backups <%s>\r\nTo: %s\r\nSubject: [%s] %s\r\nDate: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%b\r\n' \
    "$SMTP_USER" "$ALERT_TO" "$HOSTNAME_SHORT" "$1" "$(date -R)" "$2" > "$MSG"
  if ! curl -sS --ssl-reqd --url "$SMTP_URL" --user "$SMTP_USER:$SMTP_PASS" \
        --mail-from "$SMTP_USER" --mail-rcpt "$ALERT_TO" --upload-file "$MSG" 2>>"$LOG"; then
    echo "$(date) backup-alert: could not send email '$1'" >> "$LOG"
  fi
  rm -f "$MSG"
}

if [ "$1" = "--test-email" ]; then
  send_mail "Test: backup alerts are working" "This is a test from backup-alert.sh on $HOSTNAME_SHORT.\nIf you can read this, failure alerts will reach you."
  echo "Test email sent to $ALERT_TO (check spam if it doesn't arrive)."
  exit 0
fi

OUT=$(mktemp)
echo "===== $(date) =====" >> "$LOG"
"$BACKUP" > "$OUT" 2>&1
RC=$?
cat "$OUT" >> "$LOG"

PROBLEMS=""

# 1. errors printed by the backup run
ERRS=$(grep -E "CRITICAL|ERROR|Failed to" "$OUT" | head -15)
[ -n "$ERRS" ] && PROBLEMS+="Upload errors:\n$ERRS\n\nIf it says 'token expired', reconnect that account:\n  rclone config reconnect <account>:\n\n"
[ "$RC" -ne 0 ] && PROBLEMS+="The backup script exited with code $RC.\n\n"

# 2. each app's own on-server backup is fresh
for D in "${APP_BACKUP_DIRS[@]}"; do
  if [ -z "$(find "$D" -mindepth 1 -maxdepth 1 -mmin -1560 2>/dev/null | head -1)" ]; then
    PROBLEMS+="No new on-server backup in $D in the last 26 hours.\n"
  fi
done

# 3. today's copy landed in every account
TODAY=$(date +%Y%m%d)
for A in "${ACCOUNTS[@]}"; do
  for F in "${FOLDERS[@]}"; do
    N=$(sudo -u deploy rclone ls "$A$F/Backups" 2>/dev/null | grep -c "$TODAY")
    [ "$N" -ge 1 ] || PROBLEMS+="Today's copy is missing: $A$F/Backups\n"
  done
done

rm -f "$OUT"

if [ -n "$PROBLEMS" ]; then
  echo "$(date) backup-alert: PROBLEMS found, emailing $ALERT_TO" >> "$LOG"
  send_mail "Backup FAILED - action needed" "Last night's backup on $HOSTNAME_SHORT had problems:\n\n$PROBLEMS\nFull log: $LOG"
elif [ "$(date +%u)" = 1 ]; then
  send_mail "Backups OK (weekly check)" "All three apps backed up and copied to ${ACCOUNTS[*]} today.\nYou only get this on Mondays; a failure on any night emails you straight away."
fi
exit 0
