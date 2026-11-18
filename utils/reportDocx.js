// AOTC Track — Word report generator (Phase 4).
// Reproduces the committee (CLAN-style) and group (JY-style) quarterly
// report formats from assembled data. Uses the `docx` package.
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, VerticalAlign,
  ImageRun, Footer, PageNumber,
} = require('docx');
const fs = require('fs');
const path = require('path');
const { toLocalDate } = require('./dates');
const CREST = path.join(__dirname, '..', 'public', 'img', 'logo.png');

const FONT = 'Times New Roman';
const SZ = 24; // 12pt (half-points)

function t(text, opts = {}) {
  return new TextRun({ text: String(text === null || text === undefined ? '' : text), font: FONT, size: opts.size || SZ, bold: !!opts.bold, italics: !!opts.italics });
}
function p(text, opts = {}) {
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { after: opts.after !== undefined ? opts.after : 120 },
    children: Array.isArray(text) ? text : [t(text, opts)],
  });
}
function heading(text) { return p(text, { bold: true, after: 80 }); }
function cell(content, opts = {}) {
  const paras = (Array.isArray(content) ? content : [content]).map(x =>
    x instanceof Paragraph ? x : new Paragraph({ alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT, children: [t(x, { bold: !!opts.bold, size: opts.size || 20 })] }));
  return new TableCell({
    children: paras, verticalAlign: VerticalAlign.CENTER,
    columnSpan: opts.colSpan, rowSpan: opts.rowSpan,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.shade ? { fill: 'E8ECF5' } : undefined,
  });
}
function table(rows) {
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}
function fmtVal(v, unit) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if ((unit || '') === '%') return (Math.abs(v) <= 1 ? (v * 100) : v).toFixed(1).replace(/\.0$/, '');
    return v.toLocaleString();
  }
  return String(v);
}
function today() {
  const d = new Date();
  const day = d.getDate();
  const suf = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suf} ${d.toLocaleDateString('en-GB', { month: 'long' })}, ${d.getFullYear()}`;
}

function buildReport(data, kind /* 'quarterly' */) {
  const children = [];
  const isCom = data.isCommittee;
  const title = isCom ? `COMMITTEE ON ${data.entity.name.toUpperCase()}` : data.entity.name.toUpperCase();

  // ---- Letterhead (same as PDF: name, crest, congregation, rule) ----
  children.push(p([t('Presbyterian Church of Ghana', { bold: true, size: 28 })], { center: true, after: 60 }));
  try {
    if (fs.existsSync(CREST)) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 60 },
        children: [new ImageRun({ data: fs.readFileSync(CREST), transformation: { width: 83, height: 94 }, type: 'png' })],
      }));
    }
  } catch (e) { /* crest optional */ }
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '1D3F94', space: 6 } },
    children: [t('Adabraka Official Town Congregation', { bold: true, size: 23 })],
  }));
  children.push(p(title, { bold: true, center: true, after: 40 }));
  children.push(p(`${data.ordinal.toUpperCase()} QUARTER REPORT FOR YEAR ${data.year}`, { bold: true, center: true, after: 240 }));

  // ---- Preamble ----
  children.push(heading('Preamble'));
  children.push(p(data.narrative.preamble || '—', { after: 200 }));

  // ---- Membership ----
  const sigs = data.entity.signatories || {};
  const ordered = [...data.members].sort((a, b) => (a.position === 'Member') - (b.position === 'Member'));
  children.push(heading(isCom ? 'Membership' : 'Executives'));
  if (isCom) children.push(p(`Committee Membership – ${data.members.length}`, { after: 80 }));
  children.push(table([
    new TableRow({ children: [
      cell('No.', { bold: true, shade: true, width: 8, size: SZ - 4 }),
      cell('Name', { bold: true, shade: true, width: 60, size: SZ - 4 }),
      cell('Position', { bold: true, shade: true, width: 32, size: SZ - 4 }),
    ] }),
    ...ordered.map((m, i) => new TableRow({ children: [
      cell(String(i + 1), { size: SZ - 4 }),
      cell(m.name, { size: SZ - 4 }),
      cell((m.position || 'Member') + (m.coopted ? ' (co-opted)' : ''), { size: SZ - 4 }),
    ] })),
  ]));
  children.push(p('', { after: 160 }));

  // ---- Meetings held (locked attendance) ----
  if (data.meetingSummary) {
    const ms = data.meetingSummary;
    children.push(heading('Meetings & Attendance'));
    children.push(p(`${ms.count} meeting(s) were held in the quarter: ${ms.dates.map(x => toLocalDate(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })).join(', ')}.`, { after: 100 }));
    children.push(table([
      new TableRow({ children: [
        cell('No.', { bold: true, shade: true, width: 6, size: 18 }),
        cell('Member', { bold: true, shade: true, width: 34, size: 18 }),
        cell('Position', { bold: true, shade: true, width: 20, size: 18 }),
        cell('Present', { bold: true, shade: true, width: 11, size: 18, center: true }),
        cell('Apology', { bold: true, shade: true, width: 11, size: 18, center: true }),
        cell('Absent', { bold: true, shade: true, width: 10, size: 18, center: true }),
        cell('%', { bold: true, shade: true, width: 8, size: 18, center: true }),
      ] }),
      ...ms.perMember.map((m, i) => new TableRow({ children: [
        cell(String(i + 1), { size: 18 }),
        cell(m.name + (m.flag === 'red' ? ' ⚠' : ''), { size: 18 }),
        cell(m.position, { size: 18 }),
        cell(String(m.present), { size: 18, center: true }),
        cell(String(m.apology), { size: 18, center: true }),
        cell(String(m.absent), { size: 18, center: true }),
        cell(m.pct == null ? '—' : m.pct + '%', { size: 18, center: true }),
      ] })),
    ]));
    // Flagged-members callout for the Session's attention.
    if (ms.flagged && ms.flagged.length) {
      children.push(p('', { after: 60 }));
      children.push(p('For the Session’s attention — attendance concerns:', { bold: true, after: 60 }));
      ms.flagged.forEach(m => {
        const reason = m.flag === 'red'
          ? `absent ${m.consecutiveAbsences} consecutive meeting(s) without apology`
          : `low attendance (${m.pct}% this quarter)`;
        children.push(p(`• ${m.name} (${m.position}) — ${reason}.`, { after: 20 }));
      });
    }
    children.push(p('', { after: 160 }));
  }

  // ---- Narrative sections ----
  children.push(heading('Notable Achievements and Events'));
  children.push(p(data.narrative.achievements || 'None.', { after: 160 }));
  children.push(heading(isCom ? 'Major Challenges' : 'Major Challenges:'));
  children.push(p(data.narrative.challenges || 'There were no challenges in the quarter under review.', { after: 160 }));
  if (data.narrative.recommendations) {
    children.push(heading('Recommendations'));
    children.push(p(data.narrative.recommendations, { after: 160 }));
  }

  // ---- Signatures ----
  const sec = sigs.secretary || sigs.assistant || {};
  const head = sigs.head || {};
  children.push(p('', { after: 200 }));
  children.push(table([
    new TableRow({ children: [cell('Signed', { size: SZ }), cell('Signed', { size: SZ })] }),
    new TableRow({ children: [cell(sec.name || '____________________', { size: SZ }), cell(head.name || '____________________', { size: SZ })] }),
    new TableRow({ children: [cell(`(${sec.title || 'Secretary'})`, { size: SZ }), cell(`(${head.title || (isCom ? 'Chairperson' : 'President')})`, { size: SZ })] }),
    new TableRow({ children: [cell(today(), { size: SZ }), cell(today(), { size: SZ })] }),
  ]));

  // ---- TABLES ----
  children.push(p('', { after: 200 }));
  children.push(p('TABLES', { bold: true, center: true, after: 160 }));
  children.push(heading('Table 1.0: Quarterly KPI Update'));
  const kpiHeader = new TableRow({ children: [
    cell('Code', { bold: true, shade: true, width: 8 }),
    cell('Goals', { bold: true, shade: true, width: 24 }),
    cell('Key Performance Indicators (KPI)', { bold: true, shade: true, width: 22 }),
    cell('Unit', { bold: true, shade: true, width: 6 }),
    cell('Previous Year Actual', { bold: true, shade: true, width: 8, center: true }),
    cell('Current Year Target', { bold: true, shade: true, width: 8, center: true }),
    cell('1st', { bold: true, shade: true, width: 6, center: true }),
    cell('2nd', { bold: true, shade: true, width: 6, center: true }),
    cell('3rd', { bold: true, shade: true, width: 6, center: true }),
    cell('4th', { bold: true, shade: true, width: 6, center: true }),
  ] });
  const kpiRows = data.kpiTable.map(r => new TableRow({ children: [
    cell(r.code, { size: 18 }), cell(r.goal, { size: 18 }), cell(r.kpi, { size: 18 }), cell(r.unit, { size: 18 }),
    cell(fmtVal(r.prevActual, r.unit), { size: 18, center: true }),
    cell(fmtVal(r.target, r.unit), { size: 18, center: true }),
    ...r.quarters.map(q => cell(fmtVal(q, r.unit), { size: 18, center: true })),
  ] }));
  children.push(table([kpiHeader, ...kpiRows]));

  // ---- Table 2.x per goal ----
  children.push(p('', { after: 160 }));
  children.push(heading(`Table 2 – ${isCom ? 'Committee' : 'Group'} Quarterly Performance`));
  let idx = 0;
  const actHeader = () => new TableRow({ children: [
    cell('No', { bold: true, shade: true, width: 5 }),
    cell('Strategies/Activities', { bold: true, shade: true, width: 35 }),
    cell('Targets Performance', { bold: true, shade: true, width: 20 }),
    cell('Actual Performance', { bold: true, shade: true, width: 20 }),
    cell('Remarks', { bold: true, shade: true, width: 20 }),
  ] });
  data.goalSections.forEach(sec2 => {
    idx += 1;
    children.push(p('', { after: 120 }));
    children.push(heading(`Table 2.${idx}`));
    children.push(table([
      new TableRow({ children: [cell('Code', { bold: true, width: 15 }), cell('Goal', { bold: true, width: 85 })] }),
      new TableRow({ children: [cell(sec2.code), cell(sec2.description)] }),
    ]));
    children.push(p('', { after: 60 }));
    children.push(table([actHeader(), ...sec2.activities.map((a, i) => new TableRow({ children: [
      cell(String(i + 1), { size: 18 }), cell(a.description, { size: 18 }),
      cell(a.target, { size: 18 }), cell(a.actual, { size: 18 }), cell(a.remarks, { size: 18 }),
    ] }))]));
  });
  if (data.generalActivities.length) {
    idx += 1;
    children.push(p('', { after: 120 }));
    children.push(heading(`Table 2.${idx} — Other Activities`));
    children.push(table([actHeader(), ...data.generalActivities.map((a, i) => new TableRow({ children: [
      cell(String(i + 1), { size: 18 }), cell(a.description, { size: 18 }),
      cell(a.target, { size: 18 }), cell(a.actual, { size: 18 }), cell(a.remarks, { size: 18 }),
    ] }))]));
  }

  const doc = new Document({
    creator: 'AOTC Track',
    description: `${data.entity.name} ${data.ordinal} Quarter Report ${data.year}`,
    sections: [{
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', font: FONT, size: 17 }),
              new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 17 }),
              new TextRun({ text: ' of ', font: FONT, size: 17 }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 17 }),
            ],
          })],
        }),
      },
      properties: {
        page: {
          // A4: 210mm x 297mm (11906 x 16838 twips), 1in top/bottom, 0.9in sides
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, bottom: 1440, left: 1296, right: 1296 },
        },
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildReport };

// ---- Congregational consolidated report (AOT format, Word) ----
async function buildCongregationDocx(data) {
  const children = [];
  children.push(p([t('Presbyterian Church of Ghana', { bold: true, size: 28 })], { center: true, after: 60 }));
  try {
    if (fs.existsSync(CREST)) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 60 },
        children: [new ImageRun({ data: fs.readFileSync(CREST), transformation: { width: 83, height: 94 }, type: 'png' })],
      }));
    }
  } catch (e) {}
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '1D3F94', space: 6 } },
    children: [t('Adabraka Official Town Congregation', { bold: true, size: 23 })],
  }));
  children.push(p(`${data.ordinal.toUpperCase()} QUARTER REPORT FOR ${data.year}`, { bold: true, center: true, after: 240 }));

  children.push(heading('Preamble'));
  children.push(p(data.narrative.preamble || '—', { after: 160 }));
  if (data.membershipTable && data.membershipTable.rows.length) {
    children.push(heading('Update on Membership Statistics'));
    children.push(table([
      new TableRow({ children: data.membershipTable.header.map((h, i) =>
        cell(h, { bold: true, shade: true, width: i === 0 ? 22 : 13, center: i > 0, size: 18 })) }),
      ...data.membershipTable.rows.map(r => new TableRow({ children: r.map((v, i) =>
        cell(String(v), { width: i === 0 ? 22 : 13, center: i > 0, size: 18 })) })),
    ]));
    children.push(p('', { after: 100 }));
  }
  if (data.narrative.financial) {
    children.push(heading('Financial Report'));
    children.push(p(data.narrative.financial, { after: 160 }));
  }
  children.push(heading('Notable Achievements and Events'));
  children.push(p(data.narrative.achievements || 'None.', { after: 160 }));
  children.push(heading('Major Challenges'));
  children.push(p(data.narrative.challenges || 'None.', { after: 160 }));
  children.push(heading('Recommendation'));
  children.push(p(data.narrative.recommendations || 'None.', { after: 240 }));

  children.push(table([
    new TableRow({ children: [
      cell((data.sessionClerk || '____________________').toUpperCase(), { bold: true, size: SZ }),
      cell((data.minister || '____________________').toUpperCase(), { bold: true, size: SZ }),
    ] }),
    new TableRow({ children: [cell('(SESSION CLERK)', { size: SZ }), cell('(MINISTER-IN-CHARGE)', { size: SZ })] }),
  ]));

  children.push(p('', { after: 200 }));
  children.push(p('TABLES', { bold: true, center: true, after: 160 }));
  data.sections.forEach(sec => {
    children.push(heading(sec.title));
    children.push(table([
      new TableRow({ children: [
        cell('Code', { bold: true, shade: true, width: 10 }),
        cell('Goals', { bold: true, shade: true, width: 32 }),
        cell('Key Performance Indicators (KPI)', { bold: true, shade: true, width: 32 }),
        cell('Unit', { bold: true, shade: true, width: 10 }),
        cell(`Q${data.quarter}`, { bold: true, shade: true, width: 16, center: true }),
      ] }),
      ...sec.rows.map(r => new TableRow({ children: [
        cell(r.code, { size: 18 }), cell(r.goal, { size: 18 }), cell(r.kpi, { size: 18 }),
        cell(r.unit, { size: 18 }),
        cell(r.value === null || r.value === undefined ? '' : (typeof r.value === 'number' ? r.value.toLocaleString() : String(r.value)), { size: 18, center: true }),
      ] })),
    ]));
    children.push(p('', { after: 120 }));
  });

  // ---- Attendance concerns for the Session (roll-up across all bodies) ----
  if (data.attendanceFlags && data.attendanceFlags.length) {
    children.push(p('', { after: 120 }));
    children.push(heading('Attendance Concerns for the Session'));
    children.push(table([
      new TableRow({ children: [
        cell('Committee / Group', { bold: true, shade: true, width: 34, size: 18 }),
        cell('Member', { bold: true, shade: true, width: 30, size: 18 }),
        cell('Position', { bold: true, shade: true, width: 20, size: 18 }),
        cell('Concern', { bold: true, shade: true, width: 16, size: 18 }),
      ] }),
      ...data.attendanceFlags.map(f => new TableRow({ children: [
        cell(f.entity, { size: 18 }), cell(f.member, { size: 18 }), cell(f.position, { size: 18 }),
        cell(f.flag === 'red' ? `${f.consecutiveAbsences} consecutive absences (no apology)` : `low attendance (${f.pct}%)`, { size: 18 }),
      ] })),
    ]));
    children.push(p('', { after: 120 }));
  }

  const doc = new Document({
    creator: 'AOTC Track',
    sections: [{
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', font: FONT, size: 17 }),
              new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 17 }),
              new TextRun({ text: ' of ', font: FONT, size: 17 }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 17 }),
            ],
          })],
        }),
      },
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1296, right: 1296 } } },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

module.exports.buildCongregationDocx = buildCongregationDocx;
