// AOTC Track — Elections engine (Oct 2026).
//
// Group elections (YPG, YAF, Women's Fellowship …) are run by CLAN, led by the
// CLAN Coordinator (elections.manage), and confirmed by the Session Clerk
// (approvals.manage) before polls open. The Clerk also certifies the result.
//
//   draft ──submit──▶ pending ──confirm (Clerk)──▶ confirmed ──open──▶ open ──close──▶ closed ──certify──▶ certified
//     ▲                  │                            │
//     └──── return ──────┴────────────────────────────┘   (before polls open only)
//
// SECRET BALLOT — the governing rule of this file. Two things are recorded and
// they are never joined:
//   election_turnout  WHO voted: voter, channel, booth, IP, time. One row per
//                     voter per election — the PRIMARY KEY is what makes a
//                     second vote impossible, even from two booths at once.
//   election_tally    WHAT was chosen: running totals per option. No voter, no
//                     booth, no time — so no one, admins included, can say who
//                     voted for whom.
// Both are written in ONE transaction, so a vote is either fully counted and
// recorded as cast, or neither.
//
// CODES: one 6-digit code per voter, sent by SMS when polls open. Only a hash
// is stored (salted with the election's secret and the voter id). Codes stop
// working the moment polls close. Five wrong tries lock that voter for 15 min.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const db = require('./db');

const C = {
  elections: 'elections',
  positions: 'election_positions',
  candidates: 'election_candidates',
  voters: 'election_voters',
  booths: 'election_booths',
  events: 'election_events',
  attempts: 'election_attempts',
  assists: 'election_assists',
};

const CODE_TRIES = 5;           // wrong codes before a lock
const LOCK_MIN = 15;            // lock length
const SESSION_MIN = 15;         // time to finish the ballot after verifying
const BOOTH_KEY_HOURS = 18;     // a booth stays unlocked for one polling day
const MAX_RESENDS = 5;

// Live updates (same pattern as DeonTech Pulse's bus + /api/stream).
const bus = new EventEmitter();
bus.setMaxListeners(1000);
function changed(electionId, what) { bus.emit('change', { electionId: Number(electionId), what, at: Date.now() }); }

// ---------------------------------------------------------------- tables
let tablesReady = false;
function sql() {
  if (!tablesReady) {
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS election_turnout (
        election_id INTEGER NOT NULL, voter_id INTEGER NOT NULL,
        channel TEXT NOT NULL, booth_id INTEGER, ip TEXT, ua TEXT, at TEXT NOT NULL,
        PRIMARY KEY (election_id, voter_id));
      CREATE TABLE IF NOT EXISTS election_tally (
        election_id INTEGER NOT NULL, position_id INTEGER NOT NULL, option TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (election_id, position_id, option));
      CREATE TABLE IF NOT EXISTS election_session (
        token TEXT PRIMARY KEY, election_id INTEGER NOT NULL, voter_id INTEGER NOT NULL,
        stage TEXT NOT NULL, channel TEXT NOT NULL, booth_id INTEGER, ip TEXT,
        expires TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, second_fails INTEGER NOT NULL DEFAULT 0);
    `);
    // Added after the first build: which officer-assisted release (if any) a
    // voting session came from.
    if (!db.sql.all('PRAGMA table_info(election_session)').some(c => c.name === 'assist_id')) {
      db.sql.exec('ALTER TABLE election_session ADD COLUMN assist_id INTEGER');
    }
    tablesReady = true;
  }
  return db.sql;
}

// ---------------------------------------------------------------- small helpers
const nowIso = () => new Date().toISOString();
const rand = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
class ElectionError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

// Ghana numbers: stored as 10 digits with the trunk 0 (0244123456). Accepts
// +233…, 233…, spaces, dashes, and the 9-digit form Excel leaves behind when it
// drops a leading 0 from a number cell.
function canonPhone(v) {
  let d = String(v == null ? '' : v).replace(/\.0+$/, '').replace(/\D/g, '');
  if (d.startsWith('233') && d.length === 12) d = '0' + d.slice(3);
  if (d.length === 9) d = '0' + d;
  return /^0[2-5]\d{8}$/.test(d) ? d : null;
}
function maskPhone(p) { const s = String(p || ''); return s.length >= 10 ? s.slice(0, 3) + '****' + s.slice(-3) : s; }

// Dates of birth: day-first (as written in Ghana) unless clearly ISO.
function normDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 1000 && v < 80000) { // an Excel serial day
    const d = new Date(Math.round((v - 25569) * 86400000));
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let y, m, d, mm;
  if ((mm = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/))) {
    d = +mm[1]; m = +mm[2]; y = +mm[3];
    if (y < 100) { const cur = new Date().getFullYear() % 100; y += y > cur ? 1900 : 2000; }
  } else {
    const t = new Date(s);
    if (isNaN(t)) return null;
    return t.toISOString().slice(0, 10);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt > new Date()) return null;
  return dt.toISOString().slice(0, 10);
}
const normMemberNo = v => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');

function publicElection(e) {
  if (!e) return null;
  const { secret, ...rest } = e;
  return rest;
}
function getElection(id) { return db.findById(C.elections, Number(id)); }
function bySlug(slug) { return db.findOne(C.elections, e => e.slug === String(slug || '').toLowerCase()); }
function byDisplay(token) { return token ? db.findOne(C.elections, e => e.displayToken === String(token)) : null; }

function logEvent(electionId, type, actor, detail) {
  try {
    db.insert(C.events, { electionId: Number(electionId), at: nowIso(), type, actor: actor || 'System', detail: detail || '' });
  } catch (e) { console.error('[elections] event log failed:', e.message); }
}
function logAttempt(electionId, rec) {
  try { db.insert(C.attempts, { electionId: Number(electionId), at: nowIso(), ...rec }); } catch (e) {}
}

function appUrl() { return String(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''); }
function voteUrl(e) { return `${appUrl()}/v/${e.slug}`; }
function liveUrl(e) { return `${appUrl()}/live/${e.displayToken}`; }

function isOpenNow(e) {
  if (!e || e.status !== 'open') return false;
  return !e.closeAt || new Date(e.closeAt) > new Date();
}

// ---------------------------------------------------------------- ballot
function positionsOf(electionId) {
  return db.findAll(C.positions, p => p.electionId === Number(electionId))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.id - b.id);
}
function candidatesOf(electionId) {
  return db.findAll(C.candidates, c => c.electionId === Number(electionId))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.id - b.id);
}
// A position with no more candidates than seats is unopposed: each candidate
// gets a Yes / No vote rather than walking in.
function modeOf(pos, cands) { return cands.length <= (pos.seats || 1) ? 'yesno' : 'pick'; }
function photoUrl(c) { return c.photoFile ? `/api/vote/photo/${c.id}?v=${encodeURIComponent(c.photoV || '1')}` : null; }

function ballotFor(e) {
  const cands = candidatesOf(e.id);
  return positionsOf(e.id).map(p => {
    let list = cands.filter(c => c.positionId === p.id);
    if (e.shuffle && list.length > 1) {
      list = list.slice();
      for (let i = list.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [list[i], list[j]] = [list[j], list[i]]; }
    }
    return {
      id: p.id, title: p.title, seats: p.seats || 1, mode: modeOf(p, list),
      candidates: list.map(c => ({ id: c.id, name: c.name, photo: photoUrl(c) })),
    };
  }).filter(p => p.candidates.length);
}

// Turn the voter's choices into tally options, refusing anything malformed.
//   pick:  choices[posId] = [candidateId, …] (≤ seats, distinct) — [] = skip
//   yesno: choices[posId] = { [candidateId]: 'yes' | 'no' } — missing = skip
function tallyOptions(e, choices) {
  const out = [];
  const cands = candidatesOf(e.id);
  for (const p of positionsOf(e.id)) {
    const list = cands.filter(c => c.positionId === p.id);
    if (!list.length) continue;
    const ids = new Set(list.map(c => c.id));
    const raw = choices ? choices[p.id] ?? choices[String(p.id)] : undefined;
    if (modeOf(p, list) === 'pick') {
      const picked = Array.isArray(raw) ? [...new Set(raw.map(Number))] : [];
      if (picked.some(id => !ids.has(id))) throw new ElectionError(`A choice for ${p.title} is not on the ballot.`);
      if (picked.length > (p.seats || 1)) throw new ElectionError(`${p.title}: choose at most ${p.seats || 1}.`);
      if (!picked.length) out.push([p.id, 'skip']);
      picked.forEach(id => out.push([p.id, `c:${id}`]));
    } else {
      const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      for (const c of list) {
        const v = obj[c.id] ?? obj[String(c.id)];
        if (v === 'yes' || v === 'no') out.push([p.id, `${v}:${c.id}`]);
        else if (v == null || v === '' || v === 'skip') out.push([p.id, `skip:${c.id}`]);
        else throw new ElectionError(`${p.title}: answer Yes or No.`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- results
function tallyRows(electionId) {
  return sql().all('SELECT position_id AS pid, option, n FROM election_tally WHERE election_id = ?', Number(electionId));
}
function turnoutRows(electionId) {
  return sql().all('SELECT voter_id AS voterId, channel, booth_id AS boothId, ip, ua, at FROM election_turnout WHERE election_id = ? ORDER BY at', Number(electionId));
}
function hasVoted(electionId, voterId) {
  return !!sql().get('SELECT 1 AS x FROM election_turnout WHERE election_id = ? AND voter_id = ?', Number(electionId), Number(voterId));
}

function results(e) {
  const rows = tallyRows(e.id);
  const get = (pid, opt) => (rows.find(r => r.pid === pid && r.option === opt) || {}).n || 0;
  const ballots = sql().get('SELECT COUNT(*) AS n FROM election_turnout WHERE election_id = ?', e.id).n;
  const cands = candidatesOf(e.id);
  return positionsOf(e.id).map(p => {
    const list = cands.filter(c => c.positionId === p.id);
    const mode = modeOf(p, list);
    const pct = n => ballots ? Math.round((n / ballots) * 1000) / 10 : 0;
    if (mode === 'pick') {
      const options = list.map(c => ({ candidateId: c.id, name: c.name, photo: photoUrl(c), votes: get(p.id, `c:${c.id}`) }))
        .map(o => ({ ...o, pct: pct(o.votes) }))
        .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
      const seats = p.seats || 1;
      // Leaders: top `seats`, but a tie at the cut-off is reported, not settled.
      const cut = options[seats - 1] ? options[seats - 1].votes : null;
      const tieAtCut = cut != null && cut > 0 && options.filter(o => o.votes === cut).length > options.slice(0, seats).filter(o => o.votes === cut).length;
      options.forEach((o, i) => { o.leading = i < seats && o.votes > 0 && !(tieAtCut && o.votes === cut); });
      return { id: p.id, title: p.title, seats, mode, ballots, skipped: get(p.id, 'skip'), options, tieAtCut };
    }
    const options = list.map(c => {
      const yes = get(p.id, `yes:${c.id}`), no = get(p.id, `no:${c.id}`), skip = get(p.id, `skip:${c.id}`);
      return { candidateId: c.id, name: c.name, photo: photoUrl(c), yes, no, skip, yesPct: pct(yes), noPct: pct(no), carried: yes > no };
    });
    return { id: p.id, title: p.title, seats: p.seats || 1, mode, ballots, options };
  });
}

// What a live screen or the admin page may show. Tallies are shown while polls
// are open only when the election was set to 'full' live mode.
function snapshot(e, { forAdmin = false } = {}) {
  const eligible = db.findAll(C.voters, v => v.electionId === e.id).length;
  const turnout = turnoutRows(e.id);
  const booths = db.findAll(C.booths, b => b.electionId === e.id).sort((a, b) => a.id - b.id);
  const byBooth = booths.map(b => ({ id: b.id, name: b.name, enabled: !!b.enabled, votes: turnout.filter(t => t.boothId === b.id).length }));
  const showTally = e.liveMode === 'full' || ['closed', 'certified'].includes(e.status);
  const hours = {};
  turnout.forEach(t => { const h = t.at.slice(0, 13); hours[h] = (hours[h] || 0) + 1; });
  return {
    election: {
      id: e.id, title: e.title, entityName: e.entityName || '', status: e.status,
      openAt: e.openAt, closeAt: e.closeAt, openedAt: e.openedAt || null, closedAt: e.closedAt || null,
      liveMode: e.liveMode || 'turnout',
    },
    eligible, voted: turnout.length,
    turnoutPct: eligible ? Math.round((turnout.length / eligible) * 1000) / 10 : 0,
    byChannel: { online: turnout.filter(t => t.channel === 'online').length, booth: turnout.filter(t => t.channel === 'booth').length },
    booths: byBooth,
    byHour: Object.entries(hours).sort().map(([h, n]) => ({ hour: h, n })),
    lastVoteAt: turnout.length ? turnout[turnout.length - 1].at : null,
    showTally,
    results: showTally ? results(e) : null,
    serverTime: nowIso(),
    ...(forAdmin ? { liveUrl: liveUrl(e), voteUrl: voteUrl(e) } : {}),
  };
}

// ---------------------------------------------------------------- voters list
const HEADERS = {
  memberNo: /member\s*(no|number|#|id)|membership\s*(no|number)|^id\s*(no|number)?$|^m\/?no$/i,
  dob: /\bdob\b|date\s*of\s*birth|birth\s*date|birthday|^birth$/i,
  phone: /phone|mobile|tel|contact|cell|whatsapp/i,
  name: /^(full\s*)?names?$|member\s*name|voter|^name\b|full\s*name/i,
};
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v.text != null) return v.text;
    if (v.result != null) return v.result;
    if (v.hyperlink) return v.text || v.hyperlink;
    return '';
  }
  return v;
}

// Read an uploaded .xlsx or .csv into plain rows {name, phone, dob, memberNo}.
async function parseVoterFile(buffer, filename) {
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b; // 'PK' = xlsx
  let grid = [];
  if (isZip) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new ElectionError('The workbook has no sheets.');
    ws.eachRow({ includeEmpty: false }, row => {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { vals[col - 1] = cellText(cell.value); });
      grid.push(vals);
    });
  } else if (/\.csv$/i.test(filename || '') || buffer.indexOf(0) === -1) {
    grid = parseCsv(buffer.toString('utf8'));
  } else {
    throw new ElectionError('Upload an Excel (.xlsx) or CSV file.');
  }
  // The header row: the first row (of the first 6) naming a phone column.
  let hi = grid.slice(0, 6).findIndex(r => r.some(c => typeof c === 'string' && HEADERS.phone.test(c)));
  if (hi < 0) throw new ElectionError('Could not find the header row. The sheet needs columns named Name and Phone (Date of birth and Member No. are optional).');
  const head = grid[hi].map(c => String(c || '').trim());
  const col = {};
  head.forEach((h, i) => {
    if (!h) return;
    for (const key of ['memberNo', 'dob', 'phone', 'name']) {
      if (col[key] == null && HEADERS[key].test(h)) { col[key] = i; break; }
    }
  });
  if (col.name == null || col.phone == null) throw new ElectionError('The sheet needs a Name column and a Phone column.');
  return grid.slice(hi + 1)
    .map((r, i) => ({
      line: hi + i + 2,
      name: String(cellText(r[col.name]) || '').trim(),
      phone: String(cellText(r[col.phone]) ?? '').trim(),
      dob: col.dob != null ? cellText(r[col.dob]) : null,
      memberNo: col.memberNo != null ? String(cellText(r[col.memberNo]) ?? '').trim() : '',
    }))
    .filter(r => r.name || r.phone);
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Check rows before anything is saved. One voter per phone (user's decision):
// a number used twice in the file, or already on the list, is refused.
function reviewRows(e, rows) {
  const existing = new Map(db.findAll(C.voters, v => v.electionId === e.id).map(v => [v.phone, v]));
  const seen = new Map();
  return rows.map((r, i) => {
    const issues = [];
    const name = String(r.name || '').replace(/\s+/g, ' ').trim();
    const phone = canonPhone(r.phone);
    const dob = r.dob == null || r.dob === '' ? null : normDate(r.dob);
    const memberNo = normMemberNo(r.memberNo);
    if (!name) issues.push('no name');
    if (!r.phone) issues.push('no phone number');
    else if (!phone) issues.push(`"${r.phone}" is not a valid Ghana mobile number`);
    if (r.dob != null && r.dob !== '' && !dob) issues.push(`date of birth "${r.dob instanceof Date ? r.dob.toISOString().slice(0, 10) : r.dob}" not understood`);
    if (e.verifyDob && !dob && !issues.some(x => x.startsWith('date'))) issues.push('date of birth needed (this election checks it)');
    if (e.verifyMemberNo && !memberNo) issues.push('member number needed (this election checks it)');
    let status = issues.length ? 'error' : 'ok';
    if (phone) {
      if (existing.has(phone)) { status = 'duplicate'; issues.push(`number already on the list (${existing.get(phone).name})`); }
      else if (seen.has(phone)) { status = 'duplicate'; issues.push(`same number as ${seen.get(phone)} above`); }
      else seen.set(phone, name || `row ${r.line || i + 1}`);
    }
    return { line: r.line || i + 1, name, phone: phone || String(r.phone || ''), dob, memberNo, memberId: r.memberId || null, status, issues };
  });
}

function rowsFromMembers(e) {
  if (!e.entity || !['group', 'committee'].includes(e.entity.type)) {
    throw new ElectionError('Choose the group (or committee) this election is for, then its members can be loaded.');
  }
  return db.findAll('members', m => m.entityType === e.entity.type && Number(m.entityId) === Number(e.entity.id))
    .map((m, i) => ({ line: i + 1, name: m.name, phone: m.phone || '', dob: m.dob || m.dateOfBirth || null, memberNo: m.memberNo != null ? String(m.memberNo) : '', memberId: m.id }));
}

function addVoters(e, rows, source) {
  const checked = reviewRows(e, rows);
  const ok = checked.filter(r => r.status === 'ok');
  ok.forEach(r => db.insert(C.voters, {
    electionId: e.id, name: r.name, phone: r.phone, dob: r.dob || null, memberNo: r.memberNo || '',
    memberId: r.memberId || null, source, codeHash: null, codeIssuedAt: null, resends: 0,
    sms: null, failed: 0, lockedUntil: null,
  }));
  return { added: ok.length, refused: checked.filter(r => r.status !== 'ok') };
}

// ---------------------------------------------------------------- codes & SMS
function codeHash(e, voterId, code) { return sha(`${e.secret}:${voterId}:${code}`); }
function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function closeLabel(e) {
  if (!e.closeAt) return 'close';
  const d = new Date(e.closeAt);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '');
  return sameDay ? time : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}
function smsText(e, code) {
  const t = String(e.smsTitle || e.title || 'Election').slice(0, 38);
  return `PCG-AOTC: ${t} voting is open till ${closeLabel(e)}. Your code: ${code}. Vote: ${voteUrl(e)}`;
}

// Issue a fresh code to one voter and text it. The previous code stops working.
async function issueCode(e, voter, actor) {
  const { sendSms } = require('./sms');
  const code = newCode();
  db.update(C.voters, voter.id, { codeHash: codeHash(e, voter.id, code), codeIssuedAt: nowIso(), sms: { status: 'sending', at: nowIso() } });
  let status = 'sent', error = null;
  try {
    const r = await sendSms({ to: voter.phone, message: smsText(e, code) });
    if (r && r.error) { status = 'failed'; error = String(r.error); }
    else if (r && r.skipped) { status = 'skipped'; error = String(r.skipped); }
  } catch (err) { status = 'failed'; error = err.message; }
  // Without an SMS gateway (a laptop), show the code in the server log so the
  // flow can be tried end to end. Never in production.
  if (status === 'skipped' && process.env.NODE_ENV !== 'production') {
    console.log(`[elections] (no SMS gateway) code for ${voter.name} ${voter.phone}: ${code}`);
  }
  db.update(C.voters, voter.id, { sms: { status, at: nowIso(), error } });
  return status;
}

let sending = new Set();
async function sendCodes(e, { actor = 'System', onlyMissing = true } = {}) {
  if (sending.has(e.id)) return { busy: true };
  sending.add(e.id);
  const tally = { sent: 0, failed: 0, skipped: 0 };
  try {
    const voters = db.findAll(C.voters, v => v.electionId === e.id && (!onlyMissing || !v.codeHash || (v.sms && v.sms.status === 'failed')));
    for (const v of voters) {
      const fresh = getElection(e.id);
      if (!isOpenNow(fresh)) break; // closed while sending
      if (hasVoted(e.id, v.id)) continue;
      const s = await issueCode(fresh, v, actor);
      tally[s] = (tally[s] || 0) + 1;
      changed(e.id, 'sms');
    }
  } finally { sending.delete(e.id); }
  logEvent(e.id, 'codes-sent', actor, `Codes sent: ${tally.sent} delivered to the gateway, ${tally.failed} failed, ${tally.skipped} not sent (no gateway).`);
  return tally;
}

// ---------------------------------------------------------------- lifecycle
function setStatus(e, status, patch, actor, type, detail) {
  const updated = db.update(C.elections, e.id, { status, ...patch });
  logEvent(e.id, type, actor, detail);
  changed(e.id, 'status');
  return updated;
}
function openPolls(e, actor = 'System') {
  if (e.status !== 'confirmed') throw new ElectionError('Only an election confirmed by the Session Clerk can be opened.');
  if (e.closeAt && new Date(e.closeAt) <= new Date()) throw new ElectionError('The closing time has already passed — set a new closing time first.');
  const u = setStatus(e, 'open', { openedAt: nowIso(), openedBy: actor }, actor, 'opened', 'Polls opened.');
  // Codes go out in the background; the page shows progress.
  sendCodes(u, { actor }).catch(err => console.error('[elections] sending codes failed:', err.message));
  return u;
}
function closePolls(e, actor = 'System', reason = '') {
  if (e.status !== 'open') throw new ElectionError('Polls are not open.');
  sql().run('UPDATE election_session SET used = 1 WHERE election_id = ? AND used = 0', e.id);
  return setStatus(e, 'closed', { closedAt: nowIso(), closedBy: actor }, actor, 'closed', reason || 'Polls closed.');
}

// Runs on the live line only (server.js startJobs). Opens and closes polls on
// time; idempotent.
let timer = null;
function tick() {
  try {
    const now = new Date();
    for (const e of db.findAll(C.elections, x => x.status === 'confirmed' || x.status === 'open')) {
      if (e.status === 'confirmed' && e.openAt && new Date(e.openAt) <= now) {
        try { openPolls(e, 'Scheduled'); } catch (err) { logEvent(e.id, 'error', 'Scheduled', `Could not open: ${err.message}`); }
      } else if (e.status === 'open' && e.closeAt && new Date(e.closeAt) <= now) {
        try { closePolls(e, 'Scheduled', 'Polls closed at the set closing time.'); } catch (err) {}
      }
    }
    // Housekeeping: drop finished ballot sessions older than a day.
    sql().run("DELETE FROM election_session WHERE expires < ?", new Date(Date.now() - 86400000).toISOString());
  } catch (err) { console.error('[elections] scheduler:', err.message); }
}
function startScheduler() {
  if (timer) return;
  tick();
  timer = setInterval(tick, 15000);
  timer.unref();
}

// ---------------------------------------------------------------- booths
function boothPinHash(e, boothId, pin) { return sha(`${e.secret}:booth:${boothId}:${pin}`); }
function boothKey(e, booth) {
  const exp = Date.now() + BOOTH_KEY_HOURS * 3600000;
  const body = `${booth.id}.${exp}.${booth.pinV || 1}`;
  return `${body}.${crypto.createHmac('sha256', e.secret).update(body).digest('base64url')}`;
}
// The booth a request comes from, or null. A booth switched off, or whose PIN
// was changed, stops being accepted at once.
function boothFromKey(e, key) {
  const parts = String(key || '').split('.');
  if (parts.length !== 4) return null;
  const [id, exp, v, sig] = parts;
  const body = `${id}.${exp}.${v}`;
  const want = crypto.createHmac('sha256', e.secret).update(body).digest('base64url');
  if (!safeEq(sig, want) || Number(exp) < Date.now()) return null;
  const b = db.findById(C.booths, Number(id));
  if (!b || b.electionId !== e.id || !b.enabled || String(b.pinV || 1) !== v) return null;
  return b;
}

// ---------------------------------------------------------------- voting
const ipFails = new Map(); // ip -> [timestamps] of failed verifications (online only)
function ipBlocked(ip) {
  const cut = Date.now() - 10 * 60000;
  const list = (ipFails.get(ip) || []).filter(t => t > cut);
  ipFails.set(ip, list);
  return list.length >= 30;
}
function ipFail(ip) { const l = ipFails.get(ip) || []; l.push(Date.now()); ipFails.set(ip, l); }

function startSession(e, voter, stage, ctx, assistId = null) {
  const token = rand(24);
  sql().run('INSERT INTO election_session (token, election_id, voter_id, stage, channel, booth_id, ip, expires, assist_id) VALUES (?,?,?,?,?,?,?,?,?)',
    token, e.id, voter.id, stage, ctx.channel, ctx.boothId || null, ctx.ip || '', new Date(Date.now() + SESSION_MIN * 60000).toISOString(), assistId);
  return token;
}
function needsOf(e) { return [e.verifyDob ? 'dob' : null, e.verifyMemberNo ? 'memberNo' : null].filter(Boolean); }

function verifyCode(e, { phone, code }, ctx) {
  if (!isOpenNow(e)) throw new ElectionError(e.status === 'open' || ['closed', 'certified'].includes(e.status) ? 'Polls are closed.' : 'Polls are not open yet.', 403);
  if (ctx.channel === 'online' && ipBlocked(ctx.ip)) throw new ElectionError('Too many wrong attempts from this network. Please wait ten minutes.', 429);
  const p = canonPhone(phone);
  const fail = (reason, msg, status = 400, extra) => {
    logAttempt(e.id, { reason, phone: p || String(phone || '').slice(0, 20), channel: ctx.channel, boothId: ctx.boothId || null, ip: ctx.ip || '' });
    if (ctx.channel === 'online') ipFail(ctx.ip);
    throw new ElectionError(msg, status, extra);
  };
  if (!p) fail('bad-phone', 'Enter the phone number the code was sent to, e.g. 0244123456.');
  const voter = db.findOne(C.voters, v => v.electionId === e.id && v.phone === p);
  if (!voter) fail('not-on-list', 'That number is not on the voters’ list for this election. Please see an election officer.', 404);
  if (hasVoted(e.id, voter.id)) fail('already-voted', 'A vote has already been cast with this number.', 409);
  if (voter.lockedUntil && new Date(voter.lockedUntil) > new Date()) {
    fail('locked', `Too many wrong codes. Try again after ${new Date(voter.lockedUntil).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' })}, or see an election officer.`, 423);
  }
  if (!voter.codeHash) fail('no-code', 'No code has been sent to this number yet. Please wait a moment, or see an election officer.', 409);
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== 6 || !safeEq(codeHash(e, voter.id, given), voter.codeHash)) {
    const failed = (voter.failed || 0) + 1;
    const lock = failed >= CODE_TRIES;
    db.update(C.voters, voter.id, { failed: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null });
    if (lock) { logEvent(e.id, 'locked', 'System', `${voter.name} (${maskPhone(voter.phone)}) locked for ${LOCK_MIN} minutes after ${CODE_TRIES} wrong codes.`); changed(e.id, 'lock'); }
    fail('wrong-code', lock ? `Wrong code. This number is now locked for ${LOCK_MIN} minutes.` : `Wrong code. ${CODE_TRIES - failed} ${CODE_TRIES - failed === 1 ? 'try' : 'tries'} left.`, 401);
  }
  if (voter.failed) db.update(C.voters, voter.id, { failed: 0 });
  const needs = needsOf(e);
  const token = startSession(e, voter, needs.length ? 'second' : 'ready', ctx);
  return { token, name: voter.name, needs, ballot: needs.length ? null : ballotFor(e) };
}

function sessionRow(e, token) {
  const s = sql().get('SELECT * FROM election_session WHERE token = ?', String(token || ''));
  if (!s || s.election_id !== e.id || s.used || new Date(s.expires) < new Date()) {
    throw new ElectionError('This voting session has ended. Please start again with your phone number.', 410);
  }
  return s;
}

function confirmSecond(e, { token, dob, memberNo }, ctx) {
  if (!isOpenNow(e)) throw new ElectionError('Polls are closed.', 403);
  const s = sessionRow(e, token);
  if (s.stage !== 'second') throw new ElectionError('Nothing to confirm.', 409);
  const voter = db.findById(C.voters, s.voter_id);
  const okDob = !e.verifyDob || (voter.dob && normDate(dob) === voter.dob);
  const okNo = !e.verifyMemberNo || (voter.memberNo && normMemberNo(memberNo) === voter.memberNo);
  if (!okDob || !okNo) {
    const fails = s.second_fails + 1;
    sql().run('UPDATE election_session SET second_fails = ?, used = ? WHERE token = ?', fails, fails >= 3 ? 1 : 0, s.token);
    logAttempt(e.id, { reason: 'wrong-second-check', phone: voter.phone, channel: ctx.channel, boothId: ctx.boothId || null, ip: ctx.ip || '' });
    throw new ElectionError(fails >= 3 ? 'The details did not match. Please see an election officer.' : `Those details don’t match our list. ${3 - fails} ${3 - fails === 1 ? 'try' : 'tries'} left.`, 401);
  }
  sql().run("UPDATE election_session SET stage = 'ready' WHERE token = ?", s.token);
  return { token: s.token, name: voter.name, ballot: ballotFor(e) };
}

// Cast: the one place a vote is counted. Everything inside one transaction.
function castVote(e, { token, choices }, ctx) {
  const options = tallyOptions(e, choices || {});
  const s = sql();
  let voterId, assistId;
  db.transaction(() => {
    const fresh = db.findById(C.elections, e.id);
    if (!isOpenNow(fresh)) throw new ElectionError('Polls closed before this ballot was cast. It was not counted.', 403);
    const row = s.get('SELECT * FROM election_session WHERE token = ?', String(token || ''));
    if (!row || row.election_id !== e.id || row.used || new Date(row.expires) < new Date()) {
      throw new ElectionError('This voting session has ended. Please start again with your phone number.', 410);
    }
    if (row.stage !== 'ready') throw new ElectionError('Finish the identity check first.', 409);
    // A ballot an officer released can only be cast on the booth it went to.
    if (row.assist_id && (ctx.channel !== 'booth' || Number(ctx.boothId) !== Number(row.booth_id))) {
      throw new ElectionError('This ballot was released to a different booth.', 403);
    }
    const r = s.run('INSERT OR IGNORE INTO election_turnout (election_id, voter_id, channel, booth_id, ip, ua, at) VALUES (?,?,?,?,?,?,?)',
      e.id, row.voter_id, ctx.channel, ctx.boothId || null, ctx.ip || '', String(ctx.ua || '').slice(0, 200), nowIso());
    if (!r.changes) throw new ElectionError('A vote has already been cast with this number.', 409);
    for (const [pid, opt] of options) {
      s.run('INSERT INTO election_tally (election_id, position_id, option, n) VALUES (?,?,?,1) ON CONFLICT (election_id, position_id, option) DO UPDATE SET n = n + 1', e.id, pid, opt);
    }
    s.run('UPDATE election_session SET used = 1 WHERE election_id = ? AND voter_id = ?', e.id, row.voter_id);
    voterId = row.voter_id;
    assistId = row.assist_id || null;
  });
  if (ctx.boothId) { try { db.update(C.booths, ctx.boothId, { lastVoteAt: nowIso() }); } catch (err) {} }
  if (assistId) assistDone(e, assistId).catch(err => console.error('[elections] assist notice failed:', err.message));
  changed(e.id, 'vote');
  return { ok: true, voterId };
}


// ---------------------------------------------------------------- polling desk
// A voter who comes to the booth without their phone goes to a polling
// officer. The officer (named for this election, signed in as themselves)
// takes the voter's phone number — it must be on the list — and then either
// checks the date of birth the voter states against the list, or confirms
// they know the person (with a note). The officer then RELEASES the ballot to
// a booth: no code is read out, and the officer never sees the ballot. When
// the vote is cast, the voter's phone gets an SMS saying so, so anyone who
// voted in someone else's name is found out the same day.
const DESK_TRIES = 3;           // wrong dates of birth at the desk before a pause
const DESK_LOCK_MIN = 15;
const RELEASE_MIN = 5;          // a released ballot waits this long at the booth

const primaryId = u => (u ? (u.linkedTo ? Number(u.linkedTo) : Number(u.id)) : null);
function isOfficer(e, user) {
  const pid = primaryId(user);
  return !!pid && (e.officers || []).some(o => Number(o.userId) === pid);
}
function boothPending(b) {
  return b && b.pending && new Date(b.pending.expires) > new Date() ? b.pending : null;
}
function deskVoter(e, phone, officer, ctx) {
  if (!isOpenNow(e)) throw new ElectionError('Polls are not open.', 403);
  const p = canonPhone(phone);
  const fail = (reason, msg, status = 400) => {
    logAttempt(e.id, { reason, phone: p || String(phone || '').slice(0, 20), channel: 'desk', boothId: null, ip: ctx.ip || '', officer: officer.name });
    throw new ElectionError(msg, status);
  };
  if (!p) fail('bad-phone', 'Enter the voter’s phone number, e.g. 0244123456.');
  const voter = db.findOne(C.voters, v => v.electionId === e.id && v.phone === p);
  if (!voter) fail('not-on-list', 'That number is not on the voters’ list. The person cannot vote with it.', 404);
  if (hasVoted(e.id, voter.id)) fail('already-voted', `${voter.name} has already voted.`, 409);
  if (voter.deskLockedUntil && new Date(voter.deskLockedUntil) > new Date()) {
    fail('locked', `Too many wrong dates of birth for ${voter.name}. Try again after ${new Date(voter.deskLockedUntil).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' })}, or ask the CLAN Coordinator.`, 423);
  }
  return voter;
}
function deskLookup(e, phone, officer, ctx) {
  const v = deskVoter(e, phone, officer, ctx);
  return { voterId: v.id, name: v.name, phone: maskPhone(v.phone), dobOnList: !!v.dob };
}
function deskRelease(e, body, officer, ctx) {
  const voter = deskVoter(e, body.phone, officer, ctx);
  const method = body.method === 'known' ? 'known' : body.method === 'dob' ? 'dob' : null;
  if (!method) throw new ElectionError('Choose how you checked the person: date of birth, or you know them personally.');
  let note = String(body.note || '').trim().slice(0, 200);
  if (method === 'dob') {
    if (!voter.dob) throw new ElectionError('No date of birth is on the list for this person. Use “I know this person” if you do, or ask the CLAN Coordinator.', 409);
    const given = normDate(body.dob);
    if (!given || given !== voter.dob) {
      const fails = (voter.deskFails || 0) + 1;
      const lock = fails >= DESK_TRIES;
      db.update(C.voters, voter.id, { deskFails: lock ? 0 : fails, deskLockedUntil: lock ? new Date(Date.now() + DESK_LOCK_MIN * 60000).toISOString() : null });
      logAttempt(e.id, { reason: 'desk-wrong-dob', phone: voter.phone, channel: 'desk', boothId: null, ip: ctx.ip || '', officer: officer.name });
      if (lock) logEvent(e.id, 'locked', officer.name, `${voter.name} (${maskPhone(voter.phone)}) paused at the polling desk for ${DESK_LOCK_MIN} minutes after ${DESK_TRIES} wrong dates of birth.`);
      throw new ElectionError(lock ? `That date of birth does not match. ${voter.name} is paused at the desk for ${DESK_LOCK_MIN} minutes.` : `That date of birth does not match the list. ${DESK_TRIES - fails} ${DESK_TRIES - fails === 1 ? 'try' : 'tries'} left.`, 401);
    }
    note = '';
  } else if (note.length < 3) {
    throw new ElectionError('Say how you know this person (e.g. “same Bible study group”). It goes in the report.');
  }
  if (voter.deskFails) db.update(C.voters, voter.id, { deskFails: 0 });
  const booth = db.findById(C.booths, Number(body.boothId));
  if (!booth || booth.electionId !== e.id) throw new ElectionError('Choose the booth the voter will use.');
  if (!booth.enabled) throw new ElectionError(`${booth.name} is switched off.`, 423);
  const waiting = boothPending(booth);
  if (waiting && waiting.voterId !== voter.id) throw new ElectionError(`${booth.name} is still waiting for ${waiting.name}. Wait until they have started, or cancel that release.`, 409);
  const a = db.insert(C.assists, {
    electionId: e.id, voterId: voter.id, voterName: voter.name, phone: voter.phone,
    boothId: booth.id, boothName: booth.name, officerId: primaryId(officer), officerName: officer.name,
    method, note, releasedAt: nowIso(), pickedUpAt: null, castAt: null, ip: ctx.ip || '',
  });
  const token = startSession(e, voter, 'ready', { channel: 'booth', boothId: booth.id, ip: ctx.ip || '' }, a.id);
  db.update(C.booths, booth.id, { pending: { token, voterId: voter.id, name: voter.name, assistId: a.id, at: nowIso(), expires: new Date(Date.now() + RELEASE_MIN * 60000).toISOString() } });
  logEvent(e.id, 'desk-release', officer.name, `Ballot released to ${booth.name} for ${voter.name} (${maskPhone(voter.phone)}) — checked: phone number and ${method === 'dob' ? 'date of birth' : `known personally (${note})`}.`);
  changed(e.id, 'desk');
  return { assistId: a.id, booth: booth.name, name: voter.name };
}
function deskCancel(e, boothId, officer) {
  const b = db.findById(C.booths, Number(boothId));
  if (!b || b.electionId !== e.id) throw new ElectionError('Booth not found.', 404);
  const p = boothPending(b);
  db.update(C.booths, b.id, { pending: null });
  if (p) {
    sql().run('UPDATE election_session SET expires = ? WHERE token = ?', nowIso(), p.token);
    db.update(C.assists, p.assistId, { cancelledAt: nowIso() });
    logEvent(e.id, 'desk-cancel', officer.name, `Release to ${b.name} for ${p.name} cancelled.`);
  }
  changed(e.id, 'desk');
  return { ok: true };
}
// The booth asks (every few seconds while it shows the phone screen) whether
// an officer has released a ballot to it. A release is handed over once.
function boothPickup(e, booth) {
  const p = boothPending(booth);
  if (!p || !isOpenNow(e)) return { waiting: false };
  db.update(C.booths, booth.id, { pending: null });
  if (hasVoted(e.id, p.voterId)) return { waiting: false };
  db.update(C.assists, p.assistId, { pickedUpAt: nowIso() });
  changed(e.id, 'desk');
  return { waiting: true, token: p.token, name: p.name, ballot: ballotFor(e) };
}
function deskStatus(e) {
  const booths = db.findAll(C.booths, b => b.electionId === e.id).sort((a, b) => a.id - b.id)
    .map(b => { const p = boothPending(b); return { id: b.id, name: b.name, enabled: !!b.enabled, waitingFor: p ? p.name : null }; });
  const recent = db.findAll(C.assists, a => a.electionId === e.id).slice(-12).reverse()
    .map(a => ({ id: a.id, name: a.voterName, booth: a.boothName, officer: a.officerName, method: a.method, releasedAt: a.releasedAt,
      state: a.castAt ? 'voted' : hasVoted(e.id, a.voterId) ? 'voted elsewhere' : a.cancelledAt ? 'cancelled'
        : a.pickedUpAt ? (Date.parse(a.pickedUpAt) + SESSION_MIN * 60000 < Date.now() ? 'did not finish' : 'voting')
        : (Date.parse(a.releasedAt) + RELEASE_MIN * 60000 < Date.now() ? 'not picked up' : 'waiting at booth') }));
  return { booths, recent };
}
async function assistDone(e, assistId) {
  const a = db.findById(C.assists, assistId);
  if (!a) return;
  const at = nowIso();
  db.update(C.assists, a.id, { castAt: at });
  const t = String(e.smsTitle || e.title || 'Election').slice(0, 38);
  const when = new Date(at).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Africa/Accra' });
  const message = `PCG-AOTC: Your vote in ${t} was cast at ${a.boothName} at ${when} after a polling officer checked your details. If this was not you, contact the Session Clerk now.`;
  let status = 'sent';
  try {
    const { sendSms } = require('./sms');
    const r = await sendSms({ to: a.phone, message });
    if (r && r.error) status = 'failed'; else if (r && r.skipped) status = 'skipped';
  } catch (err) { status = 'failed'; }
  db.update(C.assists, a.id, { noticeSms: status });
}

// ---------------------------------------------------------------- photos
const PHOTO_DIR = path.join(db.DATA_DIR, 'election-photos');
function savePhoto(dataUrl) {
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 1.5 * 1024 * 1024) return null;
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const file = `c-${crypto.randomBytes(10).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
  return file;
}
function photoPath(file) {
  if (!file || /[\\/]/.test(file)) return null;
  const p = path.join(PHOTO_DIR, file);
  return fs.existsSync(p) ? p : null;
}
function deletePhoto(file) { const p = photoPath(file); if (p) { try { fs.unlinkSync(p); } catch (e) {} } }

// ---------------------------------------------------------------- new election
function slugFor(title) {
  const base = String(title || 'election').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'election';
  let s;
  do { s = `${base}-${crypto.randomBytes(2).toString('hex')}`; } while (bySlug(s));
  return s;
}

// ---------------------------------------------------------------- report sign-off
// CLAN writes the report on behalf of the group. It is signed by the group's
// President, witnessed by another executive of the group; approved by the CLAN
// Coordinator, witnessed by a CLAN committee member; and validated by the
// Session Clerk. Names are kept on the election; blanks are filled from what
// the app already knows (the group's President from its members list, the
// officer who set the election up, the Clerk who certified it).
const SIGNOFF_KEYS = ['president', 'groupWitness', 'groupWitnessRole', 'clanCoordinator', 'clanWitness', 'sessionClerk'];
function presidentOf(e) {
  if (!e.entity || !['group', 'committee'].includes(e.entity.type)) return '';
  const m = db.findAll('members', x => x.entityType === e.entity.type && Number(x.entityId) === Number(e.entity.id) && x.active !== false)
    .find(x => /\bpresident\b/i.test(x.position || '') && !/vice|deputy|past|former/i.test(x.position || ''));
  return m ? m.name : '';
}
function signoffFor(e) {
  const s = e.signoff || {};
  return {
    president: s.president || presidentOf(e),
    groupWitness: s.groupWitness || '',
    groupWitnessRole: s.groupWitnessRole || '',
    clanCoordinator: s.clanCoordinator || e.createdBy || '',
    clanWitness: s.clanWitness || '',
    sessionClerk: s.sessionClerk || e.certifiedBy || '',
  };
}

module.exports = {
  C, bus, changed, ElectionError, sql,
  canonPhone, maskPhone, normDate, normMemberNo,
  publicElection, getElection, bySlug, byDisplay, logEvent, logAttempt,
  voteUrl, liveUrl, isOpenNow, positionsOf, candidatesOf, ballotFor, modeOf,
  results, snapshot, turnoutRows, tallyRows, hasVoted,
  parseVoterFile, reviewRows, rowsFromMembers, addVoters,
  issueCode, sendCodes, openPolls, closePolls, setStatus, startScheduler, tick,
  boothPinHash, boothKey, boothFromKey,
  verifyCode, confirmSecond, castVote,
  savePhoto, photoPath, deletePhoto, slugFor, rand, MAX_RESENDS,
  SIGNOFF_KEYS, presidentOf, signoffFor,
  isOfficer, primaryId, deskLookup, deskRelease, deskCancel, deskStatus, boothPickup, boothPending,
};
