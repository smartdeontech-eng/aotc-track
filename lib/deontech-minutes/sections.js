// Sections into numbered rows.
//
// The minutes are a list of sections, each switched on or off, each with an
// optional body and children. They print as the No. | Subject | Action table:
//
//   5.0  Matters Arising   The following were discussed under matters arising.
//   5.1  Roof repairs      …
//
// Switched-off sections are skipped and the numbering closes up behind them.
// What a section is called and what it says by itself comes from the app,
// through `meta(key)`:
//
//   { subject, prefix, container, lead, emptyBody, roman }
//
//   prefix     the app's own sentence (auto) OPENS the body; the clerk's text follows
//   container  the body is a lead-in agreeing with how many children follow:
//              lead(n) → "The following was …" / "The following were …"
//   emptyBody  what to say when there is nothing at all
//   roman      children are numbered "<subject> I: …", "II: …"
'use strict';

const { roman } = require('./text');
const { motionLines } = require('./motions');

const hasText = (c) => (c.subject && String(c.subject).trim()) || (c.body && String(c.body).trim()) || c.table
  || (Array.isArray(c.motions) && c.motions.length);

// hooks:
//   meta(key)                 → the section's description (above)
//   auto(sec)                 → the sentence the app writes from captured fields, or ''
//   children(sec, n)          → the children to print (defaults to sec.children)
//   child(sec, c, i, n)       → extra or overriding fields for a child row
//   motion                    → options for motionSentence (label, nextMeeting)
function renderSections(sections, hooks = {}) {
  const meta = hooks.meta || (() => ({}));
  const rows = [];
  let n = 0;
  (Array.isArray(sections) ? sections : []).filter((s) => s.enabled).forEach((sec) => {
    n += 1;
    const m = meta(sec.key) || {};
    let children = hooks.children ? hooks.children(sec, n) : (Array.isArray(sec.children) ? sec.children.slice() : []);
    children = (children || []).filter(hasText);

    let body = String(sec.body || '').trim();
    const auto = hooks.auto ? hooks.auto(sec) || '' : '';
    if (m.prefix) body = [auto, body].filter(Boolean).join('\n\n');
    else if (!body) body = auto;
    const leadFor = (k) => (typeof m.lead === 'function' ? m.lead(k) : (m.lead || ''));
    if (!body && m.container && children.length) body = leadFor(children.length);
    if (!body && m.emptyBody) body = m.emptyBody;
    if (!body && m.container && !children.length) body = leadFor(0);
    const own = motionLines(sec.motions, hooks.motion);
    if (own.length) body = [body, own.join('\n')].filter(Boolean).join('\n');

    rows.push({ no: `${n}.0`, subject: sec.subject || m.subject || '', body, action: String(sec.action || '').trim(), level: 0,
      ...(Array.isArray(sec.motions) && sec.motions.length ? { motions: sec.motions } : {}) });

    children.forEach((c, i) => {
      const subject = m.roman
        ? `${m.romanLabel || sec.subject || m.subject} ${roman(i + 1)}${c.subject && String(c.subject).trim() ? `: ${String(c.subject).trim()}` : ''}`
        : String(c.subject || '').trim();
      const row = { no: `${n}.${i + 1}`, subject, body: String(c.body || '').trim(), action: String(c.action || '').trim(), level: 1,
        ...(hooks.child ? hooks.child(sec, c, i, n) : {}) };
      const lines = motionLines(c.motions, hooks.motion);
      if (lines.length) row.body = [row.body, lines.join('\n')].filter(Boolean).join('\n');
      if (Array.isArray(c.motions) && c.motions.length) row.motions = c.motions;
      rows.push(row);
    });
  });
  return rows;
}

// Every decision in a set of rows: the motions as records, and any line the
// clerk labelled "Decision:". `extra(line)` may recognise older prose.
function decisionsOf(rows, extra) {
  const { bulletise } = require('./text');
  const { normaliseMotion } = require('./motions');
  const out = [];
  (rows || []).forEach((r) => {
    (r.motions || []).map(normaliseMotion).filter((m) => m.text || m.movedBy).forEach((m) => {
      out.push({ no: r.no || '', subject: r.subject || '', kind: 'motion', text: m.text, movedBy: m.movedBy,
        secondedBy: m.secondedBy, result: m.result, votes: m.votes, unanimous: m.unanimous, labelled: true });
    });
    bulletise(r.body || '').forEach((l) => {
      if (l.decision) { out.push({ no: r.no || '', subject: r.subject || '', kind: 'decision', text: l.text.replace(/^Decision:\s*/, ''), labelled: true }); return; }
      if (l.motion || !extra) return;
      String(l.text).split(/(?<=\.)\s+(?=[A-Z])/).forEach((sentence) => {
        if (extra(sentence.trim())) out.push({ no: r.no || '', subject: r.subject || '', kind: 'decision', text: sentence.trim(), labelled: false });
      });
    });
  });
  return out;
}

module.exports = { renderSections, decisionsOf };
