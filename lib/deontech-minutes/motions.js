// Motions as records, not prose.
//
// A motion is { text, movedBy, secondedBy, result, votes: { for, against,
// abstain }, unanimous, note }. Kept as a record it can be counted, searched and
// listed in a decisions register; printed, it reads as the minutes have always
// put it:
//
//   Motion: Ing Kojo Antwi Badu moved that the final payment be released, and
//   Mrs Ama Serwaa Ofori seconded the motion. The motion was carried by 12
//   votes to 3, with 2 abstentions.
//
// The "Motion:" label is set in italics in Word and PDF, as "Decision:" is.
'use strict';

const { BLANK } = require('./text');

const RESULTS = {
  carried: 'Carried',
  lost: 'Lost',
  withdrawn: 'Withdrawn',
  deferred: 'Deferred',
  pending: 'Not yet put',
};

const clean = (v) => String(v == null ? '' : v).trim();
const n = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Math.max(0, Math.floor(Number(v))));

// One motion, tidied: unknown results become "pending", counts become whole
// numbers or null, and the text loses a leading "That"/"that" and its final
// full stop so it can follow "moved that".
function normaliseMotion(m) {
  const x = m && typeof m === 'object' ? m : {};
  const v = x.votes && typeof x.votes === 'object' ? x.votes : {};
  const text = clean(x.text).replace(/^that\s+/i, '').replace(/[.\s]+$/, '');
  return {
    text,
    movedBy: clean(x.movedBy),
    secondedBy: clean(x.secondedBy),
    result: RESULTS[x.result] ? x.result : 'pending',
    votes: { for: n(v.for), against: n(v.against), abstain: n(v.abstain) },
    unanimous: !!x.unanimous,
    note: clean(x.note),
  };
}

const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

// "by 12 votes to 3, with 2 abstentions"
function tally(v) {
  if (v.for == null && v.against == null) return '';
  const a = v.for || 0, b = v.against || 0;
  let s = ` by ${plural(a, 'vote')} to ${b}`;
  if (v.abstain) s += `, with ${plural(v.abstain, 'abstention')}`;
  return s;
}

// The sentence. `opts.label` defaults to "Motion:"; `opts.nextMeeting` words a
// deferral ("to the next meeting", "to the next Assembly").
function motionSentence(m, opts = {}) {
  const x = normaliseMotion(m);
  const label = opts.label === undefined ? 'Motion:' : opts.label;
  const mover = x.movedBy || BLANK;
  let s = `${mover} moved that ${x.text || BLANK}`;
  s += x.secondedBy ? `, and ${x.secondedBy} seconded the motion.` : '.';
  if (x.result === 'carried') s += x.unanimous ? ' The motion was carried unanimously.' : ` The motion was carried${tally(x.votes)}.`;
  else if (x.result === 'lost') s += ` The motion was lost${tally(x.votes)}.`;
  else if (x.result === 'withdrawn') s += ' The motion was withdrawn.';
  else if (x.result === 'deferred') s += ` The motion was deferred ${opts.nextMeeting || 'to the next meeting'}.`;
  if (x.note) s += ` ${x.note.replace(/[.\s]*$/, '.')}`;
  return (label ? label + ' ' : '') + s;
}

// The motions of an item as lines to append to its body, each on a line of its
// own so bulletise() sets it apart.
function motionLines(motions, opts = {}) {
  return (Array.isArray(motions) ? motions : [])
    .map(normaliseMotion)
    .filter((m) => m.text || m.movedBy)
    .map((m) => motionSentence(m, opts));
}

// Did it pass? Carried with a tally checks the tally against the threshold the
// meeting needs: 'majority' (more for than against) or 'two-thirds' of votes
// cast. Abstentions are not votes cast.
function passes(votes, threshold = 'majority') {
  const a = n(votes && votes.for) || 0, b = n(votes && votes.against) || 0;
  if (a + b === 0) return false;
  return threshold === 'two-thirds' ? a * 3 >= (a + b) * 2 : a > b;
}

// What a server keeps from a request: at most `max` motions, each normalised
// and cut to sensible lengths, empty ones dropped.
function cleanMotions(list, { max = 20 } = {}) {
  return (Array.isArray(list) ? list : []).slice(0, max).map(normaliseMotion)
    .map((m) => ({ ...m, text: m.text.slice(0, 2000), movedBy: m.movedBy.slice(0, 120), secondedBy: m.secondedBy.slice(0, 120), note: m.note.slice(0, 500) }))
    .filter((m) => m.text || m.movedBy);
}

module.exports = { RESULTS, normaliseMotion, motionSentence, motionLines, passes, cleanMotions };
