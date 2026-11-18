// ---- Who held an office, and when ----
//
// A document is signed by whoever held the office ON THE DATE THE DOCUMENT IS
// ABOUT — not by whoever holds it on the day it happens to be printed.
//
// Before this, both signature lines were looked up live: the minutes took
// `byPosition('district minister')` from today's roster, and the quarterly
// report took `settings.minister`. Print the second-quarter report after a new
// District Minister is inducted and it came out over his name, for a quarter
// he was not here for. On minutes — the record of a court — that is not a
// cosmetic problem.
//
// So each office keeps a list of terms, and every printed name is a lookup by
// date. The Session Clerk, the Treasurer and the Senior Presbyter all change
// the same way, so they all get the same treatment.
//
// A term is a half-open interval: `from` is the day the person took office and
// counts as theirs; `to` is the day their successor took office and does NOT.
// A minister inducted on 14 September signs from the 14th; his predecessor
// signs up to the 13th. Both `from` and `to` may be null:
//
//   from: null   held the office from before the app's records begin. This is
//                what back-fill uses, so every document already in the system
//                resolves to the person who really signed it without anyone
//                having to invent a start date.
//   to:   null   still holds it.
const db = require('./db');
const { toDayKey } = require('./dates');

const COLLECTION = 'office_terms';

function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}
function isDay(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}
function dayOrNull(v) {
  const d = clean(v, 10);
  return isDay(d) ? d : null;
}

// Every term recorded for an office, oldest first. A term with no `from` sorts
// first, because it began before the record did.
function termsFor(officeKey) {
  return db.findAll(COLLECTION, t => t.officeKey === officeKey)
    .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
}

// Who held `officeKey` on `date`? Returns the term, or null.
// `date` is a calendar day ('YYYY-MM-DD'); anything else is coerced through
// toDayKey so a Date or an ISO instant works too.
function holderOn(officeKey, date) {
  const day = isDay(date) ? date : toDayKey(date);
  if (!day) return currentHolder(officeKey);
  const matches = termsFor(officeKey).filter(t =>
    (!t.from || t.from <= day) && (!t.to || day < t.to)
  );
  // Overlaps should not exist for a unique office, but if data is ever hand-
  // edited into one, the term that started latest is the better answer.
  return matches.length ? matches[matches.length - 1] : null;
}

function currentHolder(officeKey) {
  const open = termsFor(officeKey).filter(t => !t.to);
  return open.length ? open[open.length - 1] : null;
}

// The name to print for an office on a given date, or '' when the record does
// not know. Callers decide their own fallback.
function nameOn(officeKey, date) {
  const t = holderOn(officeKey, date);
  return (t && t.name) || '';
}

// Record that `member` took `officeKey` on `from`. Closes whatever term was
// open — the outgoing holder's term ends the day the new one begins — and
// returns { opened, closed }.
//
// The outgoing name is kept on the closed term rather than looked up later,
// because a minister who has been transferred is removed from the roster, and
// the minutes he confirmed must still print his name a year from now.
function confer(officeKey, member, from, extra = {}) {
  const day = dayOrNull(from) || toDayKey(new Date());
  const open = currentHolder(officeKey);
  let closed = null;
  if (open) {
    // Re-conferring on the same person is not a succession; just correct the date.
    if (Number(open.memberId) === Number(member && member.id) && member && member.id) {
      return { opened: db.update(COLLECTION, open.id, { from: day }), closed: null, unchanged: true };
    }
    closed = db.update(COLLECTION, open.id, { to: day });
  }
  const opened = db.insert(COLLECTION, {
    officeKey,
    memberId: member && member.id != null ? Number(member.id) : null,
    name: clean(member && member.name, 120),
    titles: Array.isArray(member && member.titles) ? member.titles.slice(0, 5) : [],
    from: day,
    to: null,
    note: clean(extra.note, 200),
  });
  return { opened, closed };
}

// End the open term without naming a successor — the office falls vacant.
function vacate(officeKey, on) {
  const open = currentHolder(officeKey);
  if (!open) return null;
  return db.update(COLLECTION, open.id, { to: dayOrNull(on) || toDayKey(new Date()) });
}

// Back-fill. Gives each office named in `holders` one open-ended term, so that
// every document already in the system resolves to the person who really
// signed it — without anyone having to decide when they started.
//
// Only ever creates a term for an office that has none; it will not overwrite
// a history that already exists, and it is safe to run more than once.
function seedFrom(holders) {
  const created = [];
  Object.entries(holders || {}).forEach(([officeKey, holder]) => {
    if (!holder || !clean(holder.name, 120)) return;
    if (termsFor(officeKey).length) return;
    created.push(db.insert(COLLECTION, {
      officeKey,
      memberId: holder.id != null ? Number(holder.id) : null,
      name: clean(holder.name, 120),
      titles: Array.isArray(holder.titles) ? holder.titles.slice(0, 5) : [],
      from: null,            // "since before the record began"
      to: null,
      note: 'Back-filled from the roster when office terms were introduced.',
    }));
  });
  return created;
}

// The day a quarter's report speaks to. A quarterly report is compiled once
// the quarter has closed, so the signature belongs to whoever was in office at
// the end of it — Q1 is 31 March, Q4 is 31 December.
function quarterEndDay(year, quarter) {
  const q = Math.min(4, Math.max(1, Number(quarter) || 1));
  return toDayKey(new Date(Number(year), q * 3, 0));
}

module.exports = {
  COLLECTION, termsFor, holderOn, currentHolder, nameOn,
  confer, vacate, seedFrom, quarterEndDay,
};
