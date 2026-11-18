// Minutes and agenda as PDF (A4), drawn to the same measurements as the Word
// documents so the two never disagree. pdfkit is injected by the app.
//
//   const P = createMinutesPdf({ PDFDocument: require('pdfkit'), style });
//   const buf = await P.minutes(data);   // same data as docx.minutes()
//   const buf = await P.agenda(data);
//
// style.pdf: { crest, watermark, watermarkOpacity, masthead:[lines], confidential(owner),
//              fonts:{ sans, serif, agenda }  (each a list of [regular, bold] paths) }
// style.minutes / style.agenda: the same titles, headers and signature words as docx.
'use strict';

const fs = require('fs');
const { bulletise, longDate } = require('./text');

const A4 = { width: 595.28, height: 841.89 };

function createMinutesPdf({ PDFDocument, style = {} } = {}) {
  if (!PDFDocument) throw new Error('@deontech/minutes: pass { PDFDocument } (pdfkit) from the app');
  const PS = { watermarkOpacity: 0.06, masthead: [], fonts: {}, ...(style.pdf || {}) };
  const MS = style.minutes || {};
  const AS = style.agenda || {};
  const H = { no: 'No.', subject: 'Subject', action: 'Action', ...(MS.headers || {}) };
  const SIG = { recorded: 'Recorded by', confirmed: 'Confirmed by', recordedTitle: 'Secretary', confirmedTitle: 'Chairperson', shade: 'D9E2F3', ...(MS.signatures || {}) };

  const M = PS.margins || { top: 78, bottom: 68, left: 72, right: 72 };
  const TEXT_W = A4.width - M.left - M.right;
  const COLS = PS.cols || [31.75, 404.2, 91.9];
  const TABLE_W = COLS.reduce((a, b) => a + b, 0);
  const TABLE_X = (A4.width - TABLE_W) / 2;
  const BODY = 12, SMALL = 10, FOOT = 8, PAD = 4, LEAD = 0.5;
  const BOTTOM = A4.height - M.bottom;

  const pick = (list) => {
    for (const [reg, bold] of list || []) {
      try { if (fs.existsSync(reg) && fs.existsSync(bold)) return { reg, bold }; } catch (e) { /* keep looking */ }
    }
    return null;
  };
  const SANS = pick(PS.fonts.sans), SERIF = pick(PS.fonts.serif), AGF = pick(PS.fonts.agenda);
  function registerFonts(doc) {
    try {
      if (SANS) { doc.registerFont('Body', SANS.reg); doc.registerFont('Body-Bold', SANS.bold); }
      if (SERIF) { doc.registerFont('Head', SERIF.reg); doc.registerFont('Head-Bold', SERIF.bold); }
      if (AGF) { doc.registerFont('Ag', AGF.reg); doc.registerFont('Ag-Bold', AGF.bold); }
    } catch (e) { /* the built-ins still work */ }
  }
  const BODY_F = () => (SANS ? 'Body' : 'Helvetica');
  const BODY_FB = () => (SANS ? 'Body-Bold' : 'Helvetica-Bold');
  const HEAD_F = () => (SERIF ? 'Head' : (PS.headFallback || 'Times-Roman'));
  const HEAD_FB = () => (SERIF ? 'Head-Bold' : (PS.headFallbackBold || 'Times-Bold'));
  const AG_F = () => (AGF ? 'Ag' : 'Helvetica');
  const AG_FB = () => (AGF ? 'Ag-Bold' : 'Helvetica-Bold');
  const hasCrest = () => PS.crest && fs.existsSync(PS.crest);
  const wmark = () => PS.watermark || PS.crest;

  // ---- page furniture ----
  function watermark(doc) {
    const img = wmark();
    if (!img || !fs.existsSync(img)) return;
    try {
      doc.save(); doc.opacity(PS.watermarkOpacity);
      const w = PS.watermarkSize || 360;
      doc.image(img, (A4.width - w) / 2, (A4.height - w) / 2 - 40, { fit: [w, w] });
      doc.opacity(1); doc.restore();
    } catch (e) { /* decorative only */ }
  }
  // The masthead: first line, the crest, the remaining lines.
  function pageHeader(doc) {
    const lines = PS.masthead || [];
    if (PS.drawHeader) return PS.drawHeader(doc, { A4, M, TEXT_W, HEAD_FB, HEAD_F });
    let y = 22;
    if (lines[0]) { doc.font(HEAD_FB()).fontSize(SMALL).fillColor('#000').text(lines[0], M.left, y, { width: TEXT_W, align: 'center' }); y = doc.y + 1; }
    try { if (hasCrest()) { doc.image(PS.crest, (A4.width - 34) / 2, y, { fit: [34, 38] }); y += 38; } } catch (e) { /* ignore */ }
    lines.slice(1).forEach((l) => { doc.font(HEAD_FB()).fontSize(SMALL).text(l, M.left, y, { width: TEXT_W, align: 'center' }); y = doc.y; });
    return y + 10;
  }
  function dressPage(doc) { watermark(doc); return Math.max(M.top, pageHeader(doc)); }
  function newPage(doc) { doc.addPage(); return dressPage(doc); }

  // ---- nested grid ----
  const GRID_ROW_H = 11.5, GRID_HEAD_H = 21;
  function gridGeom(doc, g, width) {
    const head = (g && g.head) || [];
    const n = Math.max(1, head.length);
    const labelW = Math.min(96, width * 0.28);
    const colW = n > 1 ? (width - labelW) / (n - 1) : width;
    let size = SMALL;
    doc.font(HEAD_FB());
    ((g && g.rows) || []).forEach((r) => r.slice(1).forEach((c) => {
      const s = String(c == null ? '' : c);
      if (!s) return;
      doc.fontSize(size);
      while (size > 5 && doc.widthOfString(s) > colW - 4) { size -= 0.25; doc.fontSize(size); }
    }));
    return { labelW, colW, size };
  }
  const gridHeight = (doc, g) => GRID_HEAD_H + (((g && g.rows) || []).length * GRID_ROW_H) + 6;
  function drawGrid(doc, g, x, y, width) {
    const head = (g && g.head) || [];
    const strong = g.strong || /BALANCE|RECEIPTS|PAYMENTS/;
    const { labelW, colW, size } = gridGeom(doc, g, width);
    const cx = (i) => (i === 0 ? x : x + labelW + (i - 1) * colW);
    const cw = (i) => (i === 0 ? labelW : colW);
    let yy = y;
    head.forEach((c, i) => {
      doc.rect(cx(i), yy, cw(i), GRID_HEAD_H).strokeColor('#000').lineWidth(0.5).stroke();
      doc.font(HEAD_FB()).fontSize(7).fillColor('#000').text(String(c == null ? '' : c), cx(i) + 2, yy + 2.5, { width: cw(i) - 4, align: i === 0 ? 'left' : 'right', height: GRID_HEAD_H - 4 });
    });
    yy += GRID_HEAD_H;
    ((g && g.rows) || []).forEach((r) => {
      const bold = strong.test(String(r[0] || ''));
      r.forEach((c, i) => {
        doc.rect(cx(i), yy, cw(i), GRID_ROW_H).strokeColor('#000').lineWidth(0.5).stroke();
        doc.font(bold ? HEAD_FB() : HEAD_F()).fontSize(i === 0 ? 7 : size).fillColor('#000')
          .text(String(c == null ? '' : c), cx(i) + 2, yy + 3.2, { width: cw(i) - 4, align: i === 0 ? 'left' : 'right', lineBreak: false, ellipsis: i === 0 });
      });
      yy += GRID_ROW_H;
    });
    return yy + 6;
  }

  // ---- text blocks ----
  const BULLET_IN = 16;
  const blockFont = (b) => (b.heading ? (b.bold ? HEAD_FB() : HEAD_F()) : (b.bold ? BODY_FB() : BODY_F()));
  function blockHeight(doc, b, width) {
    if (b.type === 'grid') return gridHeight(doc, b.grid);
    doc.font(blockFont(b)).fontSize(b.size || BODY);
    const w = b.bullet ? width - BULLET_IN : width;
    return doc.heightOfString(String(b.text || ''), { width: w, lineGap: (b.size || BODY) * LEAD, align: b.bullet ? pointAlign(b) : (b.align || 'left') }) + (b.after || 1);
  }
  // 0.5.2: style.minutes.justifyPoints sets points justified like the prose.
  function pointAlign(b) { return MS.justifyPoints && b.align === 'justify' ? 'justify' : 'left'; }
  function drawBlock(doc, b, x, y, width) {
    if (b.type === 'grid') return drawGrid(doc, b.grid, x, y, width);
    doc.font(blockFont(b)).fontSize(b.size || BODY).fillColor('#000');
    const opts = { lineGap: (b.size || BODY) * LEAD };
    if (b.underline) opts.underline = true;
    if (b.bullet) {
      doc.text('•', x + 4, y, { width: BULLET_IN, lineBreak: false });
      doc.text(String(b.text || ''), x + BULLET_IN, y, { width: width - BULLET_IN, align: pointAlign(b), ...opts });
    } else if (b.label && String(b.text || '').startsWith(b.label)) {
      // The label slanted, the rest upright (no italic of the body face is loaded).
      doc.text(b.label, x, y, { width, align: b.align || 'left', ...opts, oblique: true, continued: true });
      doc.text(String(b.text).slice(b.label.length), { oblique: false });
    } else {
      doc.text(String(b.text || ''), x, y, { width, align: b.align || 'left', ...opts });
    }
    return y + blockHeight(doc, b, width);
  }
  const toBlocks = (text, opts = {}) => bulletise(text).map((l) => ({ text: l.text, ...opts, ...(l.bullet ? { bullet: true } : {}), ...(l.label ? { label: l.label } : {}) }));

  // The roster's face: Helvetica unless the app asks for its body face
  // (Helvetica has no Č or Ğ; a federation's names need them).
  const ROSTER_F = () => (PS.rosterFont === 'body' ? BODY_F() : 'Helvetica');
  function rosterList(doc, people, y) {
    const list = Array.isArray(people) ? people : [];
    doc.font(ROSTER_F()).fontSize(BODY - 0.5).fillColor('#000');
    if (!list.length) { doc.text('NIL', M.left + 18, y, { width: TEXT_W - 18 }); return y + 15; }
    const numW = 20, posX = M.left + 20 + 290;
    list.forEach((m, i) => {
      if (y > BOTTOM - 16) { y = newPage(doc); }
      doc.font(ROSTER_F()).fontSize(BODY - 0.5).fillColor('#000');
      doc.text(`${i + 1}.`, M.left, y, { width: numW });
      doc.text(String(m.name || '').toUpperCase(), M.left + numW, y, { width: 288, lineBreak: false, ellipsis: true });
      // 0.5.1: a title wider than its column is set smaller to fit on its line,
      // never wrapped onto the next one.
      const pos = String(m.position || 'MEMBER').toUpperCase(), posW = A4.width - M.right - posX;
      let fsz = BODY - 0.5;
      while (fsz > 7 && doc.fontSize(fsz).widthOfString(pos) > posW) fsz -= 0.5;
      doc.fontSize(fsz).text(pos, posX, y + (BODY - 0.5 - fsz) / 2, { width: posW, lineBreak: false });
      doc.fontSize(BODY - 0.5);
      y += 14.5;
      // 0.5.1: the optional details line, under the name, wrapping as needed.
      const details = String(m.details || '').trim();
      if (details) {
        const w = TEXT_W - numW;
        const h = doc.heightOfString(details, { width: w });
        if (y + h > BOTTOM) { y = newPage(doc); }
        doc.font(ROSTER_F()).fontSize(BODY - 0.5).fillColor('#000').text(details, M.left + numW, y, { width: w });
        y = doc.y + 3;
      }
    });
    return y;
  }

  function tableHeader(doc, y) {
    const h = 20;
    const labels = [{ text: H.no, size: BODY, align: 'left' }, { text: H.subject, size: BODY, align: 'left' }, { text: H.action, size: SMALL, align: 'center' }];
    let x = TABLE_X;
    labels.forEach((l, i) => {
      doc.rect(x, y, COLS[i], h).strokeColor('#000').lineWidth(0.5).stroke();
      doc.fillColor('#000').font(HEAD_FB()).fontSize(l.size).text(l.text, x + PAD, y + 4, { width: COLS[i] - 2 * PAD, align: l.align });
      x += COLS[i];
    });
    return y + h;
  }

  function drawRow(doc, row, y) {
    let subject = [];
    if (row.subject) subject.push({ text: row.subject, bold: true, heading: true, after: 2, align: 'justify' });
    subject = subject.concat(toBlocks(row.body, { size: SMALL, after: 2, align: 'justify' }));
    if (row.table) subject.push({ type: 'grid', grid: row.table });
    if (!subject.length) subject = [{ text: '', after: 0 }];
    const action = toBlocks(row.action, { size: SMALL, after: 2 });
    const wS = COLS[1] - 2 * PAD, wA = COLS[2] - 2 * PAD;
    let firstChunk = true;
    while (subject.length || action.length) {
      let avail = BOTTOM - y - 2 * PAD;
      if (avail < 30) { y = newPage(doc); y = tableHeader(doc, y); avail = BOTTOM - y - 2 * PAD; }
      const takeS = [], takeA = [];
      let hS = 0, hA = 0;
      while (subject.length) {
        const h = blockHeight(doc, subject[0], wS);
        if (hS + h > avail && takeS.length) break;
        takeS.push(subject.shift()); hS += h;
        if (hS > avail) break;
      }
      while (action.length) {
        const h = blockHeight(doc, action[0], wA);
        if (hA + h > avail && takeA.length) break;
        takeA.push(action.shift()); hA += h;
        if (hA > avail) break;
      }
      const rowH = Math.max(hS, hA, 16) + 2 * PAD;
      let x = TABLE_X;
      COLS.forEach((w) => { doc.rect(x, y, w, rowH).strokeColor('#000').lineWidth(0.5).stroke(); x += w; });
      if (firstChunk && row.no) doc.font(HEAD_FB()).fontSize(BODY).fillColor('#000').text(String(row.no), TABLE_X + PAD, y + PAD, { width: COLS[0] - 2 * PAD });
      let yy = y + PAD;
      takeS.forEach((b) => { yy = drawBlock(doc, b, TABLE_X + COLS[0] + PAD, yy, wS); });
      let ya = y + PAD;
      takeA.forEach((b) => { ya = drawBlock(doc, b, TABLE_X + COLS[0] + COLS[1] + PAD, ya, wA); });
      y += rowH;
      firstChunk = false;
    }
    return y;
  }

  function signature(doc, sig = {}, y) {
    const rec = sig.recordedBy || {}, con = sig.confirmedBy || {};
    const half = TABLE_W / 2, HEAD_H = 23, BODY_H = 74;
    // The whole panel moves to the next page if it does not fit: checking only
    // for the heading row let the names and offices spill one per page onto
    // two extra pages of their own (AOTC Track, found Oct 2026).
    if (y + 14 + HEAD_H + BODY_H > BOTTOM) { y = newPage(doc); }
    y += 14;
    doc.rect(TABLE_X, y, TABLE_W, HEAD_H).fillColor('#' + SIG.shade).fill();
    [0, half].forEach((dx) => doc.rect(TABLE_X + dx, y, half, HEAD_H).strokeColor('#000').lineWidth(0.5).stroke());
    doc.font(HEAD_FB()).fontSize(BODY).fillColor('#000');
    doc.text(SIG.recorded, TABLE_X, y + 4, { width: half, align: 'center' });
    doc.text(SIG.confirmed, TABLE_X + half, y + 4, { width: half, align: 'center' });
    y += HEAD_H;
    [0, half].forEach((dx) => doc.rect(TABLE_X + dx, y, half, BODY_H).strokeColor('#000').lineWidth(0.5).stroke());
    const ty = y + BODY_H - 34;
    doc.font(BODY_FB()).fontSize(SMALL);
    doc.text(rec.name || '', TABLE_X, ty, { width: half, align: 'center' });
    doc.text(con.name || '', TABLE_X + half, ty, { width: half, align: 'center' });
    doc.font(BODY_F()).fontSize(SMALL);
    doc.text(`(${rec.title || SIG.recordedTitle})`, TABLE_X, ty + 14, { width: half, align: 'center' });
    doc.text(`(${con.title || SIG.confirmedTitle})`, TABLE_X + half, ty + 14, { width: half, align: 'center' });
    return y + BODY_H + 16;
  }

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function appendices(doc, list) {
    (list || []).filter((a) => (a.title && a.title.trim()) || (a.body && a.body.trim())).forEach((a, i) => {
      let y = newPage(doc);
      doc.font(HEAD_FB()).fontSize(BODY).fillColor('#000').text(`Appendix ${LETTERS[i] || i + 1}`, M.left, y, { width: TEXT_W });
      y = doc.y + 10;
      if (a.title && a.title.trim()) { doc.font(HEAD_FB()).fontSize(BODY).text(a.title.trim().toUpperCase(), M.left, y, { width: TEXT_W, align: 'center' }); y = doc.y + 12; }
      toBlocks(a.body, { after: 6 }).forEach((b) => {
        if (y > BOTTOM - 30) { y = newPage(doc); }
        y = drawBlock(doc, { ...b, size: BODY, align: 'justify' }, M.left, y, TEXT_W);
      });
    });
  }

  function stampFooters(doc, owner) {
    const range = doc.bufferedPageRange();
    const note = PS.confidential ? PS.confidential(owner) : '';
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const old = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font(HEAD_F()).fontSize(FOOT).fillColor('#000').text(`Page | ${i + 1}`, M.left, A4.height - M.bottom + 14, { width: TEXT_W, align: 'right' });
      if (note) doc.font(HEAD_F()).fontSize(FOOT).fillColor('#444').text(note, M.left, A4.height - M.bottom + 26, { width: TEXT_W, align: 'center' });
      doc.page.margins.bottom = old;
    }
  }

  const minutesTitle = (data) => (MS.title ? MS.title(data)
    : `MINUTES OF THE ${(data.heading || MS.defaultHeading || 'MEETING').toUpperCase()}`
      + ((data.venue || '').trim() ? ` HELD AT ${data.venue.trim().toUpperCase()}` : '')
      + ` ON ${longDate(data.date, { upper: true, comma: true })}`);
  const attendanceOf = (data) => (Array.isArray(data.attendance) ? data.attendance : [
    { label: 'MEMBERS PRESENT:', people: data.present },
    { label: 'IN ATTENDANCE:', people: data.inAttendance, hideIfEmpty: true },
    { label: 'MEMBERS WITH APOLOGIES:', people: data.apologies },
    { label: 'MEMBERS ABSENT:', people: data.absent },
  ]);

  function minutes(data) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: `Minutes — ${data.heading || MS.defaultHeading || 'Meeting'} ${data.date || ''}` } });
      registerFonts(doc);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const contentTop = dressPage(doc);
      doc.font(HEAD_FB()).fontSize(BODY).fillColor('#000').text(minutesTitle(data), M.left, contentTop, { width: TEXT_W, align: 'center', underline: true });
      let y = doc.y + 12;
      if (data.subtitle) { doc.font(BODY_F()).fontSize(SMALL).text(data.subtitle, M.left, y - 6, { width: TEXT_W, align: 'center' }); y = doc.y + 10; }
      for (const block of attendanceOf(data)) {
        if (block.hideIfEmpty && !(block.people || []).length) continue;
        if (y > BOTTOM - 46) { y = newPage(doc); }
        doc.font(HEAD_FB()).fontSize(BODY).fillColor('#000').text(block.label, M.left, y, { width: TEXT_W });
        y = doc.y + 2;
        y = rosterList(doc, block.people, y) + 10;
        if (block.note) { doc.font(BODY_F()).fontSize(SMALL).text(block.note, M.left, y - 6, { width: TEXT_W }); y = doc.y + 8; }
      }
      if (MS.attendancePageBreak === false) { y += 6; if (y > BOTTOM - 60) y = newPage(doc); } else y = newPage(doc);
      y = tableHeader(doc, y);
      (data.rows || []).forEach((r) => { y = drawRow(doc, r, y); });
      signature(doc, data.signatories || {}, y);
      appendices(doc, data.appendices);
      stampFooters(doc, data.owner);
      doc.end();
    });
  }

  // ---- agenda ----
  const AG_M = PS.agendaMargins || { top: 22, bottom: 24, left: 43.65, right: 43.65 };
  const AG_W = A4.width - AG_M.left - AG_M.right;
  const AG_TBL_X = 34.65, AG_TBL_W = 540.4;
  const AG_TWIPS = AS.cols || [2141, 4678, 3989];
  const AG_COLS = AG_TWIPS.map((w) => AG_TBL_W * w / AG_TWIPS.reduce((a, b) => a + b, 0));
  const AG_CELL_R = 5.75, AG_SIZE = 11, AG_ROW_PAD = 5, AG_IND = 22.5, AG_SUB_IND = 40.5;
  const AG_BLUE = '#' + (AS.blue || '1F4E79');
  const AG_LETTER = 'abcdefghijklmnopqrstuvwxyz';
  const AGH = { time: 'Time', item: 'Item', responsible: 'Responsible', ...(AS.headers || {}) };

  function drawAgendaTitle(doc, text, y) {
    const m = text.match(/^(.*?\b\d{1,2})(ST|ND|RD|TH)(\b.*)$/);
    doc.font(AG_FB()).fontSize(12).fillColor('#000');
    if (!m) { doc.text(text, AG_M.left, y, { width: AG_W, align: 'center', underline: true }); return; }
    const wMain = doc.widthOfString(m[1]) + doc.widthOfString(m[3]);
    doc.fontSize(8); const wSup = doc.widthOfString(m[2]); doc.fontSize(12);
    let x = AG_M.left + (AG_W - (wMain + wSup)) / 2;
    const x0 = x;
    doc.text(m[1], x, y, { lineBreak: false }); x += doc.widthOfString(m[1]);
    doc.fontSize(8).text(m[2], x, y - 1, { lineBreak: false }); x += doc.widthOfString(m[2]);
    doc.fontSize(12).text(m[3], x, y, { lineBreak: false });
    const h = doc.currentLineHeight();
    doc.moveTo(x0, y + h - 1).lineTo(x + doc.widthOfString(m[3]), y + h - 1).strokeColor('#000').lineWidth(0.8).stroke();
    doc.y = y + h;
  }

  function agenda(data) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margins: AG_M, bufferPages: true, info: { Title: `Agenda — ${data.heading || AS.defaultHeading || 'Meeting'} ${data.date || ''}` } });
      registerFonts(doc);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const lines = PS.masthead || [];
      const head = () => {
        if (PS.drawHeader) return PS.drawHeader(doc, { A4, M: AG_M, TEXT_W: AG_W, HEAD_FB: AG_FB, HEAD_F: AG_F }) + 4;
        let yy = 20;
        if (lines[0]) { doc.font(AG_FB()).fontSize(SMALL).fillColor('#000').text(lines[0], AG_M.left, yy, { width: AG_W, align: 'center' }); yy = doc.y + 1; }
        try { if (hasCrest()) { doc.image(PS.crest, (A4.width - 30) / 2, yy, { fit: [30, 34] }); yy += 34; } } catch (e) { /* ignore */ }
        lines.slice(1).forEach((l) => { doc.font(AG_FB()).fontSize(SMALL).text(l, AG_M.left, yy, { width: AG_W, align: 'center' }); yy = doc.y; });
        return yy + 8;
      };
      if (PS.agendaWatermark) watermark(doc);
      let y = head();
      const title = AS.title ? AS.title(data) : `AGENDA FOR ${(data.heading || AS.defaultHeading || 'MEETING').toUpperCase()} ON ${longDate(data.date, { upper: true })}`;
      drawAgendaTitle(doc, title, y);
      y = doc.y + 12;
      if (data.subtitle) { doc.font(AG_F()).fontSize(SMALL).fillColor('#000').text(data.subtitle, AG_M.left, y - 6, { width: AG_W, align: 'center' }); y = doc.y + 10; }
      const bottom = A4.height - AG_M.bottom;
      const cx = (i) => AG_TBL_X + AG_COLS.slice(0, i).reduce((a, b) => a + b, 0);
      const rule = (yy) => { doc.moveTo(AG_TBL_X, yy).lineTo(AG_TBL_X + AG_TBL_W, yy).strokeColor('#000').lineWidth(0.6).stroke(); };
      const vrule = (y0, y1) => { const x = cx(1); doc.moveTo(x, y0).lineTo(x, y1).strokeColor('#000').lineWidth(0.6).stroke(); };
      const measure = (txt, width, font) => { doc.font(font).fontSize(AG_SIZE); return doc.heightOfString(String(txt || ''), { width }); };
      const headerRow = () => {
        rule(y); const top = y; y += AG_ROW_PAD;
        [AGH.time, AGH.item, AGH.responsible].forEach((l, i) => {
          doc.font(AG_FB()).fontSize(AG_SIZE).fillColor(AG_BLUE).text(l, cx(i) + (i === 0 ? 0 : PAD), y, { width: AG_COLS[i] - AG_CELL_R });
        });
        y = doc.y + AG_ROW_PAD; rule(y); vrule(top, y); doc.fillColor('#000');
      };
      headerRow();
      (data.rows || []).forEach((r, idx) => {
        const subs = (r.subItems || []).map((sb) => ({ label: String((sb && sb.item) || sb || '').trim(), name: String((sb && sb.responsible) || '').trim() })).filter((x) => x.label);
        const perLine = subs.some((x) => x.name);
        const wholeBlock = subs.length > 0 && !perLine && !!String(r.responsible || '').trim();
        const lns = [{ mark: r.mark || `${idx + 1}.`, text: r.item || '', name: wholeBlock ? '' : (r.responsible || ''), bold: true, ind: AG_IND }]
          .concat(subs.map((x, j) => ({ mark: `${AG_LETTER[j] || j + 1})`, text: x.label, name: x.name, bold: false, ind: AG_SUB_IND })));
        const hs = lns.map((l) => Math.max(measure(l.text, AG_COLS[1] - l.ind - AG_CELL_R, l.bold ? AG_FB() : AG_F()), measure(l.name, AG_COLS[2] - PAD - AG_CELL_R, AG_F())) + 2 * AG_ROW_PAD);
        const time = r.time != null ? String(r.time) : `${String(r.at || '')}${r.mins ? ` (${r.mins} min${r.mins === 1 ? '' : 's'})` : ''}`.trim();
        const asideH = Math.max(measure(time, AG_COLS[0] - AG_CELL_R, AG_F()), wholeBlock ? measure(r.responsible, AG_COLS[2] - PAD - AG_CELL_R, AG_F()) : 0) + 2 * AG_ROW_PAD;
        let blockH = hs.reduce((a, b) => a + b, 0);
        if (asideH > blockH) { hs[hs.length - 1] += asideH - blockH; blockH = asideH; }
        if (y + blockH > bottom) { doc.addPage(); if (PS.agendaWatermark) watermark(doc); y = head(); headerRow(); }
        const top = y;
        lns.forEach((l, li) => {
          const yy = y + AG_ROW_PAD;
          doc.font(l.bold ? AG_FB() : AG_F()).fontSize(AG_SIZE).fillColor('#000');
          doc.text(l.mark, cx(1) + l.ind - 18, yy, { width: 18, lineBreak: false });
          doc.font(l.bold ? AG_FB() : AG_F()).text(l.text, cx(1) + l.ind, yy, { width: AG_COLS[1] - l.ind - AG_CELL_R });
          if (l.name) doc.font(AG_F()).text(l.name, cx(2) + PAD, yy, { width: AG_COLS[2] - PAD - AG_CELL_R });
          y += hs[li];
        });
        doc.font(AG_F()).fontSize(AG_SIZE).fillColor('#000');
        const th = measure(time, AG_COLS[0] - AG_CELL_R, AG_F());
        doc.text(time, AG_TBL_X, Math.max(top + AG_ROW_PAD, top + (blockH - th) / 2), { width: AG_COLS[0] - AG_CELL_R });
        if (wholeBlock) {
          const nh = measure(r.responsible, AG_COLS[2] - PAD - AG_CELL_R, AG_F());
          doc.text(r.responsible, cx(2) + PAD, Math.max(top + AG_ROW_PAD, top + (blockH - nh) / 2), { width: AG_COLS[2] - PAD - AG_CELL_R });
        }
        rule(y); vrule(top, y);
      });
      if (data.notes) {
        y += 12;
        doc.font(AG_F()).fontSize(SMALL).fillColor('#000');
        String(data.notes).split('\n').forEach((line) => { if (y > bottom - 14) { doc.addPage(); y = head(); } doc.text(line, AG_TBL_X, y, { width: AG_TBL_W }); y = doc.y + 3; });
      }
      if (PS.agendaFooter) stampFooters(doc, null);
      doc.end();
    });
  }

  // A letter or notice on the same letterhead, from the same blocks as docx.letter().
  function letter(blocks, info = {}) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: info.title || 'Notice' } });
      registerFonts(doc);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      let y = dressPage(doc);
      const heightOf = (b) => {
        const runs = Array.isArray(b.text) ? b.text : [{ text: b.text }];
        doc.font(b.bold ? BODY_FB() : BODY_F()).fontSize((b.size || 20) / 2);
        return (b.before || 0) / 20 + doc.heightOfString(runs.map((r) => r.text || '').join(''), { width: TEXT_W - (b.list || b.indent ? 16 : 0), lineGap: 1.5 }) + (b.after != null ? b.after : 120) / 20;
      };
      (blocks || []).forEach((b, i) => {
        if (b.pageBreak) { y = newPage(doc); return; }
        // keep: n — this block and the n after it stay on one page (a signature).
        if (b.keep) {
          const h = blocks.slice(i, i + 1 + b.keep).reduce((a, x) => a + heightOf(x), 0);
          if (y + h > BOTTOM) y = newPage(doc);
        }
        const size = (b.size || 20) / 2;
        const runs = Array.isArray(b.text) ? b.text : [{ text: b.text }];
        const plain = runs.map((r) => r.text || '').join('');
        const x = (b.list || b.indent) ? M.left + 16 : M.left, w = (b.list || b.indent) ? TEXT_W - 16 : TEXT_W;
        y += (b.before || 0) / 20;
        doc.font(b.bold ? BODY_FB() : BODY_F()).fontSize(size);
        const h = doc.heightOfString(plain, { width: w, lineGap: 1.5 });
        if (y + h > BOTTOM) y = newPage(doc);
        if (b.list) doc.font(BODY_F()).fontSize(size).fillColor('#000').text('\u2022', M.left + 2, y, { lineBreak: false });
        const align = b.center ? 'center' : b.right ? 'right' : b.justify ? 'justify' : 'left';
        runs.forEach((r, i) => {
          doc.font((r.bold || b.bold) ? BODY_FB() : BODY_F()).fontSize(size).fillColor(r.color || b.color ? '#' + (r.color || b.color) : '#000');
          const o = { width: w, align, lineGap: 1.5, continued: i < runs.length - 1, oblique: !!(r.italics || b.italic), underline: !!(r.underline || b.underline) };
          if (i === 0) doc.text(r.text || '', x, y, o); else doc.text(r.text || '', o);
        });
        y = doc.y + (b.after != null ? b.after : 120) / 20;
      });
      stampFooters(doc, null);
      doc.end();
    });
  }

  return { minutes, agenda, letter };
}

module.exports = { createMinutesPdf };
