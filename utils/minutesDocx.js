// AOTC Track — minutes template (.docx) generator.
// Produces the PCG-AOTC house minutes document for a HELD meeting. It uses the
// congregation's own Word template (templates/minutes-template.docx) as the
// BASE so the crest/logo header and the footer confidentiality mark are kept
// exactly, and only fills in the body: title, Members Present (Name + Position),
// Apologies/Absent, and the three-column body table (No. | Subject | Action)
// pre-scaffolded with the standard sections 1.0 Opening → 7.0 Closure.
// Attendance, agenda, previous-meeting date, times and the movers/seconders are
// filled from the recorded meeting; anything not captured stays as a blank
// (______) for the secretary to complete and correct in Word.
const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, VerticalAlign, BorderStyle } = require('docx');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const FONT = 'Times New Roman';
const BLANK = '__________';
const DEFAULT_TEMPLATE = path.join(__dirname, '..', 'templates', 'minutes-template.docx');

function t(text, opts = {}) {
  return new TextRun({ text: String(text == null ? '' : text), font: FONT, size: opts.size || 22, bold: !!opts.bold, italics: !!opts.italics });
}
function p(text, opts = {}) {
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { after: opts.after != null ? opts.after : 100, before: opts.before || 0 },
    children: Array.isArray(text) ? text : [t(text, opts)],
  });
}
function cell(children, opts = {}) {
  const paras = Array.isArray(children) ? children : [new Paragraph({ children: [t(children, opts)] })];
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    verticalAlign: VerticalAlign.TOP,
    shading: opts.shade ? { fill: 'E8ECF5' } : undefined,
    children: paras,
  });
}

function or(v) { return (v && String(v).trim()) ? String(v).trim() : BLANK; }

function presentTable(present) {
  const rows = [new TableRow({ tableHeader: true, children: [
    cell('No.', { bold: true, shade: true, width: 8 }),
    cell('Name', { bold: true, shade: true, width: 62 }),
    cell('Position', { bold: true, shade: true, width: 30 }),
  ] })];
  const list = (present && present.length) ? present : [];
  if (!list.length) rows.push(new TableRow({ children: [cell('1'), cell(''), cell('')] }));
  else list.forEach((m, i) => rows.push(new TableRow({ children: [cell(String(i + 1)), cell(m.name || ''), cell(m.position || 'Member')] })));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}
function nameLines(names) {
  const list = (names && names.length) ? names : [];
  if (!list.length) return [p('   — none —', { italics: true, after: 40 })];
  return list.map((n, i) => p(`${i + 1}. ${n}`, { after: 40 }));
}

function bodyTable(data) {
  const startNote = data.startTime ? ` (scheduled start ${data.startTime})` : '';
  const prev = or(data.previousDateStr);
  const agenda = (data.agendaItems && data.agendaItems.length) ? data.agendaItems : [''];
  const m = data.proceedings || {};

  const subj = (label, ...lines) => {
    const paras = [new Paragraph({ spacing: { after: lines.length ? 40 : 0 }, children: [t(label, { bold: true })] })];
    lines.forEach(l => paras.push(new Paragraph({ spacing: { after: 40 }, children: [t(l)] })));
    return paras;
  };
  const rows = [new TableRow({ tableHeader: true, children: [
    cell('No.', { bold: true, shade: true, width: 8 }),
    cell('Subject', { bold: true, shade: true, width: 67 }),
    cell('Action', { bold: true, shade: true, width: 25 }),
  ] })];
  const row = (no, subjectParas) => rows.push(new TableRow({ children: [cell(no), cell(subjectParas), cell([new Paragraph({}), new Paragraph({})])] }));

  row('1.0', subj('Opening', `The meeting commenced at ${or(m.commencedAt)}${startNote}. The opening ${data.openingKind || 'hymn/prayer'} was led by ${or(m.openingBy)}.`));
  row('2.0', subj('Constitution of the Meeting', `${or(m.constitutedBy)} duly constituted the meeting at ${or(m.constitutedAt)} in the name of the Triune God.`));
  row('3.0', subj('Review / Confirmation of Minutes',
    `The minutes of the meeting held on ${prev} were read and reviewed.`,
    `Their adoption was moved by ${or(m.minutesMovedBy)} and seconded by ${or(m.minutesSecondedBy)}.`));
  // Matters Arising: still-open action points from previous meetings, if any.
  const arising = (data.mattersArising && data.mattersArising.length) ? data.mattersArising : null;
  row('4.0', subj('Matters Arising', arising ? 'The following outstanding items from previous meetings were reviewed:' : 'The following were discussed under matters arising:'));
  if (arising) arising.forEach((it, i) => row(`4.${i + 1}`, subj('', it)));
  else row('4.1', subj('', BLANK));
  row('5.0', subj('Main Business', 'The following were discussed under main business:'));
  agenda.forEach((item, i) => row(`5.${i + 1}`, subj(item || BLANK, '')));
  row('6.0', subj('Other Matters (A.O.B.)', 'The following other matters were raised:'));
  row('6.1', subj('', BLANK));
  row('7.0', subj('Closure',
    `${or(m.closureMovedBy)} moved for the closure of the meeting at ${or(m.closedAt)}, and this was seconded by ${or(m.closureSecondedBy)}.`));

  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

// Optional standalone action-points table (the old template's grid) kept beneath
// the minutes in case a committee/group prefers a consolidated action list. It
// can simply be deleted in Word if the per-item Action column is enough.
function actionPointsTable(actions) {
  const header = new TableRow({ tableHeader: true, children: [
    cell('#', { bold: true, shade: true, width: 8 }),
    cell('Action point / decision', { bold: true, shade: true, width: 50 }),
    cell('Responsible', { bold: true, shade: true, width: 25 }),
    cell('Target date', { bold: true, shade: true, width: 17 }),
  ] });
  const rows = [header];
  const list = (actions && actions.length) ? actions : null;
  if (list) {
    list.forEach((a, i) => rows.push(new TableRow({ children: [
      cell(String(i + 1)),
      cell(`${a.text || ''}${a.done ? '  ✓ done' : ''}`),
      cell(a.responsible || ''),
      cell(a.targetDate || ''),
    ] })));
    // A couple of blank rows for anything added by hand.
    for (let i = 0; i < 2; i++) rows.push(new TableRow({ children: [cell(String(list.length + i + 1)), cell([new Paragraph({})]), cell([new Paragraph({})]), cell([new Paragraph({})])] }));
  } else {
    for (let i = 1; i <= 6; i++) rows.push(new TableRow({ children: [
      cell(String(i)), cell([new Paragraph({}), new Paragraph({})]), cell([new Paragraph({})]), cell([new Paragraph({})]),
    ] }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

function signatureBlock(sig = {}) {
  const secretary = sig.secretary || {};
  const head = sig.head || {};
  const line = () => new Paragraph({ spacing: { after: 20 }, children: [t('……………………………………')] });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } },
    rows: [new TableRow({ children: [
      cell([p('Recorded by', { bold: true, after: 120 }), line(), p(secretary.name || '', { after: 0 }), p(`(${secretary.title || 'Secretary'})`, { after: 0 })], { width: 50 }),
      cell([p('Confirmed by', { bold: true, after: 120 }), line(), p(head.name || '', { after: 0 }), p(`(${head.title || 'Chairperson / President'})`, { after: 0 })], { width: 50 }),
    ] })],
  });
}

// The body content (no letterhead — the base template's header supplies the
// crest/logo and church name).
function bodyChildren(data) {
  const children = [];
  children.push(p([t(`MINUTES OF ${data.entityName || ''} `, { bold: true }), t('HELD AT ', { bold: true }), t(or(data.venue), { bold: true }), t(' ON ', { bold: true }), t(or(data.dateStr), { bold: true })], { center: true, after: 200 }));
  children.push(p('MEMBERS PRESENT', { bold: true, after: 60 }));
  children.push(presentTable(data.present));
  children.push(p('MEMBERS WITH APOLOGIES', { bold: true, before: 160, after: 60 }));
  children.push(...nameLines(data.apologies));
  children.push(p('MEMBERS ABSENT', { bold: true, before: 120, after: 60 }));
  children.push(...nameLines(data.absent));
  children.push(p('', { before: 120, after: 40 }));
  children.push(bodyTable(data));
  children.push(p('ACTION POINTS', { bold: true, before: 220, after: 40 }));
  children.push(p('(Summary of action points / decisions — filled from the tracker; delete this section if the Action column above is enough.)', { italics: true, after: 80 }));
  children.push(actionPointsTable(data.actionPoints));
  children.push(p('', { after: 200 }));
  children.push(signatureBlock(data.signatories || {}));
  return children;
}

// Extract the inner XML of <w:body>…</w:body> minus the trailing sectPr.
function bodyInnerXml(documentXml) {
  const open = documentXml.match(/<w:body[^>]*>/);
  if (!open) return '';
  let inner = documentXml.slice(documentXml.indexOf(open[0]) + open[0].length);
  inner = inner.replace(/<\/w:body>\s*<\/w:document>\s*$/, '');
  // Drop the docx-generated sectPr (paired or self-closing) at the end.
  inner = inner.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>\s*$/, '').replace(/<w:sectPr[^>]*\/>\s*$/, '');
  return inner;
}

async function renderBodyOnlyXml(data) {
  const doc = new Document({ sections: [{ properties: {}, children: bodyChildren(data) }] });
  const buf = await Packer.toBuffer(doc);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  return bodyInnerXml(xml);
}

function xmlEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build by filling the congregation's own template (keeps header logo + footer).
async function buildFromBaseTemplate(data, templatePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('template has no document.xml');
  const docXml = await docFile.async('string');

  const open = docXml.match(/<w:body[^>]*>/);
  const sect = (docXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) || []).pop();
  if (!open || !sect) throw new Error('template body/sectPr not found');
  const head = docXml.slice(0, docXml.indexOf(open[0]) + open[0].length);
  const newBody = await renderBodyOnlyXml(data);
  const merged = head + newBody + sect + '</w:body></w:document>';
  zip.file('word/document.xml', merged);

  // Fill the footer's "(Committee/Group)" placeholder with the entity name.
  const footer = zip.file('word/footer1.xml');
  if (footer && data.entityName) {
    let fx = await footer.async('string');
    fx = fx.split('(Committee/Group)').join(xmlEscape(data.entityName));
    zip.file('word/footer1.xml', fx);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Fallback: a standalone document (used only if the base template file is
// missing on disk) — same body, with a simple text letterhead.
async function buildStandalone(data) {
  const children = [];
  children.push(p('PRESBYTERIAN CHURCH OF GHANA', { bold: true, center: true, size: 26, after: 20 }));
  children.push(p('Adabraka Official Town Congregation', { bold: true, center: true, size: 22, after: 160 }));
  children.push(...bodyChildren(data));
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

// data: { entityName, title, dateStr, startTime, venue, present:[{name,position}],
//   apologies:[names], absent:[names], agendaItems:[strings], previousDateStr,
//   proceedings:{ commencedAt, openingBy, constitutedBy, constitutedAt,
//     minutesMovedBy, minutesSecondedBy, closureMovedBy, closureSecondedBy,
//     closedAt, benedictionBy }, signatories:{ secretary, head } }
async function buildMinutesTemplate(data, opts = {}) {
  const templatePath = opts.templatePath || DEFAULT_TEMPLATE;
  try {
    if (fs.existsSync(templatePath)) return await buildFromBaseTemplate(data, templatePath);
  } catch (e) { /* fall back to standalone on any template error */ }
  return buildStandalone(data);
}

module.exports = { buildMinutesTemplate };
