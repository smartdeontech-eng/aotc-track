// Member identity helpers (AOTC Track).
// Every member gets two stable identifiers:
//   - memberNo : a human-friendly unique number (starts at 1001) they can read
//                out if they've forgotten their card, printed on the card.
//   - qrToken  : the unguessable secret embedded in their QR code and in their
//                personal card link (/card.html?t=<qrToken>).
// Both are assigned once and never change.
const crypto = require('crypto');
const db = require('./db');

function randomToken() { return crypto.randomBytes(8).toString('hex'); }

// Next free member number, given an optional pre-read member list (so callers
// looping over many members don't re-read the file each time).
function nextMemberNo(list) {
  const members = list || db.findAll('members');
  return members.reduce((mx, r) => Math.max(mx, Number(r.memberNo) || 0), 1000) + 1;
}

// Ensure a single member has both a number and a token; persists + returns the
// (possibly updated) record. Safe to call repeatedly — a no-op once assigned.
function ensureIdentity(m) {
  if (!m) return m;
  const patch = {};
  if (!m.memberNo) patch.memberNo = nextMemberNo();
  if (!m.qrToken) patch.qrToken = randomToken();
  return Object.keys(patch).length ? db.update('members', m.id, patch) : m;
}

// One-shot backfill for members created before this feature. Idempotent:
// only touches records missing a number or token. Returns how many it fixed.
function backfillIdentities() {
  const members = db.findAll('members');
  let next = members.reduce((mx, r) => Math.max(mx, Number(r.memberNo) || 0), 1000) + 1;
  let fixed = 0;
  for (const m of members) {
    const patch = {};
    if (!m.memberNo) patch.memberNo = next++;
    if (!m.qrToken) patch.qrToken = randomToken();
    if (Object.keys(patch).length) { db.update('members', m.id, patch); fixed++; }
  }
  return fixed;
}

module.exports = { nextMemberNo, ensureIdentity, backfillIdentities, randomToken };
