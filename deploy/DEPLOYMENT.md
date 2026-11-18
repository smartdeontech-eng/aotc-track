# Deploying AOTC Track to your SSDNodes VPS

Every command below is copy-paste. Lines starting with `#` are notes.
Assumes Ubuntu 22.04/24.04 on the VPS. Total time: ~30–40 minutes.


## The deploy you actually run (day to day)

The app runs as the unprivileged `aotc` user at `/opt/aotc-track`, which your
`deploy` login cannot write to directly. So it goes in two steps: push to a
staging directory in the `deploy` home, then promote it with sudo.

**Step 0 — take a rollback snapshot on the server.** Do this every time, until
`aotc-track` has a git history worth reverting to. It costs seconds and it is
the only way back if a promote goes wrong.

```bash
ssh -t deploy@172.93.52.195 "sudo tar czf /opt/aotc-track-\$(date +%Y%m%d-%H%M).tar.gz \
  --exclude=node_modules --exclude=data --exclude=backups -C /opt aotc-track && ls -lh /opt/*.tar.gz | tail -3"
```

To roll back: stop the service, untar over `/opt/aotc-track`, start it again.
`data` is excluded because the live records must never be rolled back with the
code.

Step 1 — push from the Mac:

```bash
cd ~/Library/CloudStorage/OneDrive-Personal/Projects/Software/"AOTC Reports Software"/aotc-track

rsync -av --exclude node_modules --exclude .env --exclude data --exclude backups \
  --exclude minutes --exclude generated --exclude 'public/uploads' \
  --exclude marriage-files --exclude 'LAYOUT-RESEARCH-*.md' --exclude layout-preview.html \
  --exclude '*.zip' --exclude '.DS_Store' \
  --exclude '.git' --exclude '_preview' --exclude '_to_delete' --exclude '_pre-headings-backup' \
  ./ deploy@172.93.52.195:aotc-staging/
```

The last exclude line was added on 13 September. Without it the push carries
about 11 MB of junk every time — `_to_delete/` (7.7 MB of files a cleanup pass
had already set aside for deletion), `_preview/`, `_pre-headings-backup/`, and
`.git/`, which did not exist when this guide was first written. None of it is
served, but none of it belongs on a production box either, and the `.git`
exclude matters more once the repo actually has history in it.

Step 2 — promote and restart:

```bash
ssh -t deploy@172.93.52.195 "sudo rsync -a --chown=aotc:aotc \
  --exclude data --exclude .env --exclude minutes --exclude generated \
  ~/aotc-staging/ /opt/aotc-track/ && sudo systemctl restart aotc-track"
```

`npm install` is NOT part of the day-to-day deploy. Run it on the server only
when `package.json` has actually changed — check before you assume.

Step 3 — verify it actually went up. Twice now a change has looked broken when
the real problem was that it had never been promoted. Ask the LIVE server for
something only the new code contains:

```bash
ssh deploy@172.93.52.195 "
  echo -n 'new API route:  '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/attendance/overview
  echo -n 'new front end:  '; curl -s http://127.0.0.1:3000/js/app.js | grep -c ROLE_LABELS
"
```

The API line should print **401** — the route exists and is asking you to log
in. **404** means the promote did not take. (Do not expect 200: you are not
authenticated.) The front-end line should print above zero.

Pick the grep to match whatever you just changed; `ROLE_LABELS` is the marker
for the September naming pass. `0` means the promote did not take — do not go
looking at the app until this passes.

Always use the IP, 172.93.52.195, in these commands. `track.pcg-aotc.com` is
the public web address and does not resolve from the Mac for SSH — you will get
"Could not resolve hostname" followed by a wall of rsync io_read errors, which
looks alarming but only ever means the connection never opened.

Things that have gone wrong before, and why:

- **The push hangs on a huge transfer.** You were rsyncing from the PARENT
  folder, so `aotc-track copy.zip` (30 MB) went with it. `cd` INTO `aotc-track`
  first — note the `./` at the end of the rsync source above.
- **`ls: Permission denied` on `/opt/aotc-track`.** Expected. `deploy` cannot
  read into an `aotc`-owned directory. Verify over curl (step 3), not with `ls`.
- **`data` is excluded on both legs, deliberately.** The live accounts, minutes
  and settings are on the server. A stray copy from a laptop or a sandbox would
  overwrite real records.


## 0. Before you start

- **DNS**: wherever `pcg-aotc.com` is managed (your registrar or email host),
  add an **A record**: name `track`, value = your SSDNodes server IP.
  Do this first — it can take a few minutes to spread.
- You need SSH access to the VPS (SSDNodes dashboard shows the IP and root login).

## 0.5 Preflight — this VPS already hosts pledges.pcg-aotc.com

Your pledge system already answers on ports 80/443, so a web server is
already installed. Find out which one before touching anything:

```bash
ssh root@YOUR_SERVER_IP
ss -tlnp | grep -E ':80 |:443 '
```

- If you see **nginx** → perfect, follow this guide exactly (our config
  ADDS a site; it will not disturb pledges).
- If you see **apache2** → skip the nginx parts of step 1 and use the
  Apache variant in step 6b instead.
- If you see the .NET app itself (e.g. `dotnet`/`Kestrel` directly on 443)
  → stop and tell me — we'll front both apps with nginx carefully.

Also note pledges' port so we don't collide (AOTC Track uses 3000):
`ss -tlnp | grep dotnet` — if it shows 3000, change PORT in our .env to 3100
(and the proxy_pass in the nginx/apache config to match).

## 1. On the VPS — base software (skip anything already installed)

```bash
ssh root@YOUR_SERVER_IP

apt update && apt upgrade -y
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs nginx certbot python3-certbot-nginx
node -v   # should print v22.x
```

## 2. Dedicated unprivileged user + folder

```bash
adduser --system --group --home /opt/aotc-track aotc
mkdir -p /opt/aotc-track
```

## 3. Copy the app from your Mac

On your **Mac** (new Terminal window, not the SSH one):

```bash
cd ~/Library/CloudStorage/OneDrive-Personal/Projects/Software/"AOTC Reports Software"
rsync -av --exclude node_modules --exclude .env aotc-track/ root@YOUR_SERVER_IP:/opt/aotc-track/
```

This INCLUDES your data folder — accounts, goals, everything you've entered
locally carries over.

## 4. Back on the VPS — install & configure

```bash
cd /opt/aotc-track
npm install --omit=dev

# production .env (never copy the laptop one)
cat > .env << 'ENV'
NODE_ENV=production
PORT=3000
JWT_SECRET=REPLACE_ME
SMS_API_KEY=REPLACE_WITH_MNOTIFY_KEY
SMS_SENDER_ID=PCG-AOTC
NOTIFY_EMAIL=gadjei@pcg-aotc.com
APP_URL=https://track.pcg-aotc.com
WEBAUTHN_RP_ID=track.pcg-aotc.com
WEBAUTHN_ORIGIN=https://track.pcg-aotc.com
# SMTP_* lines optional — add when email is ready (see .env.example)
ENV

# generate the real JWT secret and put it in place
sed -i "s/REPLACE_ME/$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")/" .env
nano .env   # paste your mNotify API key over REPLACE_WITH_MNOTIFY_KEY, then Ctrl+O, Enter, Ctrl+X

chown -R aotc:aotc /opt/aotc-track
chmod 600 /opt/aotc-track/.env
```

## 5. Run it as a service (starts on boot, restarts on crash)

```bash
cp /opt/aotc-track/deploy/aotc-track.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aotc-track
systemctl status aotc-track    # should say "active (running)"
```

## 6. nginx + free HTTPS certificate

```bash
cp /opt/aotc-track/deploy/nginx.conf /etc/nginx/sites-available/aotc-track
ln -s /etc/nginx/sites-available/aotc-track /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# HTTPS (needs the DNS record from step 0 to be live)
certbot --nginx -d track.pcg-aotc.com
```

## 6b. Apache variant (only if the preflight showed apache2)

```bash
a2enmod proxy proxy_http ssl headers
cat > /etc/apache2/sites-available/aotc-track.conf << 'APACHE'
<VirtualHost *:80>
    ServerName track.pcg-aotc.com
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
</VirtualHost>
APACHE
a2ensite aotc-track && apache2ctl configtest && systemctl reload apache2
apt install -y python3-certbot-apache
certbot --apache -d track.pcg-aotc.com
```

## 7. Verify

- Open **https://track.pcg-aotc.com** — the PCG login page should load, padlocked.
- Log in with your usual account (it came over with the data).
- Settings → Notifications → "Send test SMS" to your phone.
- `journalctl -u aotc-track -f` on the VPS tails the app log
  (you should see the reminder jobs scheduled line).

## 8. After go-live

- Reminders now run around the clock; passkeys (Face ID) work because of HTTPS.
- Updating the app later: re-run the rsync from step 3 **adding**
  `--exclude data --exclude minutes --exclude generated` (never overwrite live
  data), then `ssh root@IP "cd /opt/aotc-track && npm install --omit=dev && systemctl restart aotc-track"`.
- Offsite backup (recommended): daily copy of /opt/aotc-track/data and
  /opt/aotc-track/backups off the server — simplest is a cron rsync back to
  your Mac or to any cloud storage.
