// AOTC Track — Elections: the voters' side (/api/vote). No login.
//
//   GET  /e/:slug                 what the voting page needs to show
//   POST /e/:slug/verify          phone + code           -> name (+ ballot)
//   POST /e/:slug/confirm         date of birth / member no., when enabled
//   POST /e/:slug/cast            the ballot
//   GET  /booth/:token            a booth laptop's page
//   POST /booth/:token/unlock     booth PIN -> booth key (sent as X-Booth-Key)
//   GET  /booth/:token/next       a ballot released by a polling officer, if any
//   GET  /photo/:cid              a candidate's picture
//   GET  /live/:display           live figures (polling fallback)
//   GET  /stream/:display         live figures as Server-Sent Events — the same
//                                 pattern as DeonTech Pulse's /api/stream
//
// A request carrying a valid X-Booth-Key is a booth vote; anything else is an
// online vote and its IP address is recorded in the turnout record.
'use strict';

const express = require('express');
const router = express.Router();
const E = require('../utils/elections');
const { ElectionError, C } = E;
const db = require('../utils/db');

// Express 5 leaves req.body undefined when a request carries no JSON body.
router.use((req, res, next) => { if (req.body === undefined || req.body === null) req.body = {}; next(); });

const h = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (err instanceof ElectionError) return res.status(err.status).json({ error: err.message });
    console.error('[vote]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
// Nothing here may be cached: codes, ballots and live figures change.
router.use((req, res, next) => { if (!req.path.startsWith('/photo/')) res.set('Cache-Control', 'no-store'); next(); });

function election(req) {
  const e = E.bySlug(req.params.slug);
  if (!e || ['draft', 'pending'].includes(e.status)) throw new ElectionError('Election not found.', 404);
  return e;
}
// Who is voting from where. A booth key that no longer works (booth switched
// off, PIN changed) is refused outright rather than quietly treated as online.
function context(req, e) {
  const key = req.get('x-booth-key');
  if (key) {
    const b = E.boothFromKey(e, key);
    if (!b) throw new ElectionError('This booth is not enabled. Ask the election officer to switch it on, then unlock it again.', 423);
    return { channel: 'booth', boothId: b.id, ip: req.ip, ua: req.get('user-agent') || '' };
  }
  return { channel: 'online', boothId: null, ip: req.ip, ua: req.get('user-agent') || '' };
}
function info(e) {
  return {
    title: e.title, entityName: e.entityName || '', description: e.description || '',
    status: E.isOpenNow(e) ? 'open' : (e.status === 'open' ? 'closed' : e.status),
    openAt: e.openAt, closeAt: e.closeAt,
    needs: [e.verifyDob ? 'dob' : null, e.verifyMemberNo ? 'memberNo' : null].filter(Boolean),
    slug: e.slug,
  };
}

router.get('/e/:slug', h((req, res) => res.json(info(election(req)))));

router.post('/e/:slug/verify', h((req, res) => {
  const e = election(req);
  res.json(E.verifyCode(e, req.body || {}, context(req, e)));
}));

router.post('/e/:slug/confirm', h((req, res) => {
  const e = election(req);
  res.json(E.confirmSecond(e, req.body || {}, context(req, e)));
}));

router.post('/e/:slug/cast', h((req, res) => {
  const e = election(req);
  E.castVote(e, req.body || {}, context(req, e));
  res.json({ ok: true, message: 'Thank you. Your vote has been counted.' });
}));

// ---- booths
function booth(req) {
  const b = db.findOne(C.booths, x => x.token === String(req.params.token || ''));
  if (!b) throw new ElectionError('Booth not found.', 404);
  const e = E.getElection(b.electionId);
  if (!e || ['draft', 'pending'].includes(e.status)) throw new ElectionError('This election is not ready yet.', 404);
  return { b, e };
}
router.get('/booth/:token', h((req, res) => {
  const { b, e } = booth(req);
  res.json({ booth: { name: b.name, enabled: !!b.enabled }, election: info(e) });
}));
const pinFails = new Map();
router.post('/booth/:token/unlock', h((req, res) => {
  const { b, e } = booth(req);
  const k = `${b.id}`;
  const recent = (pinFails.get(k) || []).filter(t => t > Date.now() - 15 * 60000);
  if (recent.length >= 5) throw new ElectionError('Too many wrong PINs. Wait 15 minutes, or ask the officer for a new PIN.', 429);
  if (!b.enabled) throw new ElectionError('This booth is switched off. Ask the election officer to switch it on.', 423);
  const pin = String((req.body || {}).pin || '').replace(/\D/g, '');
  if (!b.pinHash || E.boothPinHash(e, b.id, pin) !== b.pinHash) {
    recent.push(Date.now()); pinFails.set(k, recent);
    E.logAttempt(e.id, { reason: 'wrong-booth-pin', boothId: b.id, channel: 'booth', ip: req.ip });
    throw new ElectionError('Wrong PIN.', 401);
  }
  pinFails.delete(k);
  db.update(C.booths, b.id, { unlockedAt: new Date().toISOString(), unlockedIp: req.ip });
  E.logEvent(e.id, 'booth-unlocked', b.name, `${b.name} unlocked on a device (${req.ip}).`);
  E.changed(e.id, 'booths');
  res.json({ key: E.boothKey(e, db.findById(C.booths, b.id)), booth: b.name, election: info(e) });
}));

// A booth asks whether a polling officer has released a ballot to it (a voter
// who came without their phone). Only the unlocked booth itself can collect it.
router.get('/booth/:token/next', h((req, res) => {
  const { b, e } = booth(req);
  const mine = E.boothFromKey(e, req.get('x-booth-key'));
  if (!mine || mine.id !== b.id) throw new ElectionError('This booth is not enabled. Ask the election officer to switch it on, then unlock it again.', 423);
  res.json(E.boothPickup(e, db.findById(C.booths, b.id)));
}));

// ---- candidate photos (public: they are printed on the ballot)
router.get('/photo/:cid', h((req, res) => {
  const c = db.findById(C.candidates, Number(req.params.cid));
  const p = c ? E.photoPath(c.photoFile) : null;
  if (!p) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  res.sendFile(p);
}));

// ---- live display
function display(req) {
  const e = E.byDisplay(req.params.display);
  if (!e) throw new ElectionError('This display link is not valid (it may have been replaced).', 404);
  return e;
}
router.get('/live/:display', h((req, res) => res.json(E.snapshot(display(req)))));

// Server-Sent Events, as in DeonTech Pulse (routes/stream.js): one long GET per
// open screen; a comment every 25 s keeps proxies and phones from closing it.
// Apache must pass /api/vote/stream through unbuffered — deploy/bluegreen/
// common.sh writes `flushpackets=on` for this path into aotc-live.conf.
let streams = 0;
router.get('/stream/:display', (req, res) => {
  let e;
  try { e = display(req); } catch (err) { return res.status(404).json({ error: err.message }); }
  if (streams > 400) return res.status(503).json({ error: 'Too many open displays.' });
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  streams++;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const push = () => {
    const fresh = E.getElection(e.id);
    if (!fresh || fresh.displayToken !== req.params.display) { send('gone', {}); return res.end(); }
    send('snapshot', E.snapshot(fresh));
  };
  push();
  // Coalesce bursts (a queue at the booths) into at most one update a second.
  let pending = null;
  const onChange = ev => {
    if (ev.electionId !== e.id || pending) return;
    pending = setTimeout(() => { pending = null; push(); }, 1000);
  };
  E.bus.on('change', onChange);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  // A slow refresh as well, so the countdown and "polls closed at the set
  // time" appear even when nobody is voting.
  const slow = setInterval(push, 30000);
  req.on('close', () => {
    streams--;
    clearInterval(beat); clearInterval(slow);
    if (pending) clearTimeout(pending);
    E.bus.off('change', onChange);
  });
});

module.exports = router;
