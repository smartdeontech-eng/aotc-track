# Letter-page tray — browser check (9 Oct 2026)

Needs Playwright + Chromium (run in the cloud workspace, not on the Mac). Throwaway data only.

```bash
cp -r data /tmp/sbx-tray            # then make user 1 an admin with sessionVersion 0 in users.json
AOTC_DATA_DIR=/tmp/sbx-tray JWT_SECRET=$(printf 'x%.0s' {1..48}) TZ=Africa/Accra PORT=4555 node server.js &
# test files: big.jpg (>900 KB), small.png, letter.pdf beside ui.js
JWT_SECRET=… W=390 node ui.js ; W=1280 node ui.js
```

19 checks at 390 px and 1280 px, all passing on 9 Oct: the tray opens; Take a photo asks for the
back camera; a 1.36 MB photo goes up at about 278 KB; PDF tile; ◀ ▶ ✕; no sideways scroll; pages put
back after a reload, in order; ONE letter with the pages in tray order; nothing put back after
upload; + Add pages for a letter; at most 10 pages; Cancel asks first; no page errors.

Found on the way: the site's Content-Security-Policy blocked `blob:` images, so the thumbnails (and
the document viewer's image view) were blank — `img-src` now allows `blob:`. The tray first sat
above the app's own dialogs (z-index), so "Discard them?" was hidden behind it.
