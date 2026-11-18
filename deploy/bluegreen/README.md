# AOTC Track — blue-green deploys

Modelled on IFAIMA's `deploy/release.sh` and `switch.sh` (same VPS), with one difference that
matters: **only one line runs at a time**, apart from the few seconds of a switch.

## Why not keep both lines running, as IFAIMA does

IFAIMA keeps its database in SQLite, so two processes can share it. AOTC Track keeps its records
in JSON files. `db.insert()` (`max(id) + 1`) and `db.mutate()` (read, modify, write) are safe only
inside one process. IFAIMA measured the JSON store with two writers and found it **lost 137 of
300** inserts.

The reminders and automatic backups also run inside the app, so a second live copy would send
every reminder twice. The idle line is therefore **stopped** once the site has moved off it. Its
release stays on disk, and a rollback starts it again in about five seconds.

## Layout on the server

| | |
|---|---|
| `/opt/aotc-track` | The **records**: `data/`, `.env`, `minutes/`, `generated/`, `backups/`, `public/uploads`, `marriage-files`, `document-files`, plus `node_modules`. They are unchanged and stay where they always were. The old single service also lives here, stopped. |
| `/opt/aotc-lines/blue` (port **3001**), `/opt/aotc-lines/green` (port **3002**) | Code only. Each line reaches the records through symlinks of the same names, so no path in the app changes. |
| `/opt/aotc-lines/live` | The line the site is using. |
| `/etc/aotc-lines/blue.env`, `green.env` | `PORT`, `AOTC_LINE`, `AOTC_LIVE_FILE`. The ports are fixed here at provisioning: 3001/3002 by default, or another pair with `sudo env AOTC_BLUE_PORT=… AOTC_GREEN_PORT=… bash provision.sh`. **On the live server, 3001 was already taken (8 Oct)**, so a different pair is needed. |
| `aotc-track@blue`, `aotc-track@green` | One systemd template. It copies the old unit's user, node and environment, and has the same sandboxing. |
| `/etc/apache2/aotc-live.conf` | `ProxyPass / http://127.0.0.1:<port>/`. The vhost `Include`s it where its ProxyPass to `:3000` used to be. |
| `/var/backups/aotc-track/data-before-*.tar.gz` | A copy of `data/` (without photos) taken before each release's code first runs. The last 10 are kept. |

## In the app (`server.js`)

- With `AOTC_LINE` set, the reminders and automatic backups start only once `/opt/aotc-lines/live` names that line. The app checks every 15 seconds.
- Without `AOTC_LINE` (a laptop, or the old service) the app behaves as before.
- `/api/healthz` reports `line` and `live`. Its write probe is named per process.

## Commands

```bash
# ONCE, after one ordinary push.sh has put this code on the server:
ssh -t deploy@track.pcg-aotc.com "sudo bash ~/aotc-staging/deploy/bluegreen/provision.sh"          # checks only
ssh -t deploy@track.pcg-aotc.com "sudo bash ~/aotc-staging/deploy/bluegreen/provision.sh --apply"  # do it

# Every deploy after that: the same push.sh (it notices /opt/aotc-lines/live).

# Roll back to the previous release:
ssh -t deploy@track.pcg-aotc.com "sudo bash /opt/aotc-lines/switch.sh blue"    # or green

# Go back to the single service:
ssh -t deploy@track.pcg-aotc.com "sudo bash /opt/aotc-lines/blue/deploy/bluegreen/provision.sh --undo"
```

`release.sh`, run by `push.sh`, does this in order:

1. Copies `data/`.
2. Rsyncs staging into the idle line. Symlinks are kept; logos uploaded on Settings are carried over.
3. Starts the idle line and waits for `/api/healthz` to report `ok`.
4. Runs `switch.sh`: Apache config test, reload, record the line as live, wait 8 seconds, stop the other line.

A release that never becomes healthy is stopped, and the site stays where it was.

## What `provision.sh` refuses to do

It changes nothing if any of these is true:

- The server code has no `AOTC_LINE`, so `push.sh` has not been run yet.
- `aotc-track` is not running, or it runs from a folder other than `/opt/aotc-track`, or it has no `User=`.
- Port 3001 or 3002 is already in use.
- An enabled Apache site uses `:3000` in any way other than `ProxyPass / …` or `ProxyPassReverse / …`.

If Apache rejects the new configuration, the old files are put back and the old service keeps running.

## Rehearsal

`bash deploy/bluegreen/rehearse.sh` builds a pretend server under `$HOME/aotc-bg-rehearsal`:

- a copy of `data/`;
- no `.env`, so nothing can send a message;
- stand-ins for systemctl, apache2ctl and journalctl that run the real app;
- a proxy in place of Apache.

It then runs these steps, each followed by its checks:

1. Check.
2. A refused Apache change.
3. Provision.
4. Release.
5. Rollback.
6. A broken release.
7. Undo.

Throughout, a request goes through the proxy every 0.2 s.

**8 Oct 2026:** 29/29 checks passed, and none of the 352 requests failed.

Not rehearsed: real Apache and real systemd. `provision.sh` without `--apply` is the check on the
real server.
