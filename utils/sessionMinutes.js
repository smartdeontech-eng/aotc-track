// AOTC Track — Session minutes model.
//
// This module holds the SHAPE of a PCG-AOTC minutes document: who sits on the
// Session and in what order they are listed, which numbered sections a minutes
// document has, and the house-style sentences that write themselves when the
// clerk captures the times, movers and seconders.
//
// Nothing here touches the database or express — it is pure data + helpers, so
// it can be unit-tested on its own (see the checks run at build time).

const { toLocalDate } = require('./dates');
const MIN = require('./minutesLib');
const { BLANK, or, stop, roman, bulletise, minuteTime, parseTime, fmtTime, computeAgenda } = MIN;
const DECISION_LINE = /^Decision:\s+\S/;
// Visitors' paragraphs: the same file the Minutes page previews them with.
const VisitorsText = require('../public/js/visitors-text');

// ---- Roster order ----------------------------------------------------------
// Members Present / Apologies / Absent are ALL listed in one fixed order of
// seniority, never alphabetically. Each Session member carries an explicit
// `rank` integer; these constants only seed sensible starting ranks — the
// Session Clerk can renumber anybody afterwards from the Minutes page.
//
// Order confirmed by the Session Clerk:
//   District Minister → Associate Minister → Catechist E. A. Addo → other
//   Catechist(s) → Senior Presbyter → Session Clerk → Treasurer →
//   Kwaku Koranteng → Betty Dufie Owusu → everyone else.
const POSITIONS = [
  'District Minister',
  'Associate Minister',
  'Catechist',
  'Senior Presbyter',
  'Session Clerk',
  'Treasurer',
  'Member',
];

// ---- Offices of the Session -------------------------------------------------
// The Session is the highest court of the congregation, and it is constituted
// by AGENTS and PRESBYTERS.
//
//   Agents      the ordained and commissioned workers — the Reverend Ministers
//               and the Catechists. AOTC is the head station, so the minister
//               in charge is the District Minister. Only an agent may chair,
//               and therefore only an agent may constitute a meeting.
//   Presbyters  elected by the congregation. From among those elected, the
//               Senior Presbyter is the most senior; the Session Clerk and the
//               Treasurer are voted for by the presbyters themselves.
//   Co-opted    anyone the Session brings in to help with its work.
//
// Some offices below are not in the constitution — the Session and the
// congregation created them for themselves — so they are marked as such and
// never confer the standing that a constitutional office does.
const OFFICES = [
  { key: 'district_minister', label: 'District Minister', kind: 'agent', constitutional: true, unique: true,
    note: 'Minister in charge — AOTC is the head station' },
  { key: 'associate_minister', label: 'Associate Minister', kind: 'agent', constitutional: true, unique: true },
  { key: 'catechist', label: 'Catechist', kind: 'agent', constitutional: true, unique: false,
    note: 'The congregation has more than one' },
  { key: 'senior_presbyter', label: 'Senior Presbyter', kind: 'presbyter', constitutional: true, unique: true,
    note: 'The most senior of the elected presbyters' },
  { key: 'session_clerk', label: 'Session Clerk', kind: 'presbyter', constitutional: true, unique: true,
    note: 'Voted for by the presbyters elected onto the Session' },
  { key: 'treasurer', label: 'Treasurer', kind: 'presbyter', constitutional: true, unique: true,
    note: 'Voted for by the presbyters elected onto the Session' },
  { key: 'deputy_senior_presbyter', label: 'Deputy Senior Presbyter', kind: 'presbyter', constitutional: false, unique: true,
    note: 'The “shadow” Senior Presbyter — the Session’s own arrangement' },
  { key: 'assistant_session_clerk', label: 'Assistant Session Clerk', kind: 'presbyter', constitutional: false, unique: true,
    note: 'The Session’s own arrangement' },
  { key: 'linguist', label: 'Linguist', kind: 'presbyter', constitutional: false, unique: true,
    note: 'By convention of the congregation, receives visitors to the Session' },
];
const officeByKey = key => OFFICES.find(o => o.key === key) || null;

// How an office is written in the ROSTER of a meeting. Only the constitutional
// offices are named there: Deputy Senior Presbyter, Assistant Session Clerk and
// Linguist are the Session's own arrangements, not offices of the court, so a
// person holding one is listed simply as a MEMBER — as the congregation's own
// minutes have it. The office is still held, and still shown everywhere in the
// app; it is the printed roster that stays to the constitution.
function rosterPosition(position) {
  const pos = String(position || '').trim();
  if (!pos) return 'Member';
  const office = OFFICES.find(o => o.label.toLowerCase() === pos.toLowerCase());
  return office && !office.constitutional ? 'Member' : pos;
}

// ---- The register of outstanding matters ------------------------------------
// The Session carries things between meetings: a matter deferred to the next
// sitting, a request awaiting a decision, an instruction given to someone.
// Written into the minutes alone they are easy to lose, so they are also kept
// as a standing register that is worked through meeting after meeting until
// each one is genuinely cleared.
const MATTER_STATUSES = [
  { key: 'open', label: 'Open', note: 'Raised, nothing done yet' },
  { key: 'in-progress', label: 'In progress', note: 'Being worked on' },
  { key: 'decided', label: 'Decided', note: 'The Session has decided; the decision may still need carrying out' },
  { key: 'closed', label: 'Closed', note: 'Done and cleared' },
];
const OPEN_STATUSES = ['open', 'in-progress', 'decided'];
const isMatterOpen = m => OPEN_STATUSES.includes(String((m && m.status) || 'open'));
const matterStatus = key => MATTER_STATUSES.find(s => s.key === key) || MATTER_STATUSES[0];

// How long the Session has been carrying this, counted in its own meetings
// rather than in days — "raised four meetings ago" is what a Clerk feels.
function matterAge(matter, meetingDates) {
  const from = String((matter && matter.raisedAt) || '');
  if (!from) return 0;
  return (Array.isArray(meetingDates) ? meetingDates : [])
    .filter(d => String(d) > from).length;
}
// Long-carried or past its date: the two things worth putting in front of the
// Session rather than leaving buried in a list.
function matterFlag(matter, meetingDates, today) {
  if (!isMatterOpen(matter)) return '';
  const due = String((matter && matter.due) || '');
  if (due && today && due < today) return 'overdue';
  return matterAge(matter, meetingDates) >= 3 ? 'stale' : '';
}
// ---- Catch-all agenda items -------------------------------------------------
// Some agenda items are containers, not subjects. "Other Matters" holds the
// state of the washrooms and the security of the manse in the same breath, and
// carrying "Other Matters" onto the next agenda says nothing about either: it
// neither names the concern nor separates the two. So where the parent item is
// one of these, the heading is taken from the matter's own words instead, and
// the container label is never stored as a heading.
const CATCHALL_HEADINGS = [
  /^(any\s+)?other\s+(matters?|business)\b/i,
  /^a\.?o\.?b\.?$/i,
  /^matters?\s+arising\b/i,
  /^(general|misc\.?|miscellaneous|sundry)\s*(matters?|business|items?)?$/i,
  /^announcements?$/i,
  /^correspondence(\s+(read|received))?$/i,
  /^(opening|closing|adjournment|benediction|devotion|attendance)\b/i,
  /^(the\s+)?(agenda|minutes)\b/i,
];
function isCatchAllHeading(text) {
  const t = String(text || '').trim().replace(/^[\d.\s)]+/, '').replace(/[:.\s]+$/, '');
  if (!t) return false;
  return CATCHALL_HEADINGS.some(re => re.test(t));
}
// The minutes wrap a concern in a reporting frame — "It was reported that…",
// "A concern was raised about…". The frame is how the minutes narrate; it is
// never part of the concern, so both the heading and the sub-item label drop it.
function dropReportingFrame(text) {
  return String(text || '').replace(
    /^(it\s+was\s+(reported|noted|observed|raised|said|stated)\s+that|the\s+session\s+(was\s+informed|noted|observed)\s+that|a\s+concern\s+was\s+raised\s+(about|on|over)|concern\s+was\s+expressed\s+(about|on|over)|attention\s+was\s+drawn\s+to)\s+/i, '')
    .replace(/^(that|the|a|an)\s+/i, '');
}
// A heading built from the matter's own words, for when the parent item was a
// container. Short enough to sit on an agenda line and still name the area of
// concern: leading filler dropped, first clause only, six words at most.
function shortHeading(text, limit) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/^[\d.\s)]+/, '');
  t = dropReportingFrame(t);
  // First clause only — a heading is not a sentence.
  t = t.split(/[;:.,]|\bwhich\b|\bbecause\b|\bso\s+that\b|\band\s+that\b/i)[0].trim();
  t = t.replace(/^(that|the|a|an)\s+/i, '');
  // What is left usually reads "<the thing> <is doing something>". The area of
  // concern is the thing, not the predicate: cut at the verb and "the
  // washrooms at the chapel are in a poor state" becomes "Washrooms at the
  // chapel", which is what belongs on an agenda line. Truncating by word count
  // alone would have given "Washrooms at the chapel are in".
  const PREDICATE = /\s(?:is|are|was|were|be|been|being|has|have|had|needs?|needed|requires?|required|remains?|remained|should|must|will|would|could|shall|may|might|cannot|can|does|do|did|awaits?|awaited)\b/i;
  const cut = t.search(PREDICATE);
  if (cut > 0) {
    const head = t.slice(0, cut).trim();
    // Only take it if something substantial is left — "Quotas" is a heading,
    // an empty string is not.
    if (head.split(/\s+/).filter(Boolean).length >= 1 && head.length >= 4) t = head;
  }
  const words = t.split(' ').filter(Boolean).slice(0, 6);
  t = words.join(' ').replace(/[\s,;:.]+$/, '');
  const max = Number(limit) || 60;
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '');
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
// The label a matter carries beneath its heading. The minutes write an
// outstanding item as a full instruction — "Letter to contractor regarding
// reverting to original contract terms and requesting for meeting" — and the
// whole of that belongs in the detail, where the Session can read what was
// actually asked. But as a line under "Update on Building Project" it is too
// long to scan, and taking the first 80 characters cuts it mid-word.
//
// What distinguishes one sub-item from another is the act, not the
// qualification of it: "Letter to contractor" against "Seeking legal counsel".
// So the trailing qualifier is cut — the "regarding…", the "before…", the "with
// copies to…" — and the act is kept.
const SUBJECT_TRAILER = /\s(?:regarding|concerning|respecting|pending|before|after|whilst|while|in\s+respect\s+of|in\s+connection\s+with|as\s+regards|with\s+a\s+view|with\s+copies|and\s+(?:requesting|seeking|asking|informing|to)\b|so\s+as\s+to|in\s+order\s+to|for\s+the\s+purpose|following\s+the)\b/i;
function shortSubject(text, limit) {
  let t = String(text || '').replace(/\s+/g, ' ').trim().replace(/^[\d.\s)]+/, '');
  if (!t) return '';
  t = dropReportingFrame(t);
  t = t.split(/[;:]|\.\s/)[0].trim();
  const cut = t.search(SUBJECT_TRAILER);
  // Only take the cut if what is left still says something — "Letter" alone is
  // not a sub-item, "Letter to contractor" is.
  if (cut > 0) {
    const head = t.slice(0, cut).trim();
    if (head.split(/\s+/).filter(Boolean).length >= 2) t = head;
  }
  const max = Number(limit) || 70;
  const words = t.split(' ').filter(Boolean).slice(0, 9);
  t = words.join(' ').replace(/[\s,;:.]+$/, '');
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s,;:.]+$/, '');
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
// The heading to file a matter under, given the item's own subject and the
// parent item it sat beneath. Falls through the three in order of trust: the
// item's own subject, then the parent's, then — when both are containers — a
// heading composed from the body of the matter itself.
function headingFor(subject, parentSubject, body) {
  const own = String(subject || '').trim();
  if (own && !isCatchAllHeading(own)) return own;
  const parent = String(parentSubject || '').trim();
  if (parent && !isCatchAllHeading(parent)) return parent;
  return shortHeading(body || own || parent, 60);
}
// The heading a matter is gathered under. Falls back to the matter's own
// subject, so an entry typed straight into the register without a heading still
// reaches the agenda as itself rather than vanishing into a blank group. A
// container label is not a heading: it falls back too.
function matterHeading(m) {
  const h = String((m && m.heading) || '').trim();
  if (h && !isCatchAllHeading(h)) return h;
  const subject = String((m && m.subject) || '').trim();
  if (subject && !isCatchAllHeading(subject)) return subject;
  return shortHeading((m && m.detail) || subject || h, 60) || subject || h;
}
// The distinct headings across a set of matters, in the order first met, each
// with the matters beneath it. This is what the next agenda is built from: one
// sub-item per HEADING, not one per matter.
function groupByHeading(matters) {
  const order = [];
  const by = new Map();
  (Array.isArray(matters) ? matters : []).forEach(m => {
    const h = matterHeading(m);
    if (!h) return;
    const key = h.toLowerCase();
    if (!by.has(key)) { by.set(key, { heading: h, matters: [], owners: [] }); order.push(key); }
    const g = by.get(key);
    g.matters.push(m);
    const owner = String(m.owner || '').trim();
    if (owner && !g.owners.includes(owner)) g.owners.push(owner);
  });
  return order.map(k => {
    const g = by.get(k);
    // One owner across the group is the group's owner; several means the agenda
    // leaves it blank rather than naming one person for other people's work.
    return { ...g, owner: g.owners.length === 1 ? g.owners[0] : '' };
  });
}
function summariseMatters(matters, meetingDates, today) {
  const list = (Array.isArray(matters) ? matters : []).map(m => ({
    ...m,
    heading: matterHeading(m),
    statusLabel: matterStatus(m.status).label,
    age: matterAge(m, meetingDates),
    flag: matterFlag(m, meetingDates, today),
    open: isMatterOpen(m),
  }));
  return {
    matters: list,
    counts: MATTER_STATUSES.reduce((a, s) => {
      a[s.key] = list.filter(m => (m.status || 'open') === s.key).length;
      return a;
    }, {}),
    openCount: list.filter(m => m.open).length,
    headings: groupByHeading(list.filter(m => m.open)),
    flagged: list.filter(m => m.flag).length,
  };
}
// The open items already sitting in a set of minutes, shaped as register
// entries so they can be brought across without retyping.
function mattersFromDoc(doc) {
  return openItemsOf(doc).map(it => ({
    heading: it.heading || '',
    // Brief enough to read as a line under the heading. The full instruction
    // is kept in the detail below, so nothing the Session said is lost.
    subject: shortSubject(it.subject || it.action, 70),
    detail: it.action,
    owner: it.responsible,
    due: it.targetDate,
    raisedAt: (doc && doc.date) || '',
    raisedIn: (doc && doc.id) || null,
    status: it.deferred ? 'open' : 'in-progress',
    source: it.deferred ? 'deferred to a later meeting' : `action recorded at item ${it.no}`,
  }));
}

// ---- One matter, many meetings (Oct 2026) -----------------------------------
// A matter raised in August and discussed again in September is the SAME
// matter: September's minutes add an update to it, they do not open a second
// entry. Before this, reading September's minutes put "Letter to contractor"
// into the register a second time beside August's "Letter to the contractor",
// and the register grew a twin every meeting until someone tidied it by hand.
//
// This is the rule-based match; the AI reading is told the register too and
// says which matter an item continues, and this catches what it misses.
const MATCH_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'on', 'in', 'and', 'with', 'by', 'at', 'from', 'be', 'was', 'is', 'that', 'this', 'its', 'their', 'his', 'her', 'update', 'updates', 're', 'regarding', 'about']);
function matchTokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .map(w => w.replace(/s$/, '')).filter(w => w.length > 1 && !MATCH_STOP.has(w)));
}
function overlap(a, b) {
  const A = matchTokens(a), B = matchTokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0; A.forEach(x => { if (B.has(x)) n += 1; });
  return n / Math.min(A.size, B.size);
}
const normText = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// The open matter this item continues, or null.
function continuingMatter(candidates, item) {
  let best = null, bestScore = 0;
  // An item brought in from the register as "Heading: Subject" (one matter
  // taken under its heading — the agenda picker, 21 Oct 2026) is that matter.
  const colon = String(item.subject || '').indexOf(': ');
  const partHead = colon > 0 ? normText(String(item.subject).slice(0, colon)) : '';
  const partSubj = colon > 0 ? normText(String(item.subject).slice(colon + 2)) : '';
  (candidates || []).forEach(m => {
    if (normText(m.subject) && normText(m.subject) === normText(item.subject)) { if (bestScore < 2) { best = m; bestScore = 2; } return; }
    if (partSubj && normText(m.subject) === partSubj && (!normText(m.heading) || normText(m.heading) === partHead)) {
      if (bestScore < 2) { best = m; bestScore = 2; } return;
    }
    const sameHeading = normText(m.heading) && normText(m.heading) === normText(item.heading);
    const subj = overlap(m.subject, item.subject);
    const score = sameHeading ? (subj >= 0.6 ? 1 + subj : 0) : (subj >= 0.8 ? subj : 0);
    if (score > bestScore) { best = m; bestScore = score; }
  });
  return best;
}

// ---- Titles -----------------------------------------------------------------
// The congregation addresses its members properly, so a name written into the
// agenda, the devotion line or a sentence of the minutes carries the person's
// titles — and a person may hold more than one. The minutes of this
// congregation place them in two positions, and the app keeps that:
//
//   in front   Rev, Catechist, Mr, Mrs, Madam …   "Catechist Mrs Henrietta Abena Frempong"
//   after, in brackets   Dr, Ing, Esq             "Rev Martin Owusu Boamah (Dr)"
//
// A member therefore carries a LIST of titles, not one, and the app knows where
// each belongs and in what order — so the Clerk ticks "Rev" and "Dr" and the
// document comes out exactly as the congregation writes it.
const TITLE_DEFS = [
  { label: 'Very Rev', place: 'pre' },
  { label: 'Rt Rev', place: 'pre' },
  { label: 'Rev', place: 'pre' },
  { label: 'Catechist', place: 'pre' },
  { label: 'Elder', place: 'pre' },
  { label: 'Nana', place: 'pre' },
  { label: 'Nii', place: 'pre' },
  { label: 'Naa', place: 'pre' },
  { label: 'Prof', place: 'pre' },
  { label: 'Mr', place: 'pre' },
  { label: 'Mrs', place: 'pre' },
  { label: 'Ms', place: 'pre' },
  { label: 'Miss', place: 'pre' },
  { label: 'Madam', place: 'pre' },
  { label: 'Dr', place: 'post' },
  { label: 'Ing', place: 'post' },
  { label: 'Esq', place: 'post' },
];
const TITLES = TITLE_DEFS.map(t => t.label);
const titleDef = t => TITLE_DEFS.find(d => d.label.toLowerCase() === String(t || '').trim().replace(/\.$/, '').toLowerCase()) || null;
const titleRank = t => { const i = TITLE_DEFS.findIndex(d => d === titleDef(t)); return i < 0 ? 999 : i; };

// Detection is wider than the list offered in the app: an uploaded duty roster
// writes "Mad." and "Elder.", and those are titles too.
const TITLE_FORMS = TITLES.concat(['Mad', 'Hon', 'Lawyer', 'Barr']);
const KNOWN_TITLE = new RegExp(
  `(^|[\\s(])(${TITLE_FORMS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b\\.?`, 'i');

function carriesTitle(name, title) {
  const n = String(name || '');
  if (!title) return KNOWN_TITLE.test(n);
  const t = String(title).replace(/\./g, '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s(])${t}\\b`, 'i').test(n);
}

// A member's titles, however they were recorded. `titles` is the field; the
// older single `title` string is still honoured so nothing entered before this
// change is lost.
function titlesOf(m) {
  if (!m) return [];
  const raw = Array.isArray(m.titles) ? m.titles
    : (m.titles ? String(m.titles).split(',') : (m.title ? String(m.title).split(',') : []));
  const seen = new Set();
  return raw.map(t => String(t || '').trim().replace(/^\(|\)$/g, '').replace(/\.$/, ''))
    .filter(Boolean)
    .map(t => (titleDef(t) || {}).label || t)
    .filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => titleRank(a) - titleRank(b));
}

// The name as it should be written wherever the minutes address a person.
// A title already sitting inside the name is not added a second time, so this
// is correct both before and after the titles are moved out of the names.
function displayName(m) {
  if (!m) return '';
  const name = String(m.name || '').trim();
  const titles = titlesOf(m).filter(t => !carriesTitle(name, t));
  if (!titles.length) return name;
  const pre = titles.filter(t => (titleDef(t) || { place: 'pre' }).place === 'pre');
  const post = titles.filter(t => (titleDef(t) || { place: 'pre' }).place === 'post');
  return [...pre, name].join(' ') + (post.length ? ` (${post.join(', ')})` : '');
}

// The same person, written for RUNNING TEXT. The listing form brackets the
// academic title — "Rev Martin Owusu Boamah (Dr)" — because that is how the
// roster of a meeting is set out. A sentence does not: inside the minutes he is
// "Rev Dr Martin Owusu Boamah". Same titles, same order, no brackets.
function proseName(m) {
  if (!m) return '';
  const name = String(m.name || '').trim();
  // A title still written INSIDE the name — "Michael K. Tenkorang (Dr)" — is
  // moved to the front for running text, exactly as if it had been recorded in
  // the title field. Otherwise a member whose titles have not yet been lifted
  // out of his name would read as "Michael K. Tenkorang (Dr) informed the
  // Session", which is the listing form in the middle of a sentence.
  const inName = splitName(name);
  const seen = new Set();
  const titles = [...inName.titles, ...titlesOf(m)]
    .map(t => (titleDef(t) || {}).label || t)
    .filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => titleRank(a) - titleRank(b));
  const base = inName.base;
  const add = titles.filter(t => !carriesTitle(base, t));
  return add.length ? [...add, base].join(' ') : base;
}

// ---- Short forms after the first mention (Oct 2026) ------------------------
// After a person's first mention in an item the minutes use a shorter form.
// The default is title + surname ("Rev Akyeampong"); some members have their
// own ("Dr. Nicholas A. Tweneboa"), kept on the roster as shortForm — typed in
// on the Session Composition page, or LEARNED: when the Clerk corrects the
// tidy-up's short form by hand, the form he wrote is remembered for next time.
const escRe = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function surnameOf(m) {
  const base = splitName(String((m && m.name) || '')).base.replace(/\(.*?\)/g, ' ').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : '';
}
// Every way this text names the member: one or more titles, up to four
// forenames or initials, then the surname. "Dr. Nicholas A. Tweneboa",
// "Dr Tweneboa", "Rev Dr Martin Owusu Boamah" all count.
function mentionsOf(text, m) {
  const sur = surnameOf(m);
  if (!sur) return [];
  const titles = TITLE_FORMS.concat(['Madam', 'Very Rev', 'Rt Rev', 'Most Rev']).map(t => escRe(t).replace(/ /g, '\\s+'));
  const re = new RegExp(`(?:(?:${titles.join('|')})\\.?\\s+)+(?:[A-Z][A-Za-z'\u2019-]*\\.?\\s+){0,4}${escRe(sur)}\\b`, 'g');
  return (String(text || '').match(re) || []).map(x => x.replace(/\s+/g, ' ').trim());
}
// A member's title changed (Mrs → Madam). Rewrite how running text names her:
// every mention of her (see mentionsOf) whose titles include one she no longer
// carries has it swapped for the new one, keeping the rest of the mention —
// "Mrs Cecilia Pokua Anto" → "Madam Cecilia Pokua Anto", "Mrs Anto" → "Madam
// Anto", "Catechist Mrs X" → "Catechist Madam X". A mention by surname alone is
// only trusted when no other member shares the surname (`shared`); otherwise
// the mention must carry one of her forenames.
function retitleText(text, m, fromTitles, toTitles, shared) {
  const src = String(text == null ? '' : text);
  const sur = surnameOf(m);
  if (!src || !sur) return { text: src, n: 0 };
  const key = t => String(t || '').replace(/\.$/, '').toLowerCase();
  const pre = list => (list || []).map(t => (titleDef(t) || {}).label || t).filter(t => (titleDef(t) || { place: 'pre' }).place === 'pre');
  const gone = new Set(pre(fromTitles).map(key).filter(k => !pre(toTitles).map(key).includes(k)));
  if (gone.has('madam')) gone.add('mad');
  const fresh = pre(toTitles).filter(t => !pre(fromTitles).map(key).includes(key(t)));
  if (!gone.size) return { text: src, n: 0 };
  const forenames = splitName(String(m.name || '')).base.split(/\s+/).slice(0, -1).map(x => x.replace(/\.$/, '').toLowerCase());
  const titleAlt = TITLE_FORMS.concat(['Madam', 'Very Rev', 'Rt Rev', 'Most Rev']).sort((a, b) => b.length - a.length).map(t => escRe(t).replace(/ /g, '\\s+'));
  const re = new RegExp(`\\b((?:(?:${titleAlt.join('|')})\\.?\\s+)+)((?:[A-Z][A-Za-z'’-]*\\.?\\s+){0,4}${escRe(sur)}\\b)`, 'g');
  const one = new RegExp(`^(${titleAlt.join('|')})(\\.?)\\s+`);
  let n = 0;
  const out = src.replace(re, (whole, titles, rest) => {
    const names = rest.split(/\s+/).slice(0, -1).map(x => x.replace(/\.$/, '').toLowerCase());
    if (shared && !names.some(x => forenames.includes(x))) return whole;
    if (names.some(x => x.length > 1 && !forenames.includes(x) && !forenames.some(f => f[0] === x[0] && x.length === 1))) return whole;
    const toks = [];
    let t = titles;
    let mm;
    while ((mm = t.match(one))) { toks.push(mm[1]); t = t.slice(mm[0].length); }
    if (!toks.some(x => gone.has(key(x)))) return whole;
    let put = false;
    const next = [];
    toks.forEach(x => {
      if (!gone.has(key(x))) { next.push(x); return; }
      if (!put) { fresh.forEach(f => { if (!next.map(key).includes(key(f))) next.push(f); }); put = true; }
    });
    n += 1;
    return (next.length ? next.join(' ') + ' ' : '') + rest;
  });
  return { text: out, n };
}

// Compare the tidy-up's text with the Clerk's corrected text. If, for one
// member, a short form vanished and exactly one NEW form of his name took its
// place, that new form is his preferred short form.
function learnShortForms(before, after, members) {
  const out = [];
  const list = (members || []).filter(m => m && m.name);
  const sur = new Map();
  list.forEach(m => { const k = surnameOf(m).toLowerCase(); if (k) sur.set(k, (sur.get(k) || 0) + 1); });
  list.forEach(m => {
    const k = surnameOf(m).toLowerCase();
    if (!k || sur.get(k) > 1) return;          // two members share the surname: too risky
    const full = proseName(m).replace(/\s+/g, ' ').trim();
    const was = new Set(mentionsOf(before, m)), now = new Set(mentionsOf(after, m));
    const gone = [...was].filter(x => !now.has(x) && x !== full);
    const fresh = [...now].filter(x => !was.has(x) && x !== full);
    if (gone.length && fresh.length === 1 && fresh[0] !== (m.shortForm || '')) out.push({ id: m.id, name: m.name, form: fresh[0] });
  });
  return out;
}

// Nobody has said how to address this person, and the name gives no clue.
function needsTitle(m) {
  return !!m && !titlesOf(m).length && !carriesTitle(m && m.name, '');
}

// ---- Moving a title out of a name ------------------------------------------
// Rosters were first entered with the titles written into the name. Splitting
// them out gives one rule for everybody and makes a title editable. The split
// is only ever accepted when reassembling it reproduces the original name
// CHARACTER FOR CHARACTER — anything else is left alone and reported, because a
// name in the minutes is not something to be approximately right about.
function splitName(name) {
  const original = String(name || '').trim();
  let s = original;
  const pre = [], post = [];

  s = s.replace(/\(([^)]*)\)/g, (whole, inner) => {
    const parts = inner.split(/[,/]/).map(x => x.trim()).filter(Boolean);
    if (parts.length && parts.every(x => (titleDef(x) || {}).place === 'post')) {
      post.push(...parts.map(x => titleDef(x).label));
      return ' ';
    }
    return whole;                       // "(Dr)" yes; "(Building Committee)" no
  });

  let moved = true;
  while (moved) {
    moved = false;
    for (const d of TITLE_DEFS.filter(x => x.place === 'pre')) {
      const re = new RegExp(`^${d.label.replace(/ /g, '\\s+')}\\.?\\s+`, 'i');
      if (re.test(s.trim())) { pre.push(d.label); s = s.trim().replace(re, ''); moved = true; break; }
    }
  }

  const base = s.replace(/\s+/g, ' ').trim();
  const titles = [...pre, ...post];
  const rebuilt = displayName({ name: base, titles });
  return { base, titles, pre, post, rebuilt, exact: rebuilt === original, original };
}

// The duty roster is uploaded as plain text, so its names are matched back to
// the Session roster to pick up titles. Punctuation, case and any honorific
// already present are ignored for the comparison.
function bareName(s) {
  return String(s || '').toLowerCase()
    .replace(/\(([^)]*)\)/g, ' ')
    .replace(new RegExp(KNOWN_TITLE.source, 'gi'), ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// "A. Twum" and "E. A. Twum" are the same man as "Emmanuel Adjei Twum": the
// surname must match, and every initial given must line up with a forename.
function initialsFit(fullBare, wantBare) {
  const full = fullBare.split(' ').filter(Boolean);
  const want = wantBare.split(' ').filter(Boolean);
  if (full.length < 2 || want.length < 2) return false;
  if (full[full.length - 1] !== want[want.length - 1]) return false;   // surname
  const fore = full.slice(0, -1);
  const given = want.slice(0, -1);
  if (given.length > fore.length) return false;
  let at = 0;
  return given.every(g => {
    while (at < fore.length) {
      const f = fore[at++];
      if (f === g || (g.length === 1 && f[0] === g)) return true;
    }
    return false;
  });
}
function matchMember(members, name) {
  const want = bareName(name);
  if (!want) return null;
  const list = (Array.isArray(members) ? members : []).filter(m => m.active !== false);
  const exact = list.filter(m => bareName(m.name) === want);
  if (exact.length) return exact[0];
  const partial = list.filter(m => { const b = bareName(m.name); return b && (b.includes(want) || want.includes(b)); });
  if (partial.length === 1) return partial[0];
  const byInitials = list.filter(m => initialsFit(bareName(m.name), want));
  // Two people it could be is not a match — better to leave the text alone than
  // to put the wrong name in the minutes.
  return byInitials.length === 1 ? byInitials[0] : (partial.length ? partial[0] : null);
}
// A name typed by hand, written out the way the roster has it. Anything the
// roster does not recognise is returned untouched — a visitor, for instance.
function resolveName(members, text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = matchMember(members, t);
  return m ? proseName(m) : t;                 // it is going into a sentence
}

// The fields of a meeting that hold a person's name, and so get written out in
// full. presentationBy is deliberately absent: presenters are usually visitors,
// and an unrecognised name is left exactly as typed anyway.
const PERSON_KEYS = ['constitutedBy', 'minutesReadBy', 'minutesMovedBy', 'minutesSecondedBy',
  'closureMovedBy', 'closureSecondedBy', 'benedictionBy'];

// Some fields hold two names ("Betty Dufie Owusu / Alex Abankwa").
function resolveNameList(members, text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (!/[/,]| and /i.test(t)) return resolveName(members, t);
  return t.split(/\s*(?:\/|,| and )\s*/i).filter(Boolean)
    .map(p => resolveName(members, p)).join(' / ');
}
// Duty-roster names, each given its title where the Session roster knows one.
function titledNames(names, members) {
  return (Array.isArray(names) ? names : []).filter(Boolean).map(n => {
    const raw = String(n).trim();
    const m = matchMember(members, raw);
    if (!m) return raw;
    const shown = proseName(m);
    // The roster's own title wins where it has one. Where it has none, an
    // honorific already written on the duty sheet is kept rather than thrown
    // away — it is the only place that person's title is recorded.
    if (carriesTitle(shown, '')) return shown;
    return carriesTitle(raw, '') ? raw : shown;
  });
}

// Rosters entered before offices existed carry only a position string, so the
// office is read back from it rather than needing a migration.
function officeKeyForPosition(position) {
  const p = String(position || '').trim().toLowerCase();
  if (!p) return '';
  const hit = OFFICES.find(o => o.label.toLowerCase() === p);
  return hit ? hit.key : '';
}
function officeOf(m) {
  if (!m) return '';
  return m.office || officeKeyForPosition(m.position);
}
// Agent, presbyter or co-opted. An explicit `kind` on the member wins, so a
// minister who holds no listed office can still be marked an agent.
function memberKind(m) {
  if (!m) return 'presbyter';
  if (isCoOpted(m)) return 'co-opted';
  if (m.kind === 'agent' || m.kind === 'presbyter') return m.kind;
  const o = officeByKey(officeOf(m));
  return o ? o.kind : 'presbyter';
}
const isAgent = m => memberKind(m) === 'agent';

// Everyone who may chair, and so constitute a meeting. Deliberately NOT
// filtered by tonight's roll: a meeting is set up before anyone knows who will
// be able to come.
function agentsOf(members) {
  return (Array.isArray(members) ? members : [])
    .filter(m => m.active !== false && isAgent(m))
    .sort(byRank);
}
// Who holds what, in the order the offices are listed above.
function officeTable(members) {
  const list = (Array.isArray(members) ? members : []).filter(m => m.active !== false);
  return OFFICES.map(o => ({
    ...o,
    holders: list.filter(m => officeOf(m) === o.key).sort(byRank)
      .map(m => ({ id: m.id, name: m.name })),
  }));
}
function linguistOf(members) {
  return (Array.isArray(members) ? members : [])
    .find(m => m.active !== false && officeOf(m) === 'linguist') || null;
}

// Seed roster built from the Session minutes of 9 Dec 2025 and 9 Jul 2026
// (the union of both attendance lists), already in the confirmed rank order.
// Used once, by the "Set up Session roster" action, and freely editable after.
const SEED_ROSTER = [
  { name: 'Rev Joseph Richmond Tettey', position: 'District Minister' },
  { name: 'Rev Martin Owusu Boamah (Dr)', position: 'Associate Minister' },
  { name: 'Catechist Eugene Akuamoah Addo', position: 'Catechist' },
  { name: 'Catechist Mrs Henrietta Abena Frempong', position: 'Catechist' },
  { name: 'Nicholas A. Tweneboa (Dr)', position: 'Senior Presbyter' },
  { name: 'Gideon Adjierteh Adjei', position: 'Session Clerk' },
  { name: 'Emmanuel Adjei Twum', position: 'Treasurer' },
  { name: 'Kwaku Koranteng (Ing)', position: 'Member' },
  { name: 'Betty Dufie Owusu', position: 'Member' },
  { name: 'Betty Wiafe Akenteng', position: 'Member' },
  { name: 'Agnes Seffah-Nyame', position: 'Member' },
  { name: 'Cecilia Pokua Anto', position: 'Member' },
  { name: 'Alex Abankwa', position: 'Member' },
  { name: 'Esther Boatemaa', position: 'Member' },
  { name: 'Cynthia Akuba Amartei', position: 'Member' },
  { name: 'Belinda Maureen Akuamoah', position: 'Member' },
  { name: 'Sampson Agudze (Ing)', position: 'Member' },
  { name: 'Grace Bediako-Asante', position: 'Member' },
  { name: 'Charles Osei Yeboah', position: 'Member' },
  { name: 'Irene Ansomaa Yeboah', position: 'Member' },
  { name: 'Michael K. Tenkorang (Dr)', position: 'Member' },
  { name: 'Eleazar Addo', position: 'Member' },
  { name: 'Gladys Biama Sackey', position: 'Member' },
  { name: 'Daniel Asumadu Owusu', position: 'Member' },
  { name: 'Frank Anane Frempong', position: 'Member' },
];

// Ranks are spaced by 10 so a new person can be slipped between two existing
// members without renumbering the whole roster.
function seedRoster() {
  return SEED_ROSTER.map((m, i) => ({ ...m, rank: (i + 1) * 10, active: true }));
}

// The one sort used for Present, Apologies and Absent alike.
function byRank(a, b) {
  const ra = Number(a && a.rank), rb = Number(b && b.rank);
  const va = Number.isFinite(ra) ? ra : 1e9;
  const vb = Number.isFinite(rb) ? rb : 1e9;
  if (va !== vb) return va - vb;
  return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
}

// ---- Section scaffold ------------------------------------------------------
// The standard running order of a PCG-AOTC Session meeting. `enabled` sections
// are numbered 1.0, 2.0 … at render time, so switching a section off (e.g. no
// Reports were taken this month) closes the gap instead of leaving a hole.
// `container: true` marks sections whose real content lives in numbered
// sub-items (5.1, 5.2 …) rather than in the parent's own body.
const SECTION_TEMPLATE = [
  // `prefix` means the auto-written sentence OPENS the section and the clerk's
  // own text follows it, rather than replacing it. Devotion works that way:
  // the time, who led it, the hymn and the scripture write themselves, then
  // the clerk types the summary of the exhortation underneath.
  { key: 'devotion', subject: 'Opening Prayer and Devotion', enabled: true, prefix: true },
  { key: 'constitution', subject: 'Constitution of the Session', enabled: true },
  { key: 'presentation', subject: 'Presentation', enabled: true, prefix: true, emptyBody: 'No presentation was scheduled for the meeting.' },
  // A container's lead-in line agrees with the number of items beneath it —
  // "The following WAS discussed" for one, "WERE" for several. It is written as
  // a function of the count so the sentence is right whichever way the meeting
  // went, rather than the clerk having to correct it every time.
  { key: 'review', subject: 'Review of Minutes', enabled: true, container: true,
    lead: n => n <= 3 ? 'The following minutes was reviewed.' : 'The following minutes were reviewed.' },
  { key: 'matters', subject: 'Matters Arising', enabled: true, container: true,
    lead: n => n === 1 ? 'The following was discussed under matters arising.'
                       : 'The following were discussed under matters arising.' },
  { key: 'main', subject: 'Main Business', enabled: true, container: true,
    lead: n => n === 1 ? 'The following was covered under main business.'
                       : 'The following were covered under main business.' },
  { key: 'reports', subject: 'Reports', enabled: false, container: true,
    lead: n => n === 1 ? 'The following report was presented to the Session:'
                       : 'The following reports were presented to the Session:' },
  // Correspondence is a mass noun — "was received" however many letters came.
  { key: 'correspondence', subject: 'Correspondence', enabled: true, container: true,
    lead: () => 'The following correspondence was received:', fromRegister: true },
  { key: 'other', subject: 'Other Matters', enabled: true, container: true, roman: true,
    lead: n => n === 1 ? 'The following other matter was discussed.'
                       : 'The following other matters were discussed.' },
  { key: 'prayers', subject: 'Prayers', enabled: true },
  { key: 'closure', subject: 'Closure', enabled: true },
];

// The four report slots the Session takes when Reports are on the agenda.
const REPORT_SLOTS = ['Church Finance', 'CLAN', 'Mission and Evangelism', 'Presbyters on Duty'];
// A report slot left blank prints this (21 Oct 2026, the Clerk's request),
// and when no slot has anything the section says so once instead.
const NO_REPORT = 'No report was presented.';
const NO_REPORTS = 'No reports were presented at this meeting.'; 

function newSections() {
  return SECTION_TEMPLATE.map(s => ({
    key: s.key,
    subject: s.subject,
    enabled: !!s.enabled,
    body: '',
    action: '',
    children: s.key === 'reports' ? REPORT_SLOTS.map(r => ({ subject: r, body: '', action: '' })) : [],
  }));
}

function meta(key) {
  return SECTION_TEMPLATE.find(s => s.key === key) || {};
}

// ---- House-style sentences -------------------------------------------------
// Anything the clerk captured as a time / name writes its own sentence; a
// missing value leaves a visible blank so it is obvious what still needs
// filling, rather than silently producing a wrong sentence.
// BLANK, or(), stop() and roman() come from @deontech/minutes (top of file).

// Auto-drafted body for the sections that are pure boilerplate around a few
// captured values. Returns '' when the clerk has written their own body.
function autoBody(key, p = {}, ctx = {}) {
  if (key === 'devotion') {
    const bits = [];
    const who = or(p.devotionBy);
    const hymn = (p.hymn || '').trim();
    const scripture = (p.scripture || '').trim();
    let s = `The meeting commenced at ${stop(or(p.commencedAt))}`;
    s += ` ${who} led the Session in devotion`;
    if (hymn) s += `, leading the singing of ${hymn}`;
    s += '.';
    if (scripture) s += ` The exhortation was taken from ${scripture}.`;
    bits.push(s);
    return bits.join(' ');
  }
  // Visitors to the Session are received under Presentation, one paragraph per
  // group in the order they came (see public/js/visitors-text.js). They are not
  // listed under IN ATTENDANCE. Minutes from before 0.4.2 keep their one-line
  // "Presentation by / topic" sentence.
  if (key === 'presentation') {
    const groups = VisitorsText.visitorsBody(p.visitors, ctx);
    if (groups) return groups;
    const who = String(p.presentationBy || '').trim();
    const topic = String(p.presentationTopic || '').trim();
    if (!who && !topic) return '';
    if (who && topic) return `A presentation on ${topic} was made by ${who}.`;
    if (who) return `A presentation was made by ${who}.`;
    return `A presentation was made on ${topic}.`;
  }
  // Prayers are captured as they are prayed: who led, then the points one by
  // one, then anything else that happened — a summary given, someone else
  // closing. The points come back out as bullets (see `bulletise`), which is
  // how the congregation's minutes set them.
  if (key === 'prayers') {
    const pr = (p && p.prayers) || {};
    const led = String(pr.ledBy || '').trim();
    const points = (Array.isArray(pr.points) ? pr.points : [])
      .map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    const note = String(pr.note || '').trim();
    const bits = [];
    if (points.length) {
      bits.push(led
        ? `${led} led the Session in prayer on the following:`
        : 'The Session prayed on the following:');
      bits.push(points.join('\n'));
    } else if (led) {
      bits.push(`${led} led the Session in prayer.`);
    }
    if (note) bits.push('\n' + note);
    return bits.join('\n');
  }
  if (key === 'constitution') {
    return constitutionSentence(p, or);
  }
  if (key === 'closure') {
    // How the meeting is closed varies: the Grace may be said, the benediction
    // may be pronounced, both may happen, or neither — in which case the
    // minutes record only who moved and seconded the closure. The Grace is said
    // by the meeting together, so it carries no name; the benediction is
    // pronounced by one person, and only an agent may pronounce it.
    return `${or(p.closureMovedBy)} moved for the closure of the meeting at ${or(p.closedAt)}, and this was seconded by ${or(p.closureSecondedBy)}`
      + closingRite(p) + '.';
  }
  return '';
}

// The Grace and the benediction as a sentence of their own, for when the Clerk
// has written the closure himself (21 Oct 2026: the Grace was ticked and the
// benediction chosen, but a typed closure replaced the sentence that carries
// them, so neither appeared). Empty when neither was recorded.
function closingRiteSentence(p) {
  const grace = !!(p && p.graceSaid);
  const ben = String((p && p.benedictionBy) || '').trim();
  if (grace && ben) return `The Grace was said and the benediction was pronounced by ${ben}.`;
  if (ben) return `The benediction was pronounced by ${ben}.`;
  if (grace) return 'The Grace was said.';
  return '';
}

// The tail of the closure sentence — everything after the seconder, without the
// full stop. Empty when the meeting simply closed.
function closingRite(p) {
  const grace = !!(p && p.graceSaid);
  const ben = String((p && p.benedictionBy) || '').trim();
  if (grace && ben) return `, after which the Grace was said and the benediction pronounced by ${ben}`;
  if (ben) return `, after which the benediction was given by ${ben}`;
  if (grace) return ', after which the Grace was said';
  return '';
}

// Every name the agenda currently carries, headings and sub-items alike.
function agendaNames(agenda) {
  const out = new Set();
  (Array.isArray(agenda) ? agenda : []).forEach(r => {
    const item = String(r.item || '').trim();
    if (item) out.add(item.toLowerCase());
    (Array.isArray(r.subItems) ? r.subItems : []).forEach(x => {
      const nm = String((x && x.item) || x || '').trim();
      if (nm) out.add(nm.toLowerCase());
    });
  });
  return out;
}
// Items the AGENDA put into the minutes and has since dropped. They are never
// removed automatically — a body may already have been written against one —
// so they are flagged for the clerk to take out himself.
function orphanedFromAgenda(sections, agenda) {
  const names = agendaNames(agenda);
  const out = [];
  (Array.isArray(sections) ? sections : []).forEach(sec => {
    (sec.children || []).forEach(c => {
      const nm = String(c.subject || '').trim();
      if (c.fromAgenda && nm && !names.has(nm.toLowerCase())) {
        out.push({ key: sec.key, subject: nm, hasBody: !!String(c.body || '').trim() });
      }
    });
  });
  return out;
}

// The Review of Minutes section is a container whose sub-items follow a fixed
// pattern: which minutes were reviewed, any corrections, then the adoption.
// "29th January 2026" — the way the minutes write a date in prose.
function ordinalDay(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}
function ordinalDate(iso) {
  const d = toLocalDate(iso);
  if (isNaN(d)) return String(iso || '');
  return `${ordinalDay(d.getDate())} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
}

// Which minutes the Session is reviewing tonight. Taken first from the agenda —
// the sub-items under "Review of minutes" are exactly that list — and then from
// the earlier sittings the app already holds, so the clerk picks rather than
// types, and the pick carries the real date with it for matching corrections
// and working out who may move the adoption.
function reviewOptions(doc, earlier) {
  const out = [];
  const seen = new Set();
  const add = (label, iso, source) => {
    const key = String(label || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ label: String(label).trim(), iso: iso || '', source });
  };
  const known = Array.isArray(earlier) ? earlier : [];
  const matchIso = text => {
    const t = String(text || '').toLowerCase();
    const hit = known.find(d => t.includes(ordinalDate(d.date).toLowerCase()) || t.includes(String(d.date)));
    return hit ? hit.date : '';
  };

  ((doc && doc.agenda) || []).filter(r => /review/i.test(r.item || '')).forEach(r => {
    (Array.isArray(r.subItems) ? r.subItems : []).forEach(sub => {
      const text = String((sub && sub.item) || sub || '').trim();
      if (!text) return;
      const iso = matchIso(text);
      // A sub-item naming a meeting the app knows is offered by its proper
      // date; anything else is offered exactly as the agenda words it.
      add(iso ? ordinalDate(iso) : text, iso, 'agenda');
    });
  });
  known.forEach(d => add(ordinalDate(d.date), d.date, 'app'));
  return out;
}

// ---- Prayer points, and any other list ---------------------------------------
// The Prayers item is set out as a bulleted list in this congregation's minutes:
// a lead-in line ending in a colon, then one point per bullet, and sometimes a
// closing sentence afterwards. Rather than make the Clerk type bullet
// characters, the renderer works out which lines are points:
//
//   1. a line the Clerk marked himself with -, *, • or – is always a point;
//   2. otherwise, after a lead-in ending in ":", every following line is a
//      point — until a BLANK line, which returns to ordinary prose.
//
// That second rule matches every prayer list in the 2026 minutes, and the blank
// line is how "Following the prayers led by the Senior Presbyter …" stays prose.
// bulletise() comes from @deontech/minutes: points, and labelled lines
// ("Decision:", "Motion:") set apart for the documents and the register.

// ---- Review of Minutes -------------------------------------------------------
// The Session may review more than one set of minutes at a sitting, and each set
// gets the same three-part treatment, in this order:
//
//   Review of Minutes of Session Meeting for <date>
//   Correction … (one item per correction, and only if there are any)
//   Adoption of Session Minutes for <date>
//
// Two sets reviewed on the night therefore produce two complete blocks, one
// after the other — never interleaved, and never one adoption covering both.
// The corrections belong to the set they correct, which is why they are held
// inside the block rather than in one list for the whole meeting.
function reviewBlocks(doc) {
  const p = (doc && doc.proceedings) || {};
  const list = Array.isArray(doc && doc.reviews) ? doc.reviews : null;
  if (list && list.length) {
    return list.map(r => ({
      date: String(r.date || '').trim(),
      readBy: String(r.readBy || '').trim(),
      movedBy: String(r.movedBy || '').trim(),
      secondedBy: String(r.secondedBy || '').trim(),
      corrections: Array.isArray(r.corrections) ? r.corrections : [],
      note: String(r.note || '').trim(),
    }));
  }
  // Nothing recorded as a list yet: fall back to the single set of fields the
  // document has always carried, so older minutes read exactly as before.
  const single = {
    date: String(p.minutesReviewDate || '').trim(),
    readBy: String(p.minutesReadBy || '').trim(),
    movedBy: String(p.minutesMovedBy || '').trim(),
    secondedBy: String(p.minutesSecondedBy || '').trim(),
    corrections: Array.isArray(doc && doc.corrections) ? doc.corrections : [],
    note: String(p.corrections || '').trim(),
  };
  const empty = !single.date && !single.readBy && !single.movedBy
    && !single.secondedBy && !single.corrections.length && !single.note;
  return empty ? [] : [single];
}

// Is this name the Session Clerk's? Matched loosely — titles, punctuation and
// initials aside — because the review is often entered as "G. A. Adjei".
function isSameMember(a, b) {
  const x = bareName(a), y = bareName(b);
  if (!x || !y) return false;
  return x === y || initialsFit(x, y) || initialsFit(y, x);
}
function clerkFrom(members) {
  const m = (members || []).find(x => x && (x.office === 'session_clerk' || /^session clerk$/i.test(String(x.position || '').trim())));
  return m ? m.name : '';
}

function reviewChildren(doc, opts = {}) {
  const out = [];
  // The minutes name an office-holder by office (house style): when the
  // Session Clerk took the Session through the minutes, they say "The Session
  // Clerk led …", not his name. Anyone else is named. (Oct 2026.)
  const clerk = opts.clerk || clerkFrom(opts.members);
  reviewBlocks(doc).forEach(r => {
    const fixes = correctionChildren(r.corrections);
    const amended = fixes.length > 0 || !!r.note;
    // Normally the Session Clerk, but when he has prepared the minutes and is
    // not there, whoever actually took the Session through them.
    const reader = !r.readBy || (clerk && isSameMember(r.readBy, clerk)) ? 'The Session Clerk' : r.readBy;
    out.push({
      subject: r.date ? `Review of Minutes of Session Meeting for ${r.date}` : 'Review of Minutes of the previous Session Meeting',
      // A heading that names a set of minutes is underlined as well as bold.
      underline: true,
      body: `${reader} led the Session to review the minutes of the meeting held on ${or(r.date)}.`,
      action: '',
    });
    out.push(...fixes);
    if (r.note) out.push({ subject: 'Correction', body: r.note, action: '' });
    out.push({
      subject: r.date ? `Adoption of Session Minutes for ${r.date}` : 'Adoption of the Minutes',
      underline: true,
      body: `${or(r.movedBy)} moved for the adoption of the minutes${r.date ? ` for the Session meeting of ${r.date}` : ''}`
        + `${amended ? ' as corrected' : ' in the absence of corrections'}`
        + `, and ${or(r.secondedBy)} seconded the motion.`,
      action: '',
    });
  });
  return out;
}

// ---- Who may move and second -----------------------------------------------
// A person may only move (or second) the adoption of minutes for a meeting they
// actually attended — they are vouching for the accuracy of that record — and
// they must also be in the room today to do it. So the eligible set is the
// intersection of today's Present list with the Present list of the meeting
// being adopted. Everything else (devotion, constituting the Session, closure)
// is drawn from today's Present list alone.
function presentIdsOf(doc) {
  return new Set(((doc && doc.roll && doc.roll.presentIds) || []).map(Number));
}
function eligibility(doc, previousDoc) {
  const today = presentIdsOf(doc);
  const then = presentIdsOf(previousDoc);
  const adoption = previousDoc
    ? [...today].filter(id => then.has(id))
    : [...today];
  return {
    todayIds: [...today],
    adoptionIds: adoption,
    hasPrevious: !!previousDoc,
    // Present today but NOT at the meeting being adopted — shown greyed out so
    // it is obvious why a name is unavailable rather than simply missing.
    ineligibleIds: previousDoc ? [...today].filter(id => !then.has(id)) : [],
  };
}

// ---- Corrections to the minutes under review -------------------------------
// Recorded in THIS meeting against a numbered item of the PREVIOUS minutes,
// exactly as the Session records them:
//   4.2  Correction — Members Present
//        ‘DANIEL ASUMADU’ amended to ‘DANIEL ASUMADU OWUSU’
function correctionChildren(corrections) {
  return (Array.isArray(corrections) ? corrections : [])
    .filter(c => (c.was && c.was.trim()) || (c.now && c.now.trim()) || (c.note && c.note.trim()))
    .map(c => {
      const where = (c.where || '').trim();
      const ref = (c.ref || '').trim();
      const body = (c.was || '').trim() && (c.now || '').trim()
        ? `‘${c.was.trim()}’ amended to ‘${c.now.trim()}’.`
        : (c.note || '').trim();
      return {
        subject: `Correction${where ? ' — ' + where : ''}${ref ? ` (item ${ref})` : ''}`,
        body: body + ((c.note || '').trim() && (c.was || '').trim() ? ` ${c.note.trim()}` : ''),
        action: '',
      };
    });
}

// ---- Co-option --------------------------------------------------------------
// The Session may co-opt someone onto itself. A co-opted person IS a member of
// the court — they sit in MEMBERS PRESENT in rank order and may move and second
// like anyone else — so the document says nothing special about them. The app
// records the standing so Composition can show who was co-opted, when and for
// what, and so a term can be seen to have run out.
function isCoOpted(m) { return !!(m && m.coOpted); }
function coOptionNote(m) {
  if (!isCoOpted(m)) return '';
  const bits = [];
  if (m.coOptedOn) bits.push(`co-opted ${m.coOptedOn}`);
  if (m.coOptedFor) bits.push(m.coOptedFor);
  if (m.coOptedUntil) bits.push(`until ${m.coOptedUntil}`);
  return bits.join(' · ');
}
// A co-option whose term has passed — surfaced for review, never auto-removed:
// letting the app quietly drop someone from the court would be worse than
// letting the Clerk see it and decide.
function coOptionExpired(m, today) {
  if (!isCoOpted(m) || !m.coOptedUntil) return false;
  return String(m.coOptedUntil) < String(today || new Date().toISOString().slice(0, 10));
}

// ---- Attendance tally -------------------------------------------------------
// Per-member totals across the Session's own meetings, with the same two flags
// the committees use: RED for a run of absences without apology, AMBER for
// overall attendance under half.
function sessionAttendance(docs, members, th) {
  const held = (Array.isArray(docs) ? docs : [])
    .filter(d => d.roll && (d.roll.presentIds || []).length)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const limit = Number(th) >= 2 ? Number(th) : 4;

  const perMember = (Array.isArray(members) ? members : []).map(mem => {
    let present = 0, apology = 0, absent = 0, streak = 0, open = true;
    for (let i = held.length - 1; i >= 0; i--) {
      const r = held[i].roll || {};
      const isP = (r.presentIds || []).includes(mem.id);
      const isA = (r.apologyIds || []).includes(mem.id);
      const isX = !isP && !isA;
      if (isP) present += 1; else if (isA) apology += 1; else absent += 1;
      if (open) { if (isX) streak += 1; else open = false; }
    }
    const pct = held.length ? Math.round((present / held.length) * 100) : null;
    let flag = null;
    if (streak >= limit) flag = 'red';
    else if (held.length >= 2 && pct !== null && pct < 50) flag = 'amber';
    return {
      memberId: mem.id, name: mem.name, position: mem.position || 'Member',
      coOpted: isCoOpted(mem),
      held: held.length, present, apology, absent, pct, consecutiveAbsences: streak, flag,
    };
  });
  return {
    held: held.length,
    dates: held.map(d => d.date),
    threshold: limit,
    perMember,
    flagged: perMember.filter(m => m.flag),
  };
}

// ---- Presbyters on Duty -----------------------------------------------------
// Two presbyters are on duty each Sunday, rostered half a year at a time
// (January–June, then July–December). The pair on duty for the week in which a
// Session meeting falls are the ones who take the devotion, so the agenda and
// the minutes can both be filled from the roster instead of by hand.
function halfOf(iso) {
  const m = Number(String(iso || '').slice(5, 7));
  return m >= 7 ? 2 : 1;
}
function halfLabel(year, half) {
  return half === 2 ? `July – December ${year}` : `January – June ${year}`;
}
// The Sunday that opens the week containing this date. Session meetings sit on
// a Tuesday or Thursday, so this resolves to the Sunday just gone.
function sundayOnOrBefore(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // getUTCDay 0 = Sunday
  return d.toISOString().slice(0, 10);
}
// All the Sundays in a half-year — used to lay out a blank roster to fill in,
// and to check an uploaded one for gaps.
function sundaysInHalf(year, half) {
  const start = new Date(Date.UTC(year, half === 2 ? 6 : 0, 1));
  const end = new Date(Date.UTC(year, half === 2 ? 11 : 5, half === 2 ? 31 : 30));
  const out = [];
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7)); // first Sunday
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}
// Who is on duty for the week of `iso`, from a roster's entries.
function podOnDuty(entries, iso) {
  const sunday = sundayOnOrBefore(iso);
  if (!sunday) return [];
  const hit = (Array.isArray(entries) ? entries : []).find(e => e.date === sunday);
  return hit ? (hit.names || []).filter(Boolean) : [];
}
// "Mr. Frank Anane Frempong / Ms. Betty Dufie Owusu" — how the agenda writes it.
function podLabel(names) {
  return (Array.isArray(names) ? names : []).filter(Boolean).join(' / ');
}

// ---- Church Finance ---------------------------------------------------------
// The Treasurer's monthly position, held as figures rather than as a typed
// table so the app can do the arithmetic. Columns are the church's accounts
// (editable); the TOTAL column, the sub-total row and the closing balances are
// always computed here and never taken from what was typed or read from a
// photograph — that is what makes a misread digit visible.
const DEFAULT_ACCOUNTS = [
  { key: 'gcb', label: 'GCB' },
  { key: 'ecobank', label: 'ECOBANK' },
  { key: 'nib', label: 'NIB' },
  { key: 'welfare', label: 'GCB (WELFARE)' },
];
// Input rows the clerk (or the photo) fills; the rest are derived.
const FINANCE_INPUTS = [
  { key: 'opening', label: 'OPENING BALANCE' },
  { key: 'cash', label: 'Cash', group: 'RECEIPTS' },
  { key: 'chequeDt', label: 'Cheque/DT', group: 'RECEIPTS' },
  { key: 'momo', label: 'MOMO', group: 'RECEIPTS' },
  { key: 'payments', label: 'PAYMENTS' },
];

function newFinance(asOf) {
  const values = {};
  FINANCE_INPUTS.forEach(r => { values[r.key] = {}; });
  return { asOf: asOf || '', accounts: DEFAULT_ACCOUNTS.map(a => ({ ...a })), values, note: '', stated: {} };
}
function num(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function money(v, blankZero) {
  const n = num(v);
  if (!n) return blankZero ? '-' : '-';
  return n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Returns the grid ready for printing plus any reconciliation warnings.
function computeFinance(finance) {
  const f = finance || newFinance();
  const accounts = (f.accounts && f.accounts.length ? f.accounts : DEFAULT_ACCOUNTS);
  const val = (rowKey, acctKey) => num(((f.values || {})[rowKey] || {})[acctKey]);
  const across = rowKey => accounts.reduce((s, a) => s + val(rowKey, a.key), 0);

  const receiptsFor = k => num(val('cash', k)) + num(val('chequeDt', k)) + num(val('momo', k));
  const subtotalFor = k => val('opening', k) + receiptsFor(k);
  const closingFor = k => subtotalFor(k) - val('payments', k);

  const line = (label, cells, opts = {}) => ({
    label, cells, total: cells.reduce((s, c) => s + c, 0), ...opts,
  });
  const col = fn => accounts.map(a => fn(a.key));

  const rows = [
    line('OPENING BALANCE', col(k => val('opening', k))),
    line('RECEIPTS', col(() => null), { header: true }),
    line('   Cash', col(k => val('cash', k))),
    line('   Cheque/DT', col(k => val('chequeDt', k))),
    line('   MOMO', col(k => val('momo', k))),
    line('', col(subtotalFor), { computed: true, rule: true }),
    line('PAYMENTS', col(k => val('payments', k))),
    line('CLOSING BALANCE', col(closingFor), { computed: true, strong: true }),
  ];

  // Where the Treasurer's own statement quotes a total, check ours against it.
  const warnings = [];
  const stated = f.stated || {};
  const check = (key, computed, label) => {
    if (stated[key] === undefined || stated[key] === '' || stated[key] === null) return;
    const s = num(stated[key]);
    if (Math.abs(s - computed) > 0.005) {
      warnings.push(`${label}: the statement shows ${money(s)} but the figures entered add up to ${money(computed)} — a difference of ${money(Math.abs(s - computed))}.`);
    }
  };
  check('opening', across('opening'), 'Opening balance total');
  check('closing', accounts.reduce((s, a) => s + closingFor(a.key), 0), 'Closing balance total');
  check('payments', across('payments'), 'Payments total');

  return { accounts, rows, warnings };
}

// True once any figure has actually been entered — an all-zero grid should not
// print itself into the minutes.
function hasFinanceFigures(finance) {
  const values = (finance && finance.values) || {};
  return FINANCE_INPUTS.some(r => Object.values(values[r.key] || {}).some(v => num(v) !== 0));
}
// The sentence the Session uses to introduce the figures.
function financeLead(finance) {
  const asOf = finance && finance.asOf;
  let when = '';
  if (asOf) {
    const d = new Date(String(asOf) + 'T00:00:00');
    if (!isNaN(d)) {
      const day = d.getDate();
      const s = ['th', 'st', 'nd', 'rd'], v = day % 100;
      when = ` as of ${day}${s[(v - 20) % 10] || s[v] || s[0]} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
    }
  }
  return `The Treasurer presented a detailed update on the church's finances${when} as found below:`;
}

// The printable grid: header row + body rows, all strings.
function financeGrid(finance) {
  const { accounts, rows } = computeFinance(finance);
  const head = [''].concat(accounts.map(a => a.label)).concat(['TOTAL']);
  const body = rows.map(r => [r.label]
    .concat(r.cells.map(c => (c === null ? '' : money(c))))
    .concat([r.header ? '' : money(r.total)]));
  return { head, rows: body };
}

// ---- Carry-forward ----------------------------------------------------------
// Anything still open at the end of a meeting should meet the Session again:
// action points that are not done, and items explicitly deferred. These become
// pre-created Matters Arising sub-items (and agenda sub-items) next time.
function openItemsOf(doc) {
  const out = [];
  let n = 0;
  (doc && doc.sections || []).filter(s => s.enabled).forEach(sec => {
    n += 1;
    const consider = (row, no, fallbackSubject) => {
      const hasOpenAction = (row.action || '').trim() && (row.actionStatus || 'open') !== 'done';
      if (!hasOpenAction && !row.deferred) return;
      out.push({
        no,
        // The agenda heading this sits under: the numbered item's own Subject
        // line. Several outstanding matters share one, and the next agenda
        // carries the HEADING rather than each detail beneath it. Where that
        // Subject is a container — "Other Matters" — the heading is composed
        // from the matter's own words instead, so the concern is named.
        heading: headingFor(row.subject, fallbackSubject, row.action || row.body),
        // The item's OWN label, which must not fall back to the section's
        // subject: that is the heading, and a sub-item repeating its heading
        // word for word tells the Session nothing. Where the row carries no
        // subject of its own the action it was given is the label.
        subject: (row.subject || row.action || fallbackSubject || '').trim(),
        action: (row.action || '').trim(),
        responsible: (row.actionResponsible || '').trim(),
        targetDate: (row.actionDate || '').trim(),
        deferred: !!row.deferred,
      });
    };
    consider(sec, `${n}.0`, sec.subject);
    (sec.children || []).forEach((c, i) => consider(c, `${n}.${i + 1}`, sec.subject));
  });
  return out;
}

// Every person-field of the proceedings, rewritten into the form a sentence
// wants. Safe to run twice — proseName leaves an already-prose name alone.
// Times in the minutes read "6:30 pm" (Session Clerk's decision, Oct 2026;
// earlier minutes wrote "6.30 p.m."). Whatever was typed or stamped — "6.32
// p.m.", "6:32PM", "18:32" — prints in that one form. Anything that does not
// look like a time is left exactly as written.
// minuteTime() comes from @deontech/minutes.
// The constituting sentence. Often the minister constitutes the Session on the
// word shared at the devotion, or on a scripture, and the minutes say so:
// "Rev Joseph Richmond Tettey, drawing on the words shared during the devotion,
// duly constituted the Session at 6:46 pm in the name of the Triune God."
// (20 Nov, 9 Dec 2025; 5 Feb, 5 Mar, 9 Apr, 11 Jun 2026.) With a scripture
// given: "…, drawing on Hebrews 4:16, duly constituted …".
function constitutionSentence(p, or) {
  p = p || {};
  const ref = String(p.constitutedWordRef || '').trim();
  const on = p.constitutedOnWord ? (ref ? `, drawing on ${ref},` : ', drawing on the words shared during the devotion,') : '';
  return `${or(p.constitutedBy)}${on} duly constituted the Session at ${or(p.constitutedAt)} in the name of the Triune God.`;
}
const TIME_KEYS = ['commencedAt', 'constitutedAt', 'closedAt', 'adjournedAt', 'endedAt'];

function prosePeople(p, members) {
  const out = { ...p };
  TIME_KEYS.forEach(k => { if (out[k]) out[k] = VisitorsText.clock(minuteTime(out[k])); });
  PERSON_KEYS.forEach(k => { if (out[k]) out[k] = resolveName(members, out[k]); });
  if (out.devotionBy) out.devotionBy = resolveNameList(members, out.devotionBy);
  if (out.prayers && out.prayers.ledBy) {
    out.prayers = { ...out.prayers, ledBy: resolveName(members, out.prayers.ledBy) };
  }
  return out;
}

// ---- Numbering -------------------------------------------------------------
// Produces the flat rows the Word/PDF body table is built from:
//   { no:'5.1', subject, body, action, level }
// Sections that are switched off are skipped entirely and the numbering closes
// up behind them.
function renderRows(doc, opts = {}) {
  const sections = Array.isArray(doc.sections) && doc.sections.length ? doc.sections : newSections();
  // Names are put into their running-text form HERE as well as when they are
  // saved, so a document captured before the title rules existed still prints
  // "Ing Kwaku Koranteng" rather than the listing form "Kwaku Koranteng (Ing)".
  const p = prosePeople(doc.proceedings || {}, opts.members || []);
  const correspondence = opts.correspondence || [];
  // A letter visitors brought prints under Correspondence as usual and the
  // visit refers to it by item number. The number is not known until the rows
  // are numbered, so a marker ⟦L:id⟧ stands in and is replaced at the end.
  // A letter from an EARLIER meeting comes in opts.earlierLetters
  // { [id]: { no, date } } (routes/minutes.js earlierLettersFor).
  const letterCtx = {
    letterRef: (id) => {
      if (correspondence.some(c => String(c.id) === String(id))) return { current: true, no: `⟦L:${id}⟧` };
      const e = (opts.earlierLetters || {})[String(id)];
      return e ? { current: false, no: e.no || '', date: e.date || '' } : null;
    },
  };
  const named = (v) => (v ? resolveName(opts.members || [], v) : v);
  // Which report slots actually carry a report: typed text, the Treasurer's
  // figures (Church Finance), or a motion. The lead-in counts only those.
  const financeShown = !!(doc.finance && hasFinanceFigures(doc.finance));
  const presented = c => !!(String(c.body || '').trim() || c.table
    || (/finance/i.test(c.subject || '') && financeShown)
    || (Array.isArray(c.motions) && c.motions.length));
  const repSec = sections.find(s => s.key === 'reports');
  const reportsPresented = repSec && Array.isArray(repSec.children) ? repSec.children.filter(presented).length : 0;
  // Visitors print as items of their own under Presentation (3.1, 3.2 …),
  // opened by "The following presentation(s) was/were received."
  const visitorItems = VisitorsText.visitorsItems(p.visitors, letterCtx);
  const metaFor = key => (key === 'reports'
    ? { ...meta('reports'), lead: n => (reportsPresented === 0 ? NO_REPORTS : meta('reports').lead(reportsPresented)) }
    : key === 'presentation' && visitorItems.length
      ? { ...meta('presentation'), container: true, lead: () => VisitorsText.visitorsLeadLine(visitorItems.length) }
      : meta(key));
  // Motions print with their people in running-text form too.
  const prose = (list) => (Array.isArray(list) ? list.map((m) => ({ ...m, movedBy: named(m.movedBy), secondedBy: named(m.secondedBy) })) : list);

  // The numbering, the lead-ins and the motions are @deontech/minutes; what
  // the Session's sections say for themselves is this file's.
  // A closure the Clerk typed himself still records the Grace and the
  // benediction, unless his own words already mention them.
  const rite = closingRiteSentence(p);
  const withRite = (s) => (s.key === 'closure' && rite && String(s.body || '').trim()
    && !/\b(grace|benediction)\b/i.test(s.body) ? { ...s, body: `${String(s.body).trim()} ${rite}` } : s);
  // Text typed into an item's box that the app now writes for itself, and
  // would otherwise print twice or contradict it (seen 5 Nov 2026):
  //  - "No presentation" left in the Presentation box once visitors are added;
  //  - a Review of Minutes lead-in restating the review ("X led the Session to
  //    review minutes of …"), which item 4.1 already says — the standard
  //    "The following minutes was reviewed." is used instead.
  const reviewGenerated = (s) => s.key === 'review' && !(Array.isArray(s.children) && s.children.length);
  const dropRepeat = (s) => {
    const b = String(s.body || '').trim();
    if (!b) return s;
    if (s.key === 'presentation' && visitorItems.length && /^(there (was|were) )?no presentations?\b/i.test(b)) return { ...s, body: '' };
    if (reviewGenerated(s) && /\breview/i.test(b) && /\bminutes?\b/i.test(b)) return { ...s, body: '' };
    return s;
  };
  const rows = MIN.renderSections(sections.map(withRite).map(dropRepeat).map((s) => ({ ...s, motions: prose(s.motions),
    children: Array.isArray(s.children) ? s.children.map((c) => (c.motions ? { ...c, motions: prose(c.motions) } : c)) : s.children })), {
    meta: metaFor,
    auto: (sec) => (sec.key === 'presentation' && visitorItems.length ? VisitorsText.visitorsLeadLine(visitorItems.length) : autoBody(sec.key, p, letterCtx)),
    motion: { nextMeeting: 'to the next meeting' },
    // Children: from the register for Correspondence, generated for Review,
    // otherwise whatever the clerk typed.
    children: (sec) => {
      if (meta(sec.key).fromRegister && correspondence.length) {
        // What the letter said, then what the Session said about it — one
        // paragraph, as the minutes have always run them together.
        return correspondence.map(c => ({
          subject: c.heading || 'Correspondence',
          body: [String(c.summary || '').trim(), String(c.deliberation || '').trim()].filter(Boolean).join(' '),
          action: c.action || '',
          corrId: c.id,
        }));
      }
      if (sec.key === 'presentation' && visitorItems.length) return visitorItems;
      const children = Array.isArray(sec.children) ? sec.children.slice() : [];
      if (sec.key === 'review' && !children.length) return reviewChildren(doc, { clerk: opts.clerk, members: opts.members });
      // No report at all: one sentence under Reports, no empty headings.
      if (sec.key === 'reports' && reportsPresented === 0) return [];
      return children;
    },
    child: (sec, c, i) => {
      const m = meta(sec.key);
      // "Other Matters" sub-items are titled Other Matters I, II, III …
      const subject = m.roman
        ? `Other Matters ${roman(i + 1)}${c.subject && c.subject.trim() ? `: ${c.subject.trim()}` : ''}`
        : (c.subject || '').trim();
      // The Church Finance report prints the Treasurer's figures as the same
      // nested table the minutes have always carried.
      const isFinance = sec.key === 'reports' && /finance/i.test(c.subject || '');
      const table = c.table || (isFinance && doc.finance && hasFinanceFigures(doc.finance) ? financeGrid(doc.finance) : null);
      const blankReport = sec.key === 'reports' && !presented(c) && !table;
      return {
        subject,
        body: (c.body || '').trim() || (table && isFinance ? financeLead(doc.finance) : '') || (blankReport ? NO_REPORT : ''),
        table,
        underline: !!c.underline,
        ...(c.corrId != null ? { corrId: c.corrId } : {}),
      };
    },
  });
  // Put the letters' item numbers in place of their markers.
  const nos = {};
  rows.forEach(r => { if (r.corrId != null) nos[String(r.corrId)] = r.no; });
  rows.forEach(r => {
    if (!r.body || r.body.indexOf('⟦L:') === -1) return;
    r.body = r.body
      .replace(/item ⟦L:([^⟧]+)⟧ under /g, (m, id) => (nos[id] ? `item ${nos[id]} under ` : ''))
      .replace(/ ?⟦L:([^⟧]+)⟧/g, (m, id) => (nos[id] ? ` ${nos[id]}` : ''));
  });
  rows.forEach(r => { delete r.corrId; });
  // Every time in the text in the minutes' style — "6:46pm", "9:00 PM",
  // "9 a.m." typed in a box or a letter's summary print as "6:46 pm" etc.
  rows.forEach(r => {
    if (r.body) r.body = VisitorsText.fixTimes(r.body);
    if (r.subject) r.subject = VisitorsText.fixTimes(r.subject);
  });
  return rows;
}

// ---- Agenda ----------------------------------------------------------------
// Agenda rows are { mins, item, responsible, subItems:[] }. The clock is
// computed from the meeting's start time and each row's duration, so changing
// one duration re-times the whole agenda — exactly how the AOTC agenda reads
// ("6:30 pm (8 mins)", "6:38 pm (1 min)" …).
// parseTime, fmtTime and computeAgenda come from @deontech/minutes.

// Seed the minutes sections from the agenda: any agenda row that isn't one of
// the standing sections becomes a sub-item under Main Business, and agenda
// sub-items become sub-items of their matching section.
const STANDING = /(devotion|constitut|roll|apolog|presentation|review of minutes|matters arising|correspondence|other matters|prayer|closure|closing|holy communion|main business|report)/i;
function seedSectionsFromAgenda(sections, agendaRows) {
  const out = sections.map(s => ({ ...s, children: (s.children || []).slice() }));
  const find = k => out.find(s => s.key === k);
  const rows = Array.isArray(agendaRows) ? agendaRows : [];

  rows.forEach(r => {
    const item = String(r.item || '').trim();
    if (!item) return;
    const subs = (Array.isArray(r.subItems) ? r.subItems : [])
      .map(s => String(s.item || s || '').trim()).filter(Boolean);
    const lower = item.toLowerCase();

    let target = null;
    if (/matters arising/.test(lower)) target = find('matters');
    else if (/main business/.test(lower)) target = find('main');
    else if (/report/.test(lower)) target = find('reports');
    else if (/correspondence/.test(lower)) target = find('correspondence');
    else if (/other matters/.test(lower)) target = find('other');

    if (target) {
      if (target.key === 'reports' && subs.length) target.enabled = true;
      subs.forEach(s => {
        if (!target.children.some(c => (c.subject || '').toLowerCase() === s.toLowerCase())) {
          target.children.push({ subject: s, body: '', action: '', fromAgenda: true });
        }
      });
      return;
    }
    // Not a standing item and not a known container → real business.
    if (!STANDING.test(lower)) {
      const main = find('main');
      if (main && !main.children.some(c => (c.subject || '').toLowerCase() === lower)) {
        main.children.push({ subject: item, body: '', action: '', fromAgenda: true });
      }
      subs.forEach(s => {
        if (main && !main.children.some(c => (c.subject || '').toLowerCase() === s.toLowerCase())) {
          main.children.push({ subject: s, body: '', action: '', fromAgenda: true });
        }
      });
    }
  });
  return out;
}

// A blank minutes document for a given date.
// ---- Regular sittings and emergency sittings --------------------------------
// The Session sits regularly, and now and then it is called together urgently.
// Which of the two a meeting was is not decoration: the minutes are headed by
// it, and next month's agenda has to say "Review of minutes for 14th May 2026
// Emergency Session Meeting" rather than quietly calling it an ordinary one.
//
// So it is settled at scheduling, where the Clerk knows the answer, and carried
// on the document from then on. `title` stays the field the documents read, so
// nothing downstream had to change; the kind is what decides the title.
const MEETING_KINDS = [
  { key: 'regular', label: 'Session Meeting',
    note: 'the Session sitting to its ordinary calendar' },
  { key: 'emergency', label: 'Emergency Session Meeting',
    note: 'the Session called together urgently' },
];
function meetingKind(key) {
  return MEETING_KINDS.find(k => k.key === key) || MEETING_KINDS[0];
}
// The kind of a document already in the app. Documents created before this
// existed carry no kind, so an emergency sitting is recognised from the title
// the Clerk typed — which is how they were distinguished until now.
function meetingKindOf(doc) {
  const stored = String((doc && doc.meetingKind) || '').trim();
  if (MEETING_KINDS.some(k => k.key === stored)) return stored;
  return /emergenc/i.test(String((doc && doc.title) || '')) ? 'emergency' : 'regular';
}
// What to call the meeting in a sentence. A title the Clerk wrote himself is
// respected — "Joint Session and Committee Sitting" is nobody's business to
// rewrite — but the two standard kinds are always named the standard way, so a
// legacy "AOTC Session Meeting" reads as "Session Meeting" on next month's
// agenda instead of dragging the prefix along.
const STANDARD_TITLE = /^(aotc\s+|pcg[\s-]*aotc\s+)?(emergency\s+)?session\s+meeting$/i;
function meetingTitleOf(doc) {
  const title = String((doc && doc.title) || '').trim();
  if (title && !STANDARD_TITLE.test(title)) return title;
  return meetingKind(meetingKindOf(doc)).label;
}

function newMinutesDoc(fields = {}) {
  const mk = meetingKind(fields.meetingKind);
  return {
    kind: fields.kind || 'session',
    // Which of the two kinds of sitting this was. The title follows from it
    // unless the Clerk wrote something of his own.
    meetingKind: mk.key,
    title: fields.title || mk.label,
    date: fields.date || '',
    venue: fields.venue || '',
    startTime: fields.startTime || '18:30',
    status: 'draft',
    meetingId: fields.meetingId || null,
    entityType: fields.entityType || null,
    entityId: fields.entityId || null,
    entityName: fields.entityName || '',
    agenda: [],
    roll: { presentIds: [], apologyIds: [], absentIds: [], onlineIds: [], guests: [] },
    proceedings: {},
    sections: newSections(),
    appendices: [],
  };
}

module.exports = {
  POSITIONS, SEED_ROSTER, seedRoster, byRank,
  OFFICES, officeByKey, officeKeyForPosition, officeOf, memberKind, isAgent,
  agentsOf, officeTable, linguistOf,
  TITLES, TITLE_DEFS, titleDef, titlesOf, splitName,
  displayName, proseName, needsTitle, carriesTitle, matchMember, titledNames, bareName,
  resolveName, resolveNameList, PERSON_KEYS,
  MATTER_STATUSES, isMatterOpen, matterStatus, matterAge, matterFlag,
  summariseMatters, mattersFromDoc,
  SECTION_TEMPLATE, REPORT_SLOTS, NO_REPORT, NO_REPORTS, newSections, newMinutesDoc,
  renderRows, reviewChildren, autoBody, roman,
  computeAgenda, seedSectionsFromAgenda, agendaNames, orphanedFromAgenda, parseTime, fmtTime,
  retitleText, eligibility, presentIdsOf, correctionChildren, reviewBlocks, bulletise, closingRite, isSameMember,
  surnameOf, mentionsOf, learnShortForms, DECISION_LINE, continuingMatter, minuteTime,
  matterHeading, groupByHeading, isCatchAllHeading, shortHeading, shortSubject, headingFor,
  MEETING_KINDS, meetingKind, meetingKindOf, meetingTitleOf,
  rosterPosition,
  autoBody, prosePeople,
  reviewOptions, ordinalDate, ordinalDay,
  halfOf, halfLabel, sundayOnOrBefore, sundaysInHalf, podOnDuty, podLabel,
  isCoOpted, coOptionNote, coOptionExpired, sessionAttendance,
  DEFAULT_ACCOUNTS, FINANCE_INPUTS, newFinance, computeFinance, financeGrid,
  hasFinanceFigures, financeLead, money, num,
  openItemsOf,
};
