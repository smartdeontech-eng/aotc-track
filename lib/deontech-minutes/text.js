// Words, times and dates as minutes write them.
'use strict';

// A value the clerk has not captured yet prints as a visible blank, so the gap
// is obvious on the page rather than a wrong sentence being written round it.
const BLANK = '__________';
function or(v, fallback) {
  const s = v == null ? '' : String(v).trim();
  return s || (fallback === undefined ? BLANK : fallback);
}
// A full stop only where one is missing ("6:53 pm" needs one; "p.m." has it).
function stop(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return /[.!?]$/.test(s) ? s : s + '.';
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
function roman(n) { return ROMAN[n - 1] || String(n); }

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// A bare 'YYYY-MM-DD' is a calendar DAY, read as local midnight. new Date() on
// it gives midnight UTC, which prints as the day before west of Greenwich.
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function toLocalDate(v) {
  if (v instanceof Date) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return new Date(NaN);
  const m = DATE_ONLY_RE.exec(s);
  if (!m) return new Date(s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
// "Thursday, 24th September 2026"; { upper } for titles, { comma } after the day.
function longDate(iso, opts = {}) {
  if (!iso) return '';
  const d = toLocalDate(iso);
  if (isNaN(d)) return String(iso);
  const s = `${d.toLocaleDateString('en-GB', { weekday: 'long' })}${opts.comma ? ',' : ''} ${ordinal(d.getDate())} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
  return opts.upper ? s.toUpperCase() : s;
}
// "24th September 2026"
function ordinalDate(iso) {
  const d = toLocalDate(iso);
  if (!iso || isNaN(d)) return String(iso || '');
  return `${ordinal(d.getDate())} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
}

// ---- the clock --------------------------------------------------------------
function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
function fmtTime(mins) {
  const total = ((mins % 1440) + 1440) % 1440;
  const h24 = Math.floor(total / 60), mi = total % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  let h = h24 % 12; if (h === 0) h = 12;
  return `${h}:${String(mi).padStart(2, '0')} ${ampm}`;
}
// Whatever was typed or stamped ("6.32 p.m.", "6:32PM", "18:32") prints as
// "6:32 pm". Anything that does not look like a time is left as written.
function minuteTime(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return s;
  let m = /^(\d{1,2})[.:](\d{2})\s*([ap])\.?\s*m\.?$/i.exec(s);
  if (m) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 12) return `${h}:${m[2]} ${m[3].toLowerCase()}m`;
  }
  m = /^(\d{1,2})[.:](\d{2})$/.exec(s);
  if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return fmtTime(Number(m[1]) * 60 + Number(m[2]));
  return s;
}
// Agenda rows { mins, item, responsible, subItems } timed from the start:
// changing one duration re-times everything after it.
function computeAgenda(rows, startTime) {
  let clock = parseTime(startTime);
  return (Array.isArray(rows) ? rows : []).map(r => {
    const mins = Number(r.mins) > 0 ? Number(r.mins) : 0;
    const at = clock == null ? '' : fmtTime(clock);
    const label = mins ? `${at} (${mins} min${mins === 1 ? '' : 's'})` : at;
    if (clock != null) clock += mins;
    return { ...r, at, mins, label };
  });
}

// ---- paragraphs, points and labelled lines ----------------------------------
// A body is split into lines. Lines marked "-", "*" or "•" are points; so is
// every line after one ending in ":" up to a blank line (when nothing in the
// body is marked). A line opening with one of the LABELS ("Decision:",
// "Motion:") is set apart, its label in italics, and is what the decisions
// register reads.
const BULLET_MARK = /^\s*[-*•–—]\s+/;
const LABELS = ['Decision:', 'Motion:'];
const labelOf = (line) => LABELS.find((l) => line.startsWith(l) && /\S/.test(line.slice(l.length)));
function bulletise(body) {
  const lines = String(body == null ? '' : body).split('\n');
  const marked = lines.some(l => BULLET_MARK.test(l));
  const out = [];
  let listing = false;
  lines.forEach(raw => {
    const line = raw.trim();
    if (!line) { listing = false; return; }
    if (BULLET_MARK.test(raw)) {
      out.push({ bullet: true, text: line.replace(BULLET_MARK, '').trim() });
      return;
    }
    const label = labelOf(line);
    if (label && /^\s/.test(line.slice(label.length))) {
      out.push({ bullet: false, decision: label === 'Decision:', motion: label === 'Motion:', label, text: line });
      listing = false;
      return;
    }
    if (!marked && listing) { out.push({ bullet: true, text: line }); return; }
    out.push({ bullet: false, text: line });
    if (!marked && /:$/.test(line)) listing = true;
  });
  return out.filter(x => x.text);
}

module.exports = {
  BLANK, or, stop, roman, ordinal, toLocalDate, longDate, ordinalDate,
  parseTime, fmtTime, minuteTime, computeAgenda, bulletise, LABELS,
};
