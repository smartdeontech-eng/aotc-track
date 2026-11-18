// AOTC Track — server-rendered PDF reports (Module H, report flavour).
// True A4 PDF with the PCG crest, viewable inline in the browser —
// same experience as the mainframe's invoice PDFs, extended with
// multi-page table flow for long quarterly reports.
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { toLocalDate } = require('./dates');

const A4 = { width: 595.28, height: 841.89 };
const M = { top: 60, bottom: 60, left: 46, right: 46 };
const USABLE = A4.width - M.left - M.right; // ~503pt
const CREST = path.join(__dirname, '..', 'public', 'img', 'logo.png');

function fmtVal(v, unit) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if ((unit || '') === '%') return (Math.abs(v) <= 1 ? v * 100 : v).toFixed(1).replace(/\.0$/, '') ;
    return v.toLocaleString();
  }
  return String(v);
}
function todayLong() {
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > A4.height - M.bottom) doc.addPage();
}

// Generic table with word-wrap + page-break handling (header redrawn per page)
function drawTable(doc, columns, rows, opts = {}) {
  const size = opts.size || 7.5;
  const headSize = opts.headSize || 7.5;
  const pad = 4;
  const widths = columns.map(c => c.width);

  function rowHeight(cells, fsize, bold) {
    doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(fsize);
    let h = 0;
    cells.forEach((text, i) => {
      const th = doc.heightOfString(String(text === null || text === undefined ? '' : text), { width: widths[i] - pad * 2 });
      h = Math.max(h, th);
    });
    return h + pad * 2;
  }
  function drawRow(cells, y, fsize, bold, shade) {
    const h = rowHeight(cells, fsize, bold);
    let x = M.left;
    if (shade) doc.rect(M.left, y, widths.reduce((a, b) => a + b, 0), h).fill('#EEF1F7');
    doc.fillColor('#000');
    cells.forEach((text, i) => {
      doc.rect(x, y, widths[i], h).lineWidth(0.5).stroke('#444');
      doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(fsize).fillColor('#000')
        .text(String(text === null || text === undefined ? '' : text), x + pad, y + pad, { width: widths[i] - pad * 2 });
      x += widths[i];
    });
    return h;
  }
  const header = columns.map(c => c.label);
  ensureSpace(doc, rowHeight(header, headSize, true) + 20);
  let y = doc.y;
  y += drawRow(header, y, headSize, true, true);
  rows.forEach(cells => {
    const h = rowHeight(cells, size, false);
    if (y + h > A4.height - M.bottom) {
      doc.addPage();
      y = doc.y;
      y += drawRow(header, y, headSize, true, true);
    }
    y += drawRow(cells, y, size, false, false);
  });
  doc.y = y + 10;
  doc.x = M.left;
}

function sectionHeading(doc, text) {
  ensureSpace(doc, 40);
  doc.moveDown(0.4);
  doc.font('Times-Bold').fontSize(11).fillColor('#000').text(text, M.left);
  doc.moveDown(0.15);
}
function bodyText(doc, text) {
  doc.font('Times-Roman').fontSize(10.5).fillColor('#000').text(text || '—', M.left, doc.y, { width: USABLE, lineGap: 1.5 });
}

function buildPdfReport(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: {
      Title: `${data.entity.name} — ${data.ordinal} Quarter Report ${data.year}`, Author: 'AOTC Track',
    } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const isCom = data.isCommittee;

    // ---- Letterhead (centered: church name, crest, congregation) ----
    doc.y = M.top - 10;
    doc.font('Times-Bold').fontSize(14).fillColor('#000')
      .text('Presbyterian Church of Ghana', M.left, doc.y, { width: USABLE, align: 'center' });
    const crestW = 62;
    const crestY = doc.y + 4;
    try { if (fs.existsSync(CREST)) doc.image(CREST, (A4.width - crestW) / 2, crestY, { fit: [crestW, 70] }); } catch (e) {}
    doc.y = crestY + 74;
    doc.font('Times-Bold').fontSize(11.5)
      .text('Adabraka Official Town Congregation', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.3);
    doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).lineWidth(1.2).stroke('#1D3F94');
    doc.y += 14;

    // ---- Title block ----
    doc.font('Times-Bold').fontSize(12.5).fillColor('#000');
    doc.text(`${isCom ? 'COMMITTEE ON ' : ''}${data.entity.name.toUpperCase()}`, M.left, doc.y, { width: USABLE, align: 'center' });
    doc.text(`${data.ordinal.toUpperCase()} QUARTER REPORT FOR YEAR ${data.year}`, { width: USABLE, align: 'center' });
    doc.moveDown(0.6);

    // ---- Narrative ----
    sectionHeading(doc, 'Preamble');
    bodyText(doc, data.narrative.preamble);
    sectionHeading(doc, isCom ? 'Membership' : 'Executives');
    const members = [...data.members].sort((a, b) => (a.position === 'Member') - (b.position === 'Member'));
    if (isCom) bodyText(doc, `Committee Membership – ${members.length}`);
    doc.moveDown(0.3);
    drawTable(doc, [
      { label: 'No.', width: 34 }, { label: 'Name', width: 300 }, { label: 'Position', width: 169 },
    ], members.map((m, i) => [i + 1, m.name, (m.position || 'Member') + (m.coopted ? ' (co-opted)' : '')]), { size: 9, headSize: 9 });
    if (data.meetingSummary) {
      sectionHeading(doc, 'Meetings Held');
      bodyText(doc, `${data.meetingSummary.count} meeting(s) were held in the quarter: ${data.meetingSummary.dates.map(x => toLocalDate(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })).join(', ')}.`);
      doc.moveDown(0.3);
      drawTable(doc, [
        { label: 'No.', width: 34 }, { label: 'Member', width: 240 },
        { label: 'Position', width: 130 }, { label: 'Attended', width: 99 },
      ], data.meetingSummary.perMember.map((m, i) => [i + 1, m.name, m.position, `${m.attended} of ${m.total}`]), { size: 9, headSize: 9 });
    }
    sectionHeading(doc, 'Notable Achievements and Events');
    bodyText(doc, data.narrative.achievements || 'None.');
    sectionHeading(doc, 'Major Challenges');
    bodyText(doc, data.narrative.challenges || 'There were no challenges in the quarter under review.');
    if (data.narrative.recommendations) {
      sectionHeading(doc, 'Recommendations');
      bodyText(doc, data.narrative.recommendations);
    }

    // ---- Signatures ----
    const sigs = data.entity.signatories || {};
    const sec = sigs.secretary || sigs.assistant || {};
    const head = sigs.head || {};
    ensureSpace(doc, 90);
    doc.moveDown(1);
    const colW = USABLE / 2;
    const ys = doc.y;
    doc.font('Times-Bold').fontSize(10.5).text('Signed', M.left, ys).text('Signed', M.left + colW, ys);
    doc.font('Times-Roman').fontSize(10.5)
      .text(sec.name || '____________________', M.left, ys + 26).text(head.name || '____________________', M.left + colW, ys + 26)
      .text(`(${sec.title || 'Secretary'})`, M.left, ys + 40).text(`(${head.title || (isCom ? 'Chairperson' : 'President')})`, M.left + colW, ys + 40)
      .text(todayLong(), M.left, ys + 54).text(todayLong(), M.left + colW, ys + 54);
    doc.y = ys + 78;

    // ---- Tables ----
    doc.addPage();
    doc.font('Times-Bold').fontSize(12).text('TABLES', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.5);
    sectionHeading(doc, 'Table 1.0: Quarterly KPI Update');
    drawTable(doc, [
      { label: 'Code', width: 42 }, { label: 'Goals', width: 108 },
      { label: 'Key Performance Indicators (KPI)', width: 105 }, { label: 'Unit', width: 30 },
      { label: 'Prev. Yr Actual', width: 42 }, { label: 'Target', width: 44 },
      { label: '1st', width: 33 }, { label: '2nd', width: 33 }, { label: '3rd', width: 33 }, { label: '4th', width: 33 },
    ], data.kpiTable.map(r => [
      r.code, r.goal, r.kpi, r.unit, fmtVal(r.prevActual, r.unit), fmtVal(r.target, r.unit),
      ...r.quarters.map(q => fmtVal(q, r.unit)),
    ]));

    sectionHeading(doc, `Table 2 – ${isCom ? 'Committee' : 'Group'} Quarterly Performance`);
    const actCols = [
      { label: 'No', width: 24 }, { label: 'Strategies/Activities', width: 175 },
      { label: 'Targets Performance', width: 101 }, { label: 'Actual Performance', width: 101 }, { label: 'Remarks', width: 102 },
    ];
    // Same five columns, plus who did it — for work contributed by the groups
    // that share this committee's goal.
    const sharedCols = [
      { label: 'No', width: 24 }, { label: 'By', width: 92 }, { label: 'Strategies/Activities', width: 140 },
      { label: 'Targets Performance', width: 82 }, { label: 'Actual Performance', width: 82 }, { label: 'Remarks', width: 83 },
    ];
    let idx = 0;
    data.goalSections.forEach(s => {
      idx += 1;
      sectionHeading(doc, `Table 2.${idx}`);
      drawTable(doc, [{ label: 'Code', width: 70 }, { label: 'Goal', width: USABLE - 70 }], [[s.code, s.description]], { size: 8.5 });
      if (s.activities.length) {
        drawTable(doc, actCols, s.activities.map((a, i) => [i + 1, a.description, a.target, a.actual, a.remarks]));
      }
      // A goal extended to the groups: their work is reported here too, by the
      // committee responsible for the goal. Entered by them, reported by us.
      if (s.contributed && s.contributed.length) {
        ensureSpace(doc, 60);
        doc.moveDown(0.25);
        doc.font('Times-Bold').fontSize(9.5)
          .text('Contributed by groups sharing this goal', M.left, doc.y, { width: USABLE });
        doc.moveDown(0.15);
        drawTable(doc, sharedCols, s.contributed.map((a, i) => [i + 1, a.by, a.description, a.target, a.actual, a.remarks]));
      }
    });
    if (data.generalActivities.length) {
      idx += 1;
      sectionHeading(doc, `Table 2.${idx} — Other Activities`);
      drawTable(doc, actCols, data.generalActivities.map((a, i) => [i + 1, a.description, a.target, a.actual, a.remarks]));
    }

    // ---- Page numbers: "x of y" on every page, first page included ----
    // (bottom margin is zeroed while stamping so writing in the footer zone
    // can never trigger an accidental extra page — a classic pdfkit trap
    // that made the count look wrong.)
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Times-Roman').fontSize(8.5).fillColor('#555')
        .text(`Page ${i + 1} of ${range.count}`, M.left, A4.height - 40, { width: USABLE, align: 'center', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
    doc.end();
  });
}

module.exports = { buildPdfReport };

// ---- Congregational consolidated report (AOT format) ----
function buildCongregationPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: {
      Title: `AOT Congregation ${data.ordinal} Quarter Report ${data.year}`, Author: 'AOTC Track',
    } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Letterhead (same convention: name, crest, congregation)
    doc.y = M.top - 10;
    doc.font('Times-Bold').fontSize(14).fillColor('#000')
      .text('Presbyterian Church of Ghana', M.left, doc.y, { width: USABLE, align: 'center' });
    const crestW = 62;
    const crestY = doc.y + 4;
    try { if (fs.existsSync(CREST)) doc.image(CREST, (A4.width - crestW) / 2, crestY, { fit: [crestW, 70] }); } catch (e) {}
    doc.y = crestY + 74;
    doc.font('Times-Bold').fontSize(11.5)
      .text('Adabraka Official Town Congregation', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.3);
    doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).lineWidth(1.2).stroke('#1D3F94');
    doc.y += 14;
    doc.font('Times-Bold').fontSize(12.5)
      .text(`${data.ordinal.toUpperCase()} QUARTER REPORT FOR ${data.year}`, M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.6);

    sectionHeading(doc, 'Preamble');
    bodyText(doc, data.narrative.preamble);
    if (data.membershipTable && data.membershipTable.rows.length) {
      sectionHeading(doc, 'Update on Membership Statistics');
      const mw = [110, 62, 62, 62, 62, 62, 83];
      drawTable(doc, data.membershipTable.header.map((h, i) => ({ label: h, width: mw[i] })),
        data.membershipTable.rows, { size: 9, headSize: 9 });
    }
    if (data.narrative.financial) {
      sectionHeading(doc, 'Financial Report');
      bodyText(doc, data.narrative.financial);
    }
    sectionHeading(doc, 'Notable Achievements and Events');
    bodyText(doc, data.narrative.achievements || 'None.');
    sectionHeading(doc, 'Major Challenges');
    bodyText(doc, data.narrative.challenges || 'None.');
    sectionHeading(doc, 'Recommendation');
    bodyText(doc, data.narrative.recommendations || 'None.');

    // Signatures: Session Clerk + Minister-in-Charge
    ensureSpace(doc, 90);
    doc.moveDown(1.2);
    const colW = USABLE / 2;
    const ys = doc.y;
    doc.font('Times-Bold').fontSize(10.5)
      .text((data.sessionClerk || '____________________').toUpperCase(), M.left, ys)
      .text((data.minister || '____________________').toUpperCase(), M.left + colW, ys);
    doc.font('Times-Roman').fontSize(10.5)
      .text('(SESSION CLERK)', M.left, ys + 16).text('(MINISTER-IN-CHARGE)', M.left + colW, ys + 16);
    doc.y = ys + 44;

    // Tables per committee
    doc.addPage();
    doc.font('Times-Bold').fontSize(12).text('TABLES', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.5);
    data.sections.forEach(sec => {
      sectionHeading(doc, sec.title);
      drawTable(doc, [
        { label: 'Code', width: 52 }, { label: 'Goals', width: 168 },
        { label: 'Key Performance Indicators (KPI)', width: 168 }, { label: 'Unit', width: 55 },
        { label: `Q${data.quarter}`, width: 60 },
      ], sec.rows.map(r => [r.code, r.goal, r.kpi, r.unit, fmtVal(r.value, r.unit)]), { size: 8 });
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Times-Roman').fontSize(8.5).fillColor('#555')
        .text(`Page ${i + 1} of ${range.count}`, M.left, A4.height - 40, { width: USABLE, align: 'center', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
    doc.end();
  });
}

module.exports.buildCongregationPdf = buildCongregationPdf;

// ---- Congregational Conference (annual) report — CLAN/JY format ----
function buildConferencePdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: {
      Title: `${data.entity.name} Conference Report ${data.year}`, Author: 'AOTC Track',
    } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const isCom = data.isCommittee;

    doc.y = M.top - 10;
    doc.font('Times-Bold').fontSize(14).text('Presbyterian Church of Ghana', M.left, doc.y, { width: USABLE, align: 'center' });
    const crestW = 62;
    const crestY = doc.y + 4;
    try { if (fs.existsSync(CREST)) doc.image(CREST, (A4.width - crestW) / 2, crestY, { fit: [crestW, 70] }); } catch (e) {}
    doc.y = crestY + 74;
    doc.font('Times-Bold').fontSize(11.5).text('Adabraka Official Town Congregation', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.3);
    doc.moveTo(M.left, doc.y).lineTo(A4.width - M.right, doc.y).lineWidth(1.2).stroke('#1D3F94');
    doc.y += 14;
    doc.font('Times-Bold').fontSize(12.5);
    doc.text(`${isCom ? 'COMMITTEE ON ' : ''}${data.entity.name.toUpperCase()}`, M.left, doc.y, { width: USABLE, align: 'center' });
    doc.text(`CONGREGATIONAL CONFERENCE REPORT FOR YEAR ${data.year}`, { width: USABLE, align: 'center' });
    doc.moveDown(0.6);

    sectionHeading(doc, 'Preamble');
    bodyText(doc, data.preamble || '—');
    sectionHeading(doc, isCom ? 'Membership' : 'Executives');
    const members = [...data.members].sort((a, b) => (a.position === 'Member') - (b.position === 'Member'));
    drawTable(doc, [
      { label: 'No.', width: 34 }, { label: 'Name', width: 300 }, { label: 'Position', width: 169 },
    ], members.map((m, i) => [i + 1, m.name, (m.position || 'Member') + (m.coopted ? ' (co-opted)' : '')]), { size: 9, headSize: 9 });

    sectionHeading(doc, 'Meeting Reporting Deadlines');
    bodyText(doc, data.deadlineText);

    sectionHeading(doc, 'Update on Goals');
    data.goalSections.forEach(g => {
      ensureSpace(doc, 60);
      doc.moveDown(0.3);
      doc.font('Times-Bold').fontSize(10.5).text(`Goal (${g.code}): ${g.description}`, M.left, doc.y, { width: USABLE });
      if (g.kpis) { doc.font('Times-Italic') || doc.font('Times-Roman'); doc.fontSize(9.5).fillColor('#333').text(`KPIs: ${g.kpis}`, { width: USABLE }); doc.fillColor('#000'); }
      if (g.activities.length) {
        doc.moveDown(0.2);
        drawTable(doc, [{ label: 'Strategy/Activity', width: 250 }, { label: 'Performance across the year', width: 253 }],
          g.activities.map(a => [a.description, a.actuals]), { size: 8 });
      }
      if (g.performance) { doc.font('Times-Roman').fontSize(10).text(g.performance, M.left, doc.y, { width: USABLE, lineGap: 1.2 }); doc.moveDown(0.2); }
      if (g.wayForward) { doc.font('Times-Bold').fontSize(10).text('Way forward: ', M.left, doc.y, { continued: true }); doc.font('Times-Roman').text(g.wayForward, { width: USABLE }); doc.moveDown(0.2); }
    });

    if (data.emergingFocus) { sectionHeading(doc, 'Emerging / New Strategic Focus'); bodyText(doc, data.emergingFocus); }
    sectionHeading(doc, 'Notable Achievements for the Year');
    bodyText(doc, data.achievements || 'None recorded.');
    sectionHeading(doc, 'Major Challenges for the Year');
    bodyText(doc, data.challenges || 'None recorded.');

    // Signatures
    const sigs = data.entity.signatories || {};
    const sec = sigs.secretary || sigs.assistant || {};
    const head = sigs.head || {};
    ensureSpace(doc, 90);
    doc.moveDown(1);
    const colW = USABLE / 2;
    const ys = doc.y;
    doc.font('Times-Bold').fontSize(10.5).text('Signed', M.left, ys).text('Signed', M.left + colW, ys);
    doc.font('Times-Roman').fontSize(10.5)
      .text(sec.name || '____________________', M.left, ys + 26).text(head.name || '____________________', M.left + colW, ys + 26)
      .text(`(${sec.title || 'Secretary'})`, M.left, ys + 40).text(`(${head.title || (isCom ? 'Chairperson' : 'President')})`, M.left + colW, ys + 40)
      .text(todayLong(), M.left, ys + 54).text(todayLong(), M.left + colW, ys + 54);
    doc.y = ys + 78;

    doc.addPage();
    doc.font('Times-Bold').fontSize(12).text('TABLES', M.left, doc.y, { width: USABLE, align: 'center' });
    doc.moveDown(0.5);
    sectionHeading(doc, 'Table 1.0: Annual KPI Update');
    drawTable(doc, [
      { label: 'Code', width: 42 }, { label: 'Goals', width: 108 },
      { label: 'Key Performance Indicators (KPI)', width: 105 }, { label: 'Unit', width: 30 },
      { label: 'Prev. Yr Actual', width: 42 }, { label: 'Target', width: 44 },
      { label: '1st', width: 33 }, { label: '2nd', width: 33 }, { label: '3rd', width: 33 }, { label: '4th', width: 33 },
    ], data.kpiTable.map(r => [
      r.code, r.goal, r.kpi, r.unit, fmtVal(r.prevActual, r.unit), fmtVal(r.target, r.unit),
      ...r.quarters.map(q => fmtVal(q, r.unit)),
    ]));

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Times-Roman').fontSize(8.5).fillColor('#555')
        .text(`Page ${i + 1} of ${range.count}`, M.left, A4.height - 40, { width: USABLE, align: 'center', lineBreak: false });
      doc.page.margins.bottom = saved;
    }
    doc.end();
  });
}

module.exports.buildConferencePdf = buildConferencePdf;
