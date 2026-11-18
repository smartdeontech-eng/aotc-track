// AOTC Track — Elections: the officers' side (/api/elections).
//
// Who may do what:
//   elections.manage  (CLAN Coordinator)  set up, submit, run polls, voters, booths
//   approvals.manage  (Session Clerk)     confirm before polls open, certify after
//   admin / local admin                   everything
// The voting itself (public, no login) is routes/vote.js.
'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const E = require('../utils/elections');
const { C, ElectionError } = E;

// Express 5 leaves req.body undefined when a request carries no JSON body.
router.use((req, res, next) => { if (req.body === undefined || req.body === null) req.body = {}; next(); });

function perms(req) { return (db.findById('users', req.user.id) || {}).permissions || []; }
const isAdmin = req => ['admin', 'localadmin'].includes(req.user.role);
const canManage = req => isAdmin(req) || perms(req).includes('elections.manage');
const canConfirm = req => isAdmin(req) || perms(req).includes('approvals.manage');
const who = req => (db.findById('users', req.user.id) || {}).name || 'Unknown';

function guard(test, msg) {
  return (req, res, next) => test(req) ? next() : res.status(403).json({ error: msg });
}
const view = guard(r => canManage(r) || canConfirm(r), 'Elections are run by the CLAN Coordinator and confirmed by the Session Clerk.');
const manage = guard(canManage, 'Only the election officer (CLAN Coordinator) can change an election.');
const confirmer = guard(canConfirm, 'Only the Session Clerk can do this.');
const officer = guard(r => canManage(r) || canConfirm(r), 'Only the election officer or the Session Clerk can do this.');

// Wrap a handler so ElectionError becomes a clean JSON answer.
const h = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (err instanceof ElectionError) return res.status(err.status).json({ error: err.message });
    console.error('[elections]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
function load(req) {
  const e = E.getElection(req.params.id);
  if (!e) throw new ElectionError('Election not found.', 404);
  return e;
}
const DRAFT = ['draft'];

// Polling officers: anyone the CLAN Coordinator named for this election, plus
// the election officers themselves.
const userRec = req => db.findById('users', req.user.id) || {};
function officerOf(req, e) {
  if (canManage(req) || E.isOfficer(e, userRec(req))) {
    const u = userRec(req), primary = u.linkedTo ? db.findById('users', Number(u.linkedTo)) || u : u;
    return { id: primary.id, name: primary.name || u.name || 'Officer' };
  }
  throw new ElectionError('Only the polling officers named for this election can use the polling desk.', 403);
}
function mustBe(e, statuses, what) {
  if (!statuses.includes(e.status)) {
    const label = { draft: 'being set up', pending: 'waiting for the Session Clerk', confirmed: 'confirmed', open: 'open', closed: 'closed', certified: 'certified' };
    throw new ElectionError(`${what} — not possible while the election is ${label[e.status] || e.status}.`, 409);
  }
}

function entityInfo(entityType, entityId) {
  if (entityType === 'group' || entityType === 'committee') {
    const rec = db.findById(entityType === 'group' ? 'groups' : 'committees', Number(entityId));
    if (!rec) throw new ElectionError('That group or committee no longer exists.');
    return { entity: { type: entityType, id: rec.id }, entityName: rec.name };
  }
  return { entity: { type: 'congregation', id: 0 }, entityName: 'Congregation' };
}
function settingsFrom(body) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title || '').trim().slice(0, 120);
  if (body.smsTitle !== undefined) out.smsTitle = String(body.smsTitle || '').trim().slice(0, 38);
  if (body.description !== undefined) out.description = String(body.description || '').trim().slice(0, 2000);
  if (body.openAt !== undefined) out.openAt = body.openAt ? new Date(body.openAt).toISOString() : null;
  if (body.closeAt !== undefined) out.closeAt = body.closeAt ? new Date(body.closeAt).toISOString() : null;
  for (const k of ['verifyDob', 'verifyMemberNo', 'shuffle']) if (body[k] !== undefined) out[k] = !!body[k];
  if (body.liveMode !== undefined) out.liveMode = body.liveMode === 'full' ? 'full' : 'turnout';
  return out;
}
function checkTimes(s) {
  if (s.openAt && isNaN(new Date(s.openAt))) throw new ElectionError('The opening time is not a valid date.');
  if (s.closeAt && isNaN(new Date(s.closeAt))) throw new ElectionError('The closing time is not a valid date.');
  if (s.openAt && s.closeAt && new Date(s.closeAt) <= new Date(s.openAt)) throw new ElectionError('Polls must close after they open.');
}

// ---------------------------------------------------------------- list / create
// Every group and committee, for the "For" list. CLAN runs elections for all
// groups, so this is not limited to the officer's own entity.
router.get('/entities', requireAuth, view, h((req, res) => {
  const pick = coll => db.findAll(coll).filter(x => x.active !== false).map(x => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ groups: pick('groups'), committees: pick('committees') });
}));

// Elections this person can work the polling desk for (named officer, or the
// election officer), while they are confirmed or open.
router.get('/desk/mine', requireAuth, h((req, res) => {
  const u = userRec(req);
  const list = db.findAll(C.elections, e => ['confirmed', 'open'].includes(e.status) && (canManage(req) || E.isOfficer(e, u)))
    .map(e => ({ id: e.id, title: e.title, entityName: e.entityName, status: E.isOpenNow(e) ? 'open' : e.status, openAt: e.openAt, closeAt: e.closeAt }));
  res.json(list);
}));

router.get('/', requireAuth, view, h((req, res) => {
  const list = db.findAll(C.elections).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json(list.map(e => ({
    ...E.publicElection(e),
    voters: db.findAll(C.voters, v => v.electionId === e.id).length,
    voted: E.turnoutRows(e.id).length,
  })));
}));

router.post('/', requireAuth, manage, h((req, res) => {
  const s = settingsFrom(req.body || {});
  if (!s.title) throw new ElectionError('Give the election a title, e.g. "YPG Executive Elections 2026".');
  checkTimes(s);
  const ent = entityInfo(req.body.entityType, req.body.entityId);
  const e = db.insert(C.elections, {
    verifyDob: false, verifyMemberNo: false, shuffle: false, liveMode: 'turnout', description: '',
    ...s, ...ent, status: 'draft', slug: E.slugFor(s.title), displayToken: E.rand(18),
    secret: crypto.randomBytes(32).toString('hex'), createdBy: who(req),
  });
  E.logEvent(e.id, 'created', who(req), `Election created for ${e.entityName}.`);
  res.status(201).json(E.publicElection(e));
}));

// ---------------------------------------------------------------- detail
router.get('/:id', requireAuth, view, h((req, res) => {
  const e = load(req);
  const voters = db.findAll(C.voters, v => v.electionId === e.id);
  const sms = { sent: 0, failed: 0, skipped: 0, sending: 0, none: 0 };
  voters.forEach(v => { const s = v.sms ? v.sms.status : 'none'; sms[s] = (sms[s] || 0) + 1; });
  const cands = E.candidatesOf(e.id);
  res.json({
    election: E.publicElection(e),
    can: { manage: canManage(req), confirm: canConfirm(req) },
    positions: E.positionsOf(e.id).map(p => {
      const list = cands.filter(c => c.positionId === p.id);
      return { ...p, mode: E.modeOf(p, list), candidates: list.map(c => ({ id: c.id, name: c.name, order: c.order || 0, photo: c.photoFile ? `/api/vote/photo/${c.id}?v=${c.photoV || 1}` : null })) };
    }),
    booths: db.findAll(C.booths, b => b.electionId === e.id).map(b => ({ id: b.id, name: b.name, enabled: !!b.enabled, token: b.token, lastVoteAt: b.lastVoteAt || null, unlockedAt: b.unlockedAt || null })),
    voterCount: voters.length,
    locked: voters.filter(v => v.lockedUntil && new Date(v.lockedUntil) > new Date()).length,
    sms,
    snapshot: E.snapshot(e, { forAdmin: true }),
    signoff: E.signoffFor(e),
    events: db.findAll(C.events, x => x.electionId === e.id).slice(-60).reverse(),
  });
}));

router.put('/:id', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Settings can only change while the election is being set up');
  const s = settingsFrom(req.body || {});
  if (s.title === '') throw new ElectionError('The title cannot be empty.');
  checkTimes({ ...e, ...s });
  const patch = { ...s };
  if (req.body.entityType !== undefined) Object.assign(patch, entityInfo(req.body.entityType, req.body.entityId));
  const u = db.update(C.elections, e.id, patch);
  E.logEvent(e.id, 'edited', who(req), 'Settings changed.');
  res.json(E.publicElection(u));
}));

router.delete('/:id', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Only an election still being set up can be deleted');
  for (const coll of [C.positions, C.voters, C.booths, C.events, C.attempts, C.assists]) {
    db.findAll(coll, x => x.electionId === e.id).forEach(x => db.remove(coll, x.id));
  }
  E.candidatesOf(e.id).forEach(c => { E.deletePhoto(c.photoFile); db.remove(C.candidates, c.id); });
  db.remove(C.elections, e.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- lifecycle
function readiness(e) {
  const problems = [];
  const positions = E.positionsOf(e.id);
  const cands = E.candidatesOf(e.id);
  if (!positions.length) problems.push('Add at least one position.');
  positions.forEach(p => { if (!cands.some(c => c.positionId === p.id)) problems.push(`${p.title} has no candidates.`); });
  if (!db.findAll(C.voters, v => v.electionId === e.id).length) problems.push('Add the voters’ list.');
  if (!e.openAt || !e.closeAt) problems.push('Set when polls open and close.');
  else if (new Date(e.closeAt) <= new Date()) problems.push('The closing time has already passed.');
  return problems;
}

router.post('/:id/submit', requireAuth, manage, h(async (req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Submitting');
  const problems = readiness(e);
  if (problems.length) throw new ElectionError('Not ready yet: ' + problems.join(' '));
  const u = E.setStatus(e, 'pending', { submittedAt: new Date().toISOString(), submittedBy: who(req), returnNote: null }, who(req), 'submitted', 'Sent to the Session Clerk for confirmation.');
  try {
    const push = require('../utils/push');
    push.sendPushToUsers(push.userIdsWithPermission('approvals.manage'), {
      title: 'Election to confirm', body: `${e.title} (${e.entityName}) is waiting for your confirmation.`, url: `/elections.html?id=${e.id}`,
    }).catch(() => {});
  } catch (err) {}
  res.json(E.publicElection(u));
}));

router.post('/:id/return', requireAuth, officer, h((req, res) => {
  const e = load(req);
  mustBe(e, ['pending', 'confirmed'], 'Returning to set-up');
  const note = String((req.body || {}).note || '').trim().slice(0, 500);
  const u = E.setStatus(e, 'draft', { returnNote: note || null }, who(req), 'returned', note ? `Returned for changes: ${note}` : 'Returned for changes.');
  res.json(E.publicElection(u));
}));

router.post('/:id/confirm', requireAuth, confirmer, h((req, res) => {
  const e = load(req);
  mustBe(e, ['pending'], 'Confirming');
  const problems = readiness(e);
  if (problems.length) throw new ElectionError('Cannot confirm: ' + problems.join(' '));
  const u = E.setStatus(e, 'confirmed', { confirmedAt: new Date().toISOString(), confirmedBy: who(req) }, who(req), 'confirmed',
    'Confirmed by the Session Clerk. Voters’ list and ballot are now locked.');
  res.json(E.publicElection(u));
}));

router.post('/:id/open', requireAuth, officer, h((req, res) => {
  const e = load(req);
  res.json(E.publicElection(E.openPolls(e, who(req))));
}));

router.post('/:id/close', requireAuth, officer, h((req, res) => {
  const e = load(req);
  res.json(E.publicElection(E.closePolls(e, who(req), 'Polls closed early by an officer.')));
}));

router.post('/:id/extend', requireAuth, officer, h((req, res) => {
  const e = load(req);
  mustBe(e, ['open', 'confirmed'], 'Changing the closing time');
  const closeAt = req.body && req.body.closeAt ? new Date(req.body.closeAt) : null;
  if (!closeAt || isNaN(closeAt) || closeAt <= new Date()) throw new ElectionError('Choose a closing time in the future.');
  const u = db.update(C.elections, e.id, { closeAt: closeAt.toISOString() });
  E.logEvent(e.id, 'extended', who(req), `Closing time changed to ${closeAt.toLocaleString('en-GB')}.`);
  E.changed(e.id, 'status');
  res.json(E.publicElection(u));
}));

// Names for the sign-off page of the report. Officers may fill these in at
// any stage until the results are certified.
router.put('/:id/signoff', requireAuth, officer, h((req, res) => {
  const e = load(req);
  if (e.status === 'certified') throw new ElectionError('The report names are fixed once the results are certified.', 409);
  const b = req.body || {};
  const signoff = { ...(e.signoff || {}) };
  for (const k of E.SIGNOFF_KEYS) if (b[k] !== undefined) signoff[k] = String(b[k] || '').trim().slice(0, 120);
  db.update(C.elections, e.id, { signoff });
  E.logEvent(e.id, 'signoff', who(req), 'Report sign-off names updated.');
  res.json({ signoff: E.signoffFor(E.getElection(e.id)) });
}));

// ---------------------------------------------------------------- polling officers
router.get('/:id/officers/options', requireAuth, manage, h((req, res) => {
  load(req);
  const { isDisabled } = require('../utils/accountStatus');
  const people = db.findAll('users', u => !u.linkedTo && !isDisabled(u))
    .map(u => ({ id: u.id, name: u.name, position: u.position || '' }))
    .filter(u => u.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(people);
}));
router.put('/:id/officers', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, ['draft', 'pending', 'confirmed', 'open'], 'Changing the polling officers');
  const ids = [...new Set(((req.body || {}).userIds || []).map(Number).filter(Boolean))].slice(0, 40);
  const officers = ids.map(id => db.findById('users', id)).filter(u => u && !u.linkedTo).map(u => ({ userId: u.id, name: u.name }));
  const before = new Set((e.officers || []).map(o => o.userId));
  db.update(C.elections, e.id, { officers });
  const added = officers.filter(o => !before.has(o.userId));
  const removed = (e.officers || []).filter(o => !ids.includes(o.userId));
  if (added.length || removed.length) {
    E.logEvent(e.id, 'officers', who(req), [added.length ? `Polling officers added: ${added.map(o => o.name).join(', ')}.` : '', removed.length ? `Removed: ${removed.map(o => o.name).join(', ')}.` : ''].filter(Boolean).join(' '));
  }
  if (added.length) {
    try {
      require('../utils/push').sendPushToUsers(added.map(o => o.userId), {
        title: 'You are a polling officer', body: `${e.title}: open the Polling Desk on election day to help voters who come without their phone.`, url: '/poll-desk.html',
      }).catch(() => {});
    } catch (err) {}
  }
  res.json({ officers });
}));

// ---------------------------------------------------------------- polling desk
const deskCtx = req => ({ ip: req.ip });
router.get('/:id/desk/status', requireAuth, h((req, res) => {
  const e = load(req); officerOf(req, e);
  res.json({ election: { id: e.id, title: e.title, entityName: e.entityName, status: E.isOpenNow(e) ? 'open' : e.status, closeAt: e.closeAt, verifyDob: !!e.verifyDob }, ...E.deskStatus(e) });
}));
router.post('/:id/desk/lookup', requireAuth, h((req, res) => {
  const e = load(req);
  res.json(E.deskLookup(e, (req.body || {}).phone, officerOf(req, e), deskCtx(req)));
}));
router.post('/:id/desk/release', requireAuth, h((req, res) => {
  const e = load(req);
  res.json(E.deskRelease(e, req.body || {}, officerOf(req, e), deskCtx(req)));
}));
router.post('/:id/desk/cancel', requireAuth, h((req, res) => {
  const e = load(req);
  res.json(E.deskCancel(e, (req.body || {}).boothId, officerOf(req, e)));
}));

router.post('/:id/certify', requireAuth, confirmer, h((req, res) => {
  const e = load(req);
  mustBe(e, ['closed'], 'Certifying');
  const u = E.setStatus(e, 'certified', { certifiedAt: new Date().toISOString(), certifiedBy: who(req) }, who(req), 'certified', 'Results certified by the Session Clerk.');
  res.json(E.publicElection(u));
}));

router.post('/:id/send-codes', requireAuth, officer, h(async (req, res) => {
  const e = load(req);
  if (!E.isOpenNow(e)) throw new ElectionError('Codes can only be sent while polls are open.', 409);
  E.sendCodes(e, { actor: who(req) }).catch(() => {});
  res.json({ ok: true, message: 'Sending codes to everyone who has none yet, or whose SMS failed.' });
}));

router.post('/:id/display/reset', requireAuth, manage, h((req, res) => {
  const e = load(req);
  const u = db.update(C.elections, e.id, { displayToken: E.rand(18) });
  E.logEvent(e.id, 'display-reset', who(req), 'Live display link replaced; old links stopped working.');
  res.json({ liveUrl: E.liveUrl(u) });
}));

// ---------------------------------------------------------------- ballot
router.post('/:id/positions', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Changing the ballot');
  const title = String((req.body || {}).title || '').trim().slice(0, 80);
  if (!title) throw new ElectionError('Name the position, e.g. President.');
  const seats = Math.max(1, Math.min(20, Number(req.body.seats) || 1));
  const order = E.positionsOf(e.id).length + 1;
  res.status(201).json(db.insert(C.positions, { electionId: e.id, title, seats, order }));
}));
function loadPos(req) {
  const p = db.findById(C.positions, Number(req.params.pid));
  if (!p) throw new ElectionError('Position not found.', 404);
  const e = E.getElection(p.electionId);
  mustBe(e, DRAFT, 'Changing the ballot');
  return { p, e };
}
router.put('/positions/:pid', requireAuth, manage, h((req, res) => {
  const { p } = loadPos(req);
  const patch = {};
  if (req.body.title !== undefined) { patch.title = String(req.body.title).trim().slice(0, 80); if (!patch.title) throw new ElectionError('The position needs a name.'); }
  if (req.body.seats !== undefined) patch.seats = Math.max(1, Math.min(20, Number(req.body.seats) || 1));
  if (req.body.order !== undefined) patch.order = Number(req.body.order) || 0;
  res.json(db.update(C.positions, p.id, patch));
}));
router.delete('/positions/:pid', requireAuth, manage, h((req, res) => {
  const { p } = loadPos(req);
  db.findAll(C.candidates, c => c.positionId === p.id).forEach(c => { E.deletePhoto(c.photoFile); db.remove(C.candidates, c.id); });
  db.remove(C.positions, p.id);
  res.json({ ok: true });
}));

router.post('/:id/candidates', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Changing the ballot');
  const p = db.findById(C.positions, Number((req.body || {}).positionId));
  if (!p || p.electionId !== e.id) throw new ElectionError('Choose the position.');
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) throw new ElectionError('Enter the candidate’s name.');
  let photoFile = null;
  if (req.body.photo) { photoFile = E.savePhoto(req.body.photo); if (!photoFile) throw new ElectionError('That picture could not be used. Try a JPEG or PNG photo.'); }
  const order = E.candidatesOf(e.id).filter(c => c.positionId === p.id).length + 1;
  res.status(201).json(db.insert(C.candidates, { electionId: e.id, positionId: p.id, name, photoFile, photoV: photoFile ? Date.now() : null, order }));
}));
function loadCand(req) {
  const c = db.findById(C.candidates, Number(req.params.cid));
  if (!c) throw new ElectionError('Candidate not found.', 404);
  mustBe(E.getElection(c.electionId), DRAFT, 'Changing the ballot');
  return c;
}
router.put('/candidates/:cid', requireAuth, manage, h((req, res) => {
  const c = loadCand(req);
  const patch = {};
  if (req.body.name !== undefined) { patch.name = String(req.body.name).replace(/\s+/g, ' ').trim().slice(0, 80); if (!patch.name) throw new ElectionError('The candidate needs a name.'); }
  if (req.body.photo !== undefined) {
    if (req.body.photo === '') { E.deletePhoto(c.photoFile); patch.photoFile = null; }
    else {
      const f = E.savePhoto(req.body.photo);
      if (!f) throw new ElectionError('That picture could not be used. Try a JPEG or PNG photo.');
      E.deletePhoto(c.photoFile); patch.photoFile = f; patch.photoV = Date.now();
    }
  }
  if (req.body.order !== undefined) patch.order = Number(req.body.order) || 0;
  res.json(db.update(C.candidates, c.id, patch));
}));
router.delete('/candidates/:cid', requireAuth, manage, h((req, res) => {
  const c = loadCand(req);
  E.deletePhoto(c.photoFile);
  db.remove(C.candidates, c.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- voters
router.get('/:id/voters', requireAuth, view, h((req, res) => {
  const e = load(req);
  const turnout = new Map(E.turnoutRows(e.id).map(t => [t.voterId, t]));
  const booths = new Map(db.findAll(C.booths, b => b.electionId === e.id).map(b => [b.id, b.name]));
  res.json(db.findAll(C.voters, v => v.electionId === e.id).sort((a, b) => a.name.localeCompare(b.name)).map(v => {
    const t = turnout.get(v.id);
    return {
      id: v.id, name: v.name, phone: v.phone, dob: v.dob, memberNo: v.memberNo, source: v.source,
      codeIssuedAt: v.codeIssuedAt, sms: v.sms, resends: v.resends || 0,
      locked: !!(v.lockedUntil && new Date(v.lockedUntil) > new Date()),
      voted: t ? { at: t.at, channel: t.channel, booth: t.boothId ? booths.get(t.boothId) || 'Booth' : null } : null,
    };
  }));
}));

// Review before saving: from the group's members, an uploaded file, or rows.
router.post('/:id/voters/preview', requireAuth, manage, h(async (req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Changing the voters’ list');
  const b = req.body || {};
  let rows;
  if (b.source === 'members') rows = E.rowsFromMembers(e);
  else if (b.file && b.file.base64) rows = await E.parseVoterFile(Buffer.from(String(b.file.base64), 'base64'), b.file.name);
  else if (Array.isArray(b.rows)) rows = b.rows;
  else throw new ElectionError('Nothing to check.');
  const checked = E.reviewRows(e, rows);
  res.json({ rows: checked, ok: checked.filter(r => r.status === 'ok').length, problems: checked.filter(r => r.status !== 'ok').length });
}));

router.post('/:id/voters/import', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Changing the voters’ list');
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  const source = ['members', 'excel', 'manual'].includes(req.body.source) ? req.body.source : 'excel';
  const r = E.addVoters(e, rows, source);
  E.logEvent(e.id, 'voters-added', who(req), `${r.added} voter(s) added (${source}).${r.refused.length ? ` ${r.refused.length} refused.` : ''}`);
  E.changed(e.id, 'voters');
  res.json(r);
}));

router.post('/:id/voters', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Changing the voters’ list');
  const r = E.addVoters(e, [{ ...(req.body || {}), line: 1 }], 'manual');
  if (!r.added) throw new ElectionError(r.refused[0] ? r.refused[0].issues.join('; ') : 'Not added.');
  E.logEvent(e.id, 'voters-added', who(req), `${String(req.body.name || '').trim()} added by hand.`);
  E.changed(e.id, 'voters');
  res.status(201).json(r);
}));

router.delete('/:id/voters', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Changing the voters’ list');
  const all = db.findAll(C.voters, v => v.electionId === e.id);
  all.forEach(v => db.remove(C.voters, v.id));
  E.logEvent(e.id, 'voters-cleared', who(req), `Voters’ list cleared (${all.length}).`);
  res.json({ removed: all.length });
}));

function loadVoter(req, e) {
  const v = db.findById(C.voters, Number(req.params.vid));
  if (!v || v.electionId !== e.id) throw new ElectionError('Voter not found.', 404);
  return v;
}
router.delete('/:id/voters/:vid', requireAuth, manage, h((req, res) => {
  const e = load(req);
  mustBe(e, DRAFT, 'Changing the voters’ list');
  const v = loadVoter(req, e);
  db.remove(C.voters, v.id);
  E.logEvent(e.id, 'voter-removed', who(req), `${v.name} removed from the list.`);
  res.json({ ok: true });
}));

// While the list is open for changes, anything can be corrected. After the
// Clerk has confirmed it, only a phone number can be fixed — with a reason,
// logged, and (if polls are open) a fresh code sent to the new number.
router.put('/:id/voters/:vid', requireAuth, officer, h(async (req, res) => {
  const e = load(req);
  const v = loadVoter(req, e);
  const b = req.body || {};
  if (e.status === 'draft') {
    if (!canManage(req)) throw new ElectionError('Only the election officer can edit the list.', 403);
    const patch = {};
    if (b.name !== undefined) { patch.name = String(b.name).replace(/\s+/g, ' ').trim(); if (!patch.name) throw new ElectionError('The voter needs a name.'); }
    if (b.phone !== undefined) {
      const p = E.canonPhone(b.phone);
      if (!p) throw new ElectionError('Not a valid Ghana mobile number.');
      if (db.findOne(C.voters, x => x.electionId === e.id && x.phone === p && x.id !== v.id)) throw new ElectionError('Another voter already has that number.');
      patch.phone = p;
    }
    if (b.dob !== undefined) { patch.dob = b.dob ? E.normDate(b.dob) : null; if (b.dob && !patch.dob) throw new ElectionError('Date of birth not understood.'); }
    if (b.memberNo !== undefined) patch.memberNo = E.normMemberNo(b.memberNo);
    return res.json(db.update(C.voters, v.id, patch));
  }
  if (['closed', 'certified'].includes(e.status)) throw new ElectionError('The election is over; the list can no longer change.', 409);
  const p = E.canonPhone(b.phone);
  const reason = String(b.reason || '').trim();
  if (!p) throw new ElectionError('Only the phone number can be corrected now. Enter a valid Ghana mobile number.');
  if (!reason) throw new ElectionError('Say why the number is being changed — it goes in the election report.');
  if (E.hasVoted(e.id, v.id)) throw new ElectionError('This person has already voted.', 409);
  if (db.findOne(C.voters, x => x.electionId === e.id && x.phone === p && x.id !== v.id)) throw new ElectionError('Another voter already has that number.');
  db.update(C.voters, v.id, { phone: p, codeHash: null, sms: null, failed: 0, lockedUntil: null });
  E.logEvent(e.id, 'phone-corrected', who(req), `${v.name}: phone changed from ${E.maskPhone(v.phone)} to ${E.maskPhone(p)}. Reason: ${reason}`);
  let sms = null;
  if (E.isOpenNow(e)) sms = await E.issueCode(e, db.findById(C.voters, v.id), who(req));
  E.changed(e.id, 'voters');
  res.json({ ok: true, sms });
}));

router.post('/:id/voters/:vid/resend', requireAuth, officer, h(async (req, res) => {
  const e = load(req);
  const v = loadVoter(req, e);
  if (!E.isOpenNow(e)) throw new ElectionError('Codes can only be sent while polls are open.', 409);
  if (E.hasVoted(e.id, v.id)) throw new ElectionError('This person has already voted.', 409);
  if ((v.resends || 0) >= E.MAX_RESENDS) throw new ElectionError(`Already resent ${E.MAX_RESENDS} times. Check the number with the voter.`, 429);
  db.update(C.voters, v.id, { resends: (v.resends || 0) + 1 });
  const status = await E.issueCode(e, v, who(req));
  E.logEvent(e.id, 'code-resent', who(req), `New code sent to ${v.name} (${E.maskPhone(v.phone)}): ${status}.`);
  E.changed(e.id, 'sms');
  res.json({ status });
}));

router.post('/:id/voters/:vid/unlock', requireAuth, officer, h((req, res) => {
  const e = load(req);
  const v = loadVoter(req, e);
  db.update(C.voters, v.id, { lockedUntil: null, failed: 0 });
  E.logEvent(e.id, 'unlocked', who(req), `${v.name} unlocked.`);
  res.json({ ok: true });
}));

router.get('/:id/voters/template.xlsx', requireAuth, view, h(async (req, res) => {
  const e = load(req);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Voters');
  ws.columns = [
    { header: 'Name', key: 'name', width: 32 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Date of birth', key: 'dob', width: 16 },
    { header: 'Member No.', key: 'memberNo', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getColumn('phone').numFmt = '@'; // keep the leading 0
  ws.addRow({ name: 'Ama Mensah (example — delete this row)', phone: '0244123456', dob: '14/03/1999', memberNo: '1001' });
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="voters-template-${e.slug}.xlsx"`);
  res.send(Buffer.from(buf));
}));

// ---------------------------------------------------------------- booths
router.post('/:id/booths', requireAuth, manage, h((req, res) => {
  const e = load(req);
  if (['closed', 'certified'].includes(e.status)) throw new ElectionError('The election is over.', 409);
  const name = String((req.body || {}).name || '').trim().slice(0, 40) || `Booth ${db.findAll(C.booths, b => b.electionId === e.id).length + 1}`;
  const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const b = db.insert(C.booths, { electionId: e.id, name, token: E.rand(12), enabled: true, pinV: 1 });
  db.update(C.booths, b.id, { pinHash: E.boothPinHash(e, b.id, pin) });
  E.logEvent(e.id, 'booth-added', who(req), `${name} added.`);
  E.changed(e.id, 'booths');
  res.status(201).json({ id: b.id, name, token: b.token, pin });
}));
function loadBooth(req) {
  const b = db.findById(C.booths, Number(req.params.bid));
  if (!b) throw new ElectionError('Booth not found.', 404);
  return { b, e: E.getElection(b.electionId) };
}
router.put('/booths/:bid', requireAuth, officer, h((req, res) => {
  const { b, e } = loadBooth(req);
  const patch = {};
  if (req.body.name !== undefined) patch.name = String(req.body.name).trim().slice(0, 40) || b.name;
  if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
  const u = db.update(C.booths, b.id, patch);
  if (patch.enabled !== undefined && patch.enabled !== !!b.enabled) E.logEvent(e.id, patch.enabled ? 'booth-on' : 'booth-off', who(req), `${u.name} switched ${patch.enabled ? 'on' : 'off'}.`);
  E.changed(e.id, 'booths');
  res.json({ id: u.id, name: u.name, enabled: !!u.enabled });
}));
router.post('/booths/:bid/pin', requireAuth, manage, h((req, res) => {
  const { b, e } = loadBooth(req);
  const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.update(C.booths, b.id, { pinHash: E.boothPinHash(e, b.id, pin), pinV: (b.pinV || 1) + 1 });
  E.logEvent(e.id, 'booth-pin', who(req), `${b.name}: new PIN issued; the laptop must be unlocked again.`);
  res.json({ pin });
}));
router.delete('/booths/:bid', requireAuth, manage, h((req, res) => {
  const { b, e } = loadBooth(req);
  if (E.turnoutRows(e.id).some(t => t.boothId === b.id)) throw new ElectionError('Votes were cast at this booth, so it stays in the record. Switch it off instead.', 409);
  db.remove(C.booths, b.id);
  E.logEvent(e.id, 'booth-removed', who(req), `${b.name} removed.`);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- results & report
router.get('/:id/results', requireAuth, view, h((req, res) => {
  res.json(E.snapshot(load(req), { forAdmin: true }));
}));

async function sendReport(req, res, kind) {
  const e = load(req);
  if (!['closed', 'certified'].includes(e.status)) throw new ElectionError('The report is available once polls have closed.', 409);
  const R = require('../utils/electionReport');
  const data = R.reportData(e);
  const buf = kind === 'pdf' ? await R.buildPdf(data) : await R.buildDocx(data);
  const name = `Election-Report-${e.slug}.${kind}`;
  res.setHeader('Content-Type', kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `${kind === 'pdf' ? 'inline' : 'attachment'}; filename="${name}"`);
  res.send(buf);
}
router.get('/:id/report.pdf', requireAuth, view, h((req, res) => sendReport(req, res, 'pdf')));
router.get('/:id/report.docx', requireAuth, view, h((req, res) => sendReport(req, res, 'docx')));

module.exports = router;
