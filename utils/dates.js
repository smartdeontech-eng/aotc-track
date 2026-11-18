// Calendar days vs instants.
//
// A bare 'YYYY-MM-DD' is a calendar DAY. `new Date('2026-08-30')` parses it as
// midnight UTC, so on any process whose timezone sits west of Greenwich every
// local-time formatter prints the day before — 30 August comes out as
// 29 August. Ghana keeps UTC year-round, so the deployed server happens to be
// safe, but nothing pinned that (see TZ in deploy/aotc-track.service) and a
// developer machine on a negative offset generated wrong PDFs and wrong SMS.
//
// Rule: a value that is only a day (date, dueDate, targetDate, marriageDate,
// signDate, …) goes through toLocalDate/fmtDay/fmtDayLong. A value that is an
// instant (createdAt, confirmedAt, lockedAt, …) is a real Date and does not.

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parse a date-only string as LOCAL midnight; pass anything else through.
function toLocalDate(v) {
  if (v instanceof Date) return v;
  const s = String(v == null ? '' : v).trim();
  // `new Date(null)` is 1 January 1970, not an invalid date, so an empty
  // dueDate would print as a real day. Hand back something that fails isNaN.
  if (!s) return new Date(NaN);
  const m = DATE_ONLY_RE.exec(s);
  if (!m) return new Date(s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function isDateOnly(v) {
  return DATE_ONLY_RE.test(String(v == null ? '' : v).trim());
}

// 'YYYY-MM-DD' read off a Date in LOCAL time. Use this instead of
// `.toISOString().slice(0, 10)`, which reports the UTC day.
function toDayKey(d) {
  const dt = toLocalDate(d);
  if (isNaN(dt)) return '';
  const p = n => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

// Is this calendar day a Sunday? Anchored in UTC and read back in UTC so the
// answer cannot depend on where the process is running.
function isSunday(v) {
  const s = String(v == null ? '' : v).trim();
  if (!DATE_ONLY_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.getUTCDay() === 0;
}

// "Sun, 30 Aug" — the short form used in notifications.
function fmtDay(v, opts) {
  const d = toLocalDate(v);
  if (isNaN(d)) return String(v == null ? '' : v);
  return d.toLocaleDateString('en-GB', opts || { weekday: 'short', day: 'numeric', month: 'short' });
}

// "30 August 2026" — how a day is named in headings and announcements.
function fmtDayLong(v, opts) {
  const d = toLocalDate(v);
  if (isNaN(d)) return String(v == null ? '' : v);
  return d.toLocaleDateString('en-GB', opts || { day: 'numeric', month: 'long', year: 'numeric' });
}

// Warn once at boot if this process would misread calendar days that any code
// still parses naively, and if the operator forgot to pin TZ. Ghana is UTC+0;
// a negative offset means someone is running the server on a laptop.
function assertTimezone(log) {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const zone = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '(unknown)';
  if (offsetMinutes < 0) {
    (log || console.warn)(
      `[dates] WARNING: process timezone is ${zone} (UTC${offsetMinutes / 60}). ` +
      'The congregation keeps Ghana time (UTC+0). Set TZ=Africa/Accra — see ' +
      'deploy/aotc-track.service — or dates in PDFs, SMS and reminders may read a day early.'
    );
  }
  return { zone, offsetMinutes };
}


// The congregation's internal reporting deadline for a quarter: the end of the
// 5th of the month after the quarter (the District's own deadline is the 7th).
// Q4 rolls into January of the following year — JS Date handles the overflow.
// Returned as a local-time Date so it lines up with how the dashboard and the
// reminder engine count days to the deadline.
function reportDueDate(year, quarter) {
  return new Date(Number(year), Number(quarter) * 3, 5, 23, 59, 59, 999);
}

module.exports = { reportDueDate, toLocalDate, isDateOnly, isSunday, toDayKey, fmtDay, fmtDayLong, assertTimezone, DATE_ONLY_RE };
