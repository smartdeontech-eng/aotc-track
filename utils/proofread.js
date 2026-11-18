// Reading a proofread Word file back into the minutes (Oct 2026).
//
// The proofreader works on the Word minutes the app exported, with Track
// Changes on, and adds comments. The app is the record — the Word file is made
// FROM it — so a correction accepted only in Word is lost the next time the
// minutes are exported. This reads the tracked changes and the comments out of
// the .docx, finds each one's paragraph in the minutes held in the app, and
// lets the Session Clerk accept or reject each change, and answer each comment
// with a directive. Accepted text is written into the item itself.
//
// Parsing is deliberately plain: document.xml is walked paragraph by paragraph
// and run by run. <w:ins> text is the proofreader's addition, <w:del>/<w:delText>
// his deletion. "Before" is the paragraph as the app exported it (deletions in,
// insertions out); "after" is the paragraph as he left it.
const JSZip = require('jszip');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] !== undefined ? ENT[e] : m;
});
const norm = s => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

// The Word file draws every list point with a bullet (and the renderer turns
// lines after a lead-in ending in ":" into points), while the app stores the
// line bare or with the Clerk's own "-". Compare without the marker, and keep
// the stored marker when writing back — otherwise an untouched point reads as
// "edited since export" and loses its Accept button.
const MARK = /^\s*[-*•–—]\s+/;
// The printed minutes write titles without a full stop ("Rev Kofi", "Ms Betty")
// while older text in the app may carry one ("Rev. Kofi") — not an edit.
const TITLE_DOT = /\b(very rev|rt rev|rev|dr|mr|mrs|ms|prof|ing|esq|mad|hon|barr)\./g;
const bare = s => norm(String(s || '').replace(MARK, '')).replace(TITLE_DOT, '$1');
const withMarker = (stored, text) => { const m = String(stored || '').match(MARK); return (m ? m[0] : '') + String(text || '').replace(MARK, ''); };
// An item's heading prints as its subject, or as "Other Matters I: <subject>".
const headingMatches = (heading, subject) => { const h = bare(heading), s = bare(subject); return !!s && (h === s || h.endsWith(': ' + s)); };
// The new subject from a corrected heading, keeping any printed prefix out of it.
function subjectFrom(beforeHeading, afterHeading, storedSubject) {
  if (bare(beforeHeading) === bare(storedSubject)) return String(afterHeading || '').trim();
  const pos = String(beforeHeading).length - String(storedSubject).trim().length;
  const prefix = String(beforeHeading).slice(0, pos);
  if (!/:\s*$/.test(prefix) || !String(afterHeading).startsWith(prefix)) return null;
  return String(afterHeading).slice(prefix.length).trim() || null;
}

async function parseProofread(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw Object.assign(new Error('That is not a Word (.docx) file.'), { status: 400 });
  const xml = await docFile.async('string');

  // Comments: id → { author, text }
  const comments = new Map();
  const cf = zip.file('word/comments.xml');
  if (cf) {
    const cx = await cf.async('string');
    for (const m of cx.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
      const id = (m[1].match(/w:id="([^"]+)"/) || [])[1];
      const author = unxml((m[1].match(/w:author="([^"]*)"/) || [])[1] || '');
      const text = [...m[2].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
        .map(p => [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(t => unxml(t[1])).join('')).filter(Boolean).join('\n');
      if (id) comments.set(id, { id, author, text, anchor: '', para: null });
    }
  }

  const paragraphs = [];
  const open = new Set();          // comment ranges currently open
  const authors = new Set();
  let words = 0, insCount = 0, delCount = 0, corrections = 0;
  const paraRe = /<w:p\b(?:[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
  for (const pm of xml.matchAll(paraRe)) {
    const body = pm[1] || '';
    const segs = [];                // { mode: ''|'ins'|'del', text }
    let mode = '';
    const tokRe = /<w:ins\b([^>]*)>|<\/w:ins>|<w:del\b([^>]*)>|<\/w:del>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:delText(?:\s[^>]*)?>([^<]*)<\/w:delText>|<w:tab\/>|<w:br\/>|<w:commentRangeStart\b[^>]*w:id="([^"]+)"[^>]*\/>|<w:commentRangeEnd\b[^>]*w:id="([^"]+)"[^>]*\/>/g;
    const startHere = [];
    for (const t of body.matchAll(tokRe)) {
      const s = t[0];
      if (s.startsWith('<w:ins')) { mode = 'ins'; const a = (t[1].match(/w:author="([^"]*)"/) || [])[1]; if (a) authors.add(unxml(a)); continue; }
      if (s === '</w:ins>' || s === '</w:del>') { mode = ''; continue; }
      if (s.startsWith('<w:del ') || s === '<w:del>') { mode = 'del'; const a = (t[2] || '').match(/w:author="([^"]*)"/); if (a) authors.add(unxml(a[1])); continue; }
      if (s.startsWith('<w:commentRangeStart')) { open.add(t[5]); startHere.push(t[5]); continue; }
      if (s.startsWith('<w:commentRangeEnd')) { open.delete(t[6]); continue; }
      let text = '';
      let m2 = mode;
      if (t[3] !== undefined) text = unxml(t[3]);
      else if (t[4] !== undefined) { text = unxml(t[4]); m2 = 'del'; }
      else if (s === '<w:tab/>') text = ' ';
      else if (s === '<w:br/>') text = ' ';
      if (!text) continue;
      const last = segs[segs.length - 1];
      if (last && last.mode === m2) last.text += text; else segs.push({ mode: m2, text });
      open.forEach(id => { const c = comments.get(id); if (c) c.anchor += (m2 === 'del' ? '' : text); });
    }
    const before = segs.filter(x => x.mode !== 'ins').map(x => x.text).join('');
    const after = segs.filter(x => x.mode !== 'del').map(x => x.text).join('');
    words += (after.match(/\S+/g) || []).length;
    const idx = paragraphs.length;
    const changed = segs.some(x => x.mode);
    if (changed) {
      insCount += segs.filter(x => x.mode === 'ins').length;
      delCount += segs.filter(x => x.mode === 'del').length;
      // One correction = one run of changed text: a deletion followed by its
      // replacement counts once, which is how a reader counts them.
      segs.forEach((x, i) => { if (x.mode && !(i > 0 && segs[i - 1].mode)) corrections += 1; });
    }
    startHere.forEach(id => { const c = comments.get(id); if (c && c.para === null) c.para = idx; });
    open.forEach(id => { const c = comments.get(id); if (c && c.para === null) c.para = idx; });
    paragraphs.push({ idx, before, after, changed, segs: changed ? segs : null });
  }
  return {
    authors: [...authors].concat([...comments.values()].map(c => c.author)).filter((a, i, l) => a && l.indexOf(a) === i),
    words, insCount, delCount, corrections,
    paragraphs,
    comments: [...comments.values()].map(c => ({ ...c, anchor: c.anchor.trim(), paraBefore: c.para !== null && paragraphs[c.para] ? paragraphs[c.para].before : '', paraAfter: c.para !== null && paragraphs[c.para] ? paragraphs[c.para].after : '' })),
  };
}

// Every piece of text in the minutes the Clerk can edit, line by line, with
// where it lives — so a paragraph of the Word file can be found again.
function editableLines(doc, meta) {
  const out = [];
  let n = 0;
  (doc.sections || []).forEach(sec => {
    if (!sec.enabled) return;
    n += 1;
    const m = (meta && meta(sec.key)) || {};
    const push = (ci, no, subject, body) => String(body || '').split('\n').forEach((line, li) => {
      if (line.trim()) out.push({ key: sec.key, ci, li, no, subject, text: line });
    });
    if (!m.generated && !m.fromRegister) push(-1, `${n}.0`, sec.subject || '', sec.body);
    (sec.children || []).forEach((c, ci) => {
      // The item's own heading can be corrected too.
      if (String(c.subject || '').trim()) out.push({ key: sec.key, ci, li: 'subject', no: `${n}.${ci + 1}`, subject: c.subject, text: c.subject, heading: true });
      push(ci, `${n}.${ci + 1}`, c.subject || sec.subject || '', c.body);
    });
  });
  return out;
}
const tokens = s => new Set(norm(s).split(/[^a-z0-9']+/).filter(w => w.length > 2));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let k = 0; A.forEach(x => { if (B.has(x)) k += 1; });
  return (2 * k) / (A.size + B.size);
}
// Where in the app this paragraph is. exact = the text there is still what was
// exported, so the change can be applied; close = the item has been edited since
// (the Clerk applies it by hand); none = generated text (devotion, review…) or
// not found.
function locate(lines, before) {
  const want = norm(before);
  if (!want) return { match: 'none' };
  const exact = lines.filter(l => (l.heading ? headingMatches(before, l.text) : bare(l.text) === bare(before)));
  if (exact.length === 1) return { match: 'exact', ...pick(exact[0]) };
  if (exact.length > 1) return { match: 'exact', ...pick(exact[0]), ambiguous: true };
  let best = null, score = 0;
  lines.forEach(l => { const s = similarity(l.text, String(before).replace(MARK, '')); if (s > score) { score = s; best = l; } });
  if (best && score >= 0.7) return { match: 'close', score: Math.round(score * 100) / 100, ...pick(best) };
  return { match: 'none' };
}
const pick = l => ({ key: l.key, ci: l.ci, li: l.li, no: l.no, subject: l.subject, ...(l.heading ? { heading: true } : {}) });

// Carry the proofreader's tracked changes onto a paragraph the Clerk has edited
// since the export. Each change is found in the current text by its own words
// plus a little of the untouched text either side; a change whose words are no
// longer there (or appear twice) is left for the Clerk and reported, never
// guessed. Returns { text, applied, failed: [{ del, ins, left, right }] }.
function mergeSegs(current, segs) {
  const edits = [];
  let i = 0;
  while (i < (segs || []).length) {
    if (!segs[i].mode) { i += 1; continue; }
    let del = '', ins = '';
    const leftSeg = i > 0 && !segs[i - 1].mode ? segs[i - 1].text : '';
    while (i < segs.length && segs[i].mode) { if (segs[i].mode === 'del') del += segs[i].text; else ins += segs[i].text; i += 1; }
    const rightSeg = i < segs.length && !segs[i].mode ? segs[i].text : '';
    edits.push({ del, ins, left: leftSeg, right: rightSeg });
  }
  let text = String(current || '');
  let applied = 0;
  const failed = [];
  const count = (hay, needle) => { let n = 0, k = -1; while ((k = hay.indexOf(needle, k + 1)) >= 0) n += 1; return n; };
  edits.forEach(e => {
    let done = false;
    for (const w of [40, 25, 12, 6, 0]) {
      const L = w ? e.left.slice(-w) : '', R = w ? e.right.slice(0, w) : '';
      const needle = L + e.del + R;
      if (!needle.trim() || (!e.del && !L && !R)) continue;
      if (count(text, needle) !== 1) continue;
      const at = text.indexOf(needle) + L.length;
      text = text.slice(0, at) + e.ins + text.slice(at + e.del.length);
      applied += 1; done = true; break;
    }
    if (!done) failed.push({ del: e.del, ins: e.ins });
  });
  return { text, applied, failed, total: edits.length };
}

module.exports = { mergeSegs, parseProofread, editableLines, locate, norm, bare, withMarker, headingMatches, subjectFrom, similarity };
