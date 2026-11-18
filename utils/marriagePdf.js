// PCG-AOTC-CFL-FR01 — Intended Marriage Interview Form, rendered as a PDF
// that mirrors the original controlled document's layout with the online
// answers filled in. Sections H (authentication) and I (after Session
// approval) print with names prefilled where known but signature/date cells
// BLANK — they are completed with wet signatures on the printout.
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { toLocalDate } = require('./dates');

const A4 = { width: 595.28, height: 841.89 };
const M = { top: 118, bottom: 64, left: 56, right: 56 };
const USABLE = A4.width - M.left - M.right;
const CREST = path.join(__dirname, '..', 'public', 'img', 'logo.png');

// Palette lifted from the original form
const BAR = '#BDD7EE';       // section header bar
const HEAD = '#DEEAF6';      // table header shading
const INK = '#1F3864';       // dark blue headings
const LINE = '#7F7F7F';

// The 17 Section D screening questions (shared with the front-end).
const D_QUESTIONS = [
  'Age (years)',
  'Denomination / Congregation',
  'Role in congregation',
  'Occupation',
  'Residence',
  'Have you been married before?  (Yes / No)',
  'If Yes to Q6, what type of marriage was contracted?  (Customary / Ordinance)',
  'If previously married, what is your current civil status?  (Divorced / Widowed)',
  'If divorced under Ordinance: do you have your divorce certificate?  (Yes – kindly submit a copy / No – explain)',
  'If divorced under Customary marriage: do you have evidence of the dissolution?  (Yes – specify / No)',
  'Do you have a child / children?  (Yes / No)',
  'If Yes, how many?',
  'Was/were the child(ren) born within marriage or out of wedlock?',
  'Is/are the child(ren) staying with you?  (Yes / No)',
  'If No, where is/are the child(ren) staying?',
  'Do you provide for the care of the child(ren)?  (Yes / No — if No, explain)',
  'Any remarks / comments',
];

function buildMarriageFormPdf(kase) {
  const form = kase.form || {};
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margins: M, bufferPages: true,
      info: { Title: 'Intended Marriage Interview Form', Author: 'PCG — AOTC (CFL)' },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ---- Per-page chrome (header band redrawn on every page) ----
    function pageHeader() {
      const y0 = 34;
      const h = 56;
      // outer box: crest cell + title cell
      const crestW = 120;
      doc.lineWidth(1).rect(M.left, y0, USABLE, h).stroke('#000');
      doc.moveTo(M.left + crestW, y0).lineTo(M.left + crestW, y0 + h).stroke('#000');
      try { if (fs.existsSync(CREST)) doc.image(CREST, M.left + (crestW - 42) / 2, y0 + 7, { fit: [42, 42] }); } catch (e) {}
      doc.font('Times-Bold').fontSize(12.5).fillColor('#000')
        .text('INTENDED MARRIAGE INTERVIEW FORM', M.left + crestW, y0 + h / 2 - 8, { width: USABLE - crestW, align: 'center' });
      // doc-control strip
      const y1 = y0 + h + 4;
      const strip = 18;
      doc.lineWidth(1).rect(M.left, y1, USABLE, strip).stroke('#000');
      const cw = USABLE / 3;
      doc.moveTo(M.left + cw, y1).lineTo(M.left + cw, y1 + strip).stroke('#000');
      doc.moveTo(M.left + 2 * cw, y1).lineTo(M.left + 2 * cw, y1 + strip).stroke('#000');
      doc.font('Times-Bold').fontSize(9);
      doc.text('Doc No.: PCG-AOTC-CFL-FR01', M.left + 6, y1 + 4.5, { width: cw - 12, lineBreak: false });
      doc.text('Revision: 0', M.left + cw, y1 + 4.5, { width: cw, align: 'center', lineBreak: false });
      // page x of y filled at the end (buffered pages)
      doc.y = M.top;
    }
    doc.on('pageAdded', pageHeader);
    pageHeader();

    // ---- Layout helpers ----
    const bottomY = A4.height - M.bottom - 26; // leave room for footer line
    function ensure(h) { if (doc.y + h > bottomY) doc.addPage(); }

    function sectionBar(text) {
      ensure(34);
      doc.rect(M.left, doc.y, USABLE, 20).fill(BAR);
      doc.fillColor(INK).font('Times-Bold').fontSize(11)
        .text(text, M.left + 8, doc.y + 4.5, { width: USABLE - 16, lineBreak: false });
      doc.fillColor('#000');
      doc.y += 26;
    }

    // Generic bordered table. rows: { cells: [..], bold, shade, minH, align: [] }
    function table(widths, rows, { headerRow } = {}) {
      const pad = 5;
      const drawRow = (r) => {
        doc.font(r.bold ? 'Times-Bold' : 'Times-Roman').fontSize(9.5);
        const hs = r.cells.map((c, i) =>
          doc.heightOfString(String(c === null || c === undefined ? '' : c) || ' ', { width: widths[i] - pad * 2 }));
        const h = Math.max(r.minH || 20, ...hs.map(v => v + 9));
        if (doc.y + h > bottomY) { doc.addPage(); if (headerRow && r !== headerRow) drawRow(headerRow); }
        const rowY = doc.y;
        let x = M.left;
        if (r.shade) { doc.rect(M.left, rowY, widths.reduce((a, b) => a + b, 0), h).fill(HEAD); doc.fillColor('#000'); }
        r.cells.forEach((c, i) => {
          doc.rect(x, rowY, widths[i], h).lineWidth(0.6).stroke(LINE);
          if (c === '[BOX]' || c === '[BOX_TICKED]') {
            // Times has no ☐/☑ glyphs — draw the checkbox instead.
            const bs = 10;
            const bx = x + (widths[i] - bs) / 2, by = rowY + 5;
            doc.rect(bx, by, bs, bs).lineWidth(0.9).stroke('#000');
            if (c === '[BOX_TICKED]') {
              doc.moveTo(bx + 2, by + 5).lineTo(bx + 4, by + 8).lineTo(bx + 8.5, by + 1.5)
                .lineWidth(1.3).stroke('#000');
            }
          } else {
            doc.font(r.bold ? 'Times-Bold' : 'Times-Roman').fontSize(9.5).fillColor('#000')
              .text(String(c === null || c === undefined ? '' : c), x + pad, rowY + 4.5,
                { width: widths[i] - pad * 2, align: (r.align && r.align[i]) || 'left' });
          }
          x += widths[i];
        });
        doc.y = rowY + h;
      };
      rows.forEach(r => drawRow(r));
      doc.y += 10;
    }

    function labelledBox(label, text, minH = 54) {
      doc.font('Times-BoldItalic').fontSize(9.5);
      const lh = doc.heightOfString(label, { width: USABLE - 10 });
      doc.font('Times-Roman').fontSize(9.5);
      const th = doc.heightOfString(String(text || ' '), { width: USABLE - 10 });
      const h = Math.max(minH, lh + th + 16);
      ensure(h);
      const y = doc.y;
      doc.rect(M.left, y, USABLE, h).lineWidth(0.6).stroke(LINE);
      doc.font('Times-BoldItalic').fontSize(9.5).text(label, M.left + 5, y + 4, { width: USABLE - 10 });
      doc.font('Times-Roman').fontSize(9.5).text(String(text || ''), M.left + 5, y + 6 + lh, { width: USABLE - 10 });
      doc.y = y + h + 10;
    }

    const v = x => (x === null || x === undefined) ? '' : String(x);

    // ================= SECTION A =================
    const a = form.a || {};
    sectionBar('SECTION A:  INTERVIEW DETAILS');
    table([52, 210, 52, USABLE - 314], [
      { cells: ['Date:', v(a.date), 'Time:', v(a.time)], bold: false, minH: 20, align: ['left', 'left', 'left', 'left'] },
    ]);
    doc.font('Times-Bold').fontSize(10).fillColor(INK).text('Committee Members in Attendance', M.left, doc.y - 4);
    doc.fillColor('#000'); doc.y += 4;
    const committee = (a.committee || []).slice(0, 10);
    const commHeader = { cells: ['No.', 'Name', 'Role (Coordinator / Secretary / Member)'], bold: true, shade: true };
    table([34, USABLE - 34 - 190, 190], [
      commHeader,
      ...Array.from({ length: 10 }, (_, i) => ({
        cells: [String(i + 1), v((committee[i] || {}).name), v((committee[i] || {}).role)],
        align: ['center', 'left', 'left'],
      })),
    ], { headerRow: commHeader });

    // ================= SECTION B =================
    const b = form.b || {};
    sectionBar('SECTION B:  THE INTENDED COUPLE');
    const bw = [110, (USABLE - 110) / 2, (USABLE - 110) / 2];
    table(bw, [
      { cells: ['', 'Intended Husband', 'Intended Wife'], bold: true, shade: true, align: ['left', 'center', 'center'] },
      { cells: ['Full Name', v((b.husband || {}).name), v((b.wife || {}).name)], bold: false },
      { cells: ['Phone Number', v((b.husband || {}).phone), v((b.wife || {}).phone)], bold: false },
    ]);

    // ================= SECTION C =================
    const c = form.c || {};
    sectionBar('SECTION C:  FAMILY MEMBERS IN ATTENDANCE');
    const famTable = (title, list, note) => {
      ensure(46);
      doc.rect(M.left, doc.y, USABLE, 18).fill(BAR);
      doc.fillColor(INK).font('Times-Bold').fontSize(10).text(title, M.left + 8, doc.y + 4, { lineBreak: false });
      doc.fillColor('#000'); doc.y += 22;
      const hdr = { cells: ['No.', 'Name', 'Relationship'], bold: true, shade: true };
      table([34, USABLE - 34 - 190, 190], [
        hdr,
        ...Array.from({ length: 6 }, (_, i) => ({
          cells: [String(i + 1), v((list[i] || {}).name), v((list[i] || {}).relationship)],
          align: ['center', 'left', 'left'],
        })),
      ], { headerRow: hdr });
      doc.y -= 6;
      labelledBox('NB: If the father and/or mother is/are not present, state reasons and provide their written consent(s):', note, 48);
    };
    famTable('C1 — Family of the Intended Husband', c.husbandFamily || [], v(c.husbandConsentNote));
    famTable('C2 — Family of the Intended Wife', c.wifeFamily || [], v(c.wifeConsentNote));

    // ================= SECTION D =================
    const d = form.d || {};
    sectionBar('SECTION D:  SCREENING QUESTIONS FOR THE COUPLE');
    doc.font('Times-Italic').fontSize(9.5)
      .text('Each question is answered by the intended husband and the intended wife in their respective columns.', M.left, doc.y);
    doc.y += 6;
    const dHdr = { cells: ['No.', 'Question', 'Intended Husband', 'Intended Wife'], bold: true, shade: true, align: ['center', 'left', 'center', 'center'] };
    table([30, USABLE - 30 - 260, 130, 130], [
      dHdr,
      ...D_QUESTIONS.map((q, i) => ({
        cells: [String(i + 1), q, v((d['q' + (i + 1)] || {}).h), v((d['q' + (i + 1)] || {}).w)],
        align: ['center', 'left', 'left', 'left'],
        minH: 26,
      })),
    ], { headerRow: dHdr });

    // ================= SECTION E =================
    const e = form.e || {};
    sectionBar('SECTION E:  SCREENING QUESTIONS FOR PARENTS / IN LOCO PARENTIS');
    doc.font('Times-Bold').fontSize(10).text('Are you in support of the intended marriage?', M.left, doc.y);
    doc.y += 6;
    const ew = [USABLE - 300, 150, 150];
    table(ew, [
      { cells: ['', 'Family of Intended Husband', 'Family of Intended Wife'], bold: true, shade: true, align: ['left', 'center', 'center'] },
      { cells: ['Father / Representative  (Yes / No)', v((e.h || {}).fatherSupport), v((e.w || {}).fatherSupport)], bold: false },
      { cells: ['If No, provide reasons', v((e.h || {}).fatherReasons), v((e.w || {}).fatherReasons)], minH: 26 },
      { cells: ['Mother / Representative  (Yes / No)', v((e.h || {}).motherSupport), v((e.w || {}).motherSupport)] },
      { cells: ['If No, provide reasons', v((e.h || {}).motherReasons), v((e.w || {}).motherReasons)], minH: 26 },
      { cells: ['Any remarks / comments from the parents', v((e.h || {}).remarks), v((e.w || {}).remarks)], minH: 30 },
    ]);

    // ================= SECTION F =================
    sectionBar("SECTION F:  COMMITTEE'S REMARKS");
    labelledBox('', v(form.f), 90);

    // ================= SECTION G =================
    const g = form.g || {};
    sectionBar('SECTION G:  RECOMMENDATION TO SESSION');
    doc.font('Times-Italic').fontSize(9.5).text('Tick one:', M.left, doc.y);
    doc.y += 4;
    const tick = which => (g.recommendation === which ? '[BOX_TICKED]' : '[BOX]');
    table([34, USABLE - 34], [
      { cells: [tick('clear'), 'No concerns — the couple is to be cleared and provided with a counsellor.'], align: ['center', 'left'], minH: 22 },
      { cells: [tick('concerns'), 'Concerns for which Session should be alerted. Provide details:'
          + (g.recommendation === 'concerns' && g.details ? '\n' + v(g.details) : '')], align: ['center', 'left'], minH: 40 },
    ]);

    // ================= SECTION H (wet signatures) =================
    sectionBar('SECTION H:  AUTHENTICATION');
    const h = form.h || {};
    const signDateStr = h.signDate
      ? toLocalDate(h.signDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    const hw = [90, (USABLE - 90) / 2, (USABLE - 90) / 2];
    table(hw, [
      { cells: ['', 'CFL Coordinator', 'CFL Secretary'], bold: true, shade: true, align: ['left', 'center', 'center'] },
      { cells: ['Name', v(h.coordinatorName), v(h.secretaryName)], minH: 24 },
      { cells: ['Signature', '', ''], minH: 34 },
      // Date prefilled from the interview date; still signed by hand.
      { cells: ['Date', v(signDateStr), v(signDateStr)], minH: 22 },
    ]);

    // ================= SECTION I (after Session approval — blank) =========
    sectionBar('SECTION I:  FOR COMPLETION AFTER SESSION APPROVAL');
    doc.font('Times-Italic').fontSize(9.5)
      .text('NB: This section shall be completed ONLY after the Session has considered this report and approved the intended marriage.', M.left, doc.y, { width: USABLE });
    doc.y += 6;
    // Prefilled from the recorded Session approval once Phase 2 begins;
    // signature and date cells stay blank for wet completion either way.
    const sa = kase.sessionApproval || {};
    const iw = [110, (USABLE / 2) - 110, 120, USABLE / 2 - 120];
    table(iw, [
      { cells: ['Date of Session Approval:', v(sa.date), 'Session Minute / Ref. No.:', v(sa.minuteRef)], bold: true, minH: 24 },
      { cells: ['Date Counselling Commences:', v(sa.counsellingStartDate), 'Couple Informed On (Date):', v(sa.coupleInformedDate)], bold: true, minH: 24 },
    ]);
    const i3 = [80, (USABLE - 80) / 3, (USABLE - 80) / 3, (USABLE - 80) / 3];
    table(i3, [
      { cells: ['', 'Session Clerk', 'CFL Coordinator', 'Assigned Counsellor'], bold: true, shade: true, align: ['left', 'center', 'center', 'center'] },
      { cells: ['Name', '', v(h.coordinatorName), v(sa.counsellorName)], minH: 24 },
      { cells: ['Signature', '', '', ''], minH: 34 },
      { cells: ['Date', '', '', ''], minH: 22 },
    ]);

    // ---- Footers + "Page x of y" on every page ----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      // page number in the doc-control strip
      doc.font('Times-Bold').fontSize(9).fillColor('#000')
        .text(`Page ${i + 1} of ${range.count}`, M.left + (USABLE / 3) * 2, 34 + 56 + 4 + 4.5, { width: USABLE / 3, align: 'center', lineBreak: false });
      // confidentiality footer
      doc.font('Times-Italic').fontSize(7.5).fillColor('#333')
        .text('This form is an exclusive property of PCG – AOTC.  Any disclosure, unauthorized reproduction or use is strictly prohibited except with permission from the Session of PCG – AOTC.',
          M.left, A4.height - 48, { width: USABLE, align: 'center' });
      doc.page.margins.bottom = saved;
    }
    doc.end();
  });
}

// Merge phone photos (JPEG/PNG buffers) of the signed printout into ONE PDF —
// each photo becomes a full A4 page, fitted with margins.
function buildSignedScanPdf(imageBuffers) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 18, autoFirstPage: false, info: { Title: 'Signed Intended Marriage Interview Form (scan)', Author: 'PCG — AOTC (CFL)' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    imageBuffers.forEach(buf => {
      doc.addPage();
      try {
        doc.image(buf, 18, 18, { fit: [A4.width - 36, A4.height - 36], align: 'center', valign: 'center' });
      } catch (e) {
        doc.font('Times-Italic').fontSize(11).text('One page could not be read as an image and was skipped.', 40, 60);
      }
    });
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// PCG-AOTC-CFL-FR02 — Pre-Marital Counselling Questionnaire (BLANK, printed).
// One copy per person, completed privately on paper; the counsellor compares
// the two and uses the mismatches as session topics. Confidential to the
// counsellor — answers are not shared with the partner without consent.
const Q_SECTIONS = [
  ['A — Faith & Spiritual Life', [
    ['Describe your personal walk with God (devotion, prayer life, fellowship).', 3],
    ['What should spiritual leadership in your home look like, and who provides it?', 3],
    ['How involved will each of you be in church life after marriage?', 2],
  ]],
  ['B — Family Background', [
    ["What did your parents' marriage teach you — good lessons and hard ones?", 3],
    ['What does your extended family expect of this marriage?', 2],
    ['How is your relationship with your future in-laws today?', 2],
  ]],
  ['C — Communication & Conflict', [
    ['When you disagree with someone close, what do you usually do (talk it out, withdraw, raise your voice)?', 3],
    ['How are disagreements between the two of you normally resolved at the moment?', 2],
    ['Is there anything currently unresolved between you?', 2],
  ]],
  ['D — Finances', [
    ["Do you both know each other's income, debts and loans? Anything not yet disclosed?", 3],
    ['Who will manage the money in the home, and how will you budget?', 2],
    ['What financial obligations do you carry for parents, siblings or others?', 2],
    ['Are the customary marriage costs agreed and understood by both families?', 2],
  ]],
  ['E — Roles & Expectations', [
    ['How will household duties be shared?', 2],
    ['How will major decisions be made in the marriage?', 2],
    ["What are both of your career plans, and where will you live?", 2],
  ]],
  ['F — Health & Intimacy', [
    ['Are there any health conditions your partner should know about?', 2],
    ['What are your expectations of intimacy in marriage?', 2],
    ['MEDICAL SCREENING (optional — complete if required by Session): genotype / sickle-cell status, blood group, other screening results, with date and facility.', 3],
  ]],
  ['G — Children & Parenting', [
    ['How many children do you hope for, and when?', 2],
    ['How will you approach discipline and raising children in the faith?', 2],
    ['If either of you has children already: how will step-parenting work?', 2],
  ]],
  ['H — Past Relationships & Honesty', [
    ['Previous marriages or serious relationships — and any obligations that remain from them?', 3],
    ['Is there anything from your past your partner should know before the marriage?', 2],
  ]],
  ['I — Habits & Lifestyle', [
    ['Alcohol, smoking or other habits your partner should be aware of?', 2],
    ['How do you spend your leisure time, and how much of it with friends?', 2],
  ]],
  ['J — Hopes & Fears', [
    ['Why do you want to marry him/her?', 3],
    ['What worries you most about marriage?', 2],
    ['What would a successful marriage look like to you after ten years?', 3],
  ]],
];

function buildQuestionnairePdf(kase, who) {
  const isH = who === 'husband';
  const b = ((kase || {}).form || {}).b || {};
  const personName = ((isH ? b.husband : b.wife) || {}).name || '';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: 'Pre-Marital Counselling Questionnaire', Author: 'PCG — AOTC (CFL)' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    function pageHeader() {
      const y0 = 34, h = 56, crestW = 120;
      doc.lineWidth(1).rect(M.left, y0, USABLE, h).stroke('#000');
      doc.moveTo(M.left + crestW, y0).lineTo(M.left + crestW, y0 + h).stroke('#000');
      try { if (fs.existsSync(CREST)) doc.image(CREST, M.left + (crestW - 42) / 2, y0 + 7, { fit: [42, 42] }); } catch (e) {}
      doc.font('Times-Bold').fontSize(12).fillColor('#000')
        .text('PRE-MARITAL COUNSELLING QUESTIONNAIRE', M.left + crestW, y0 + h / 2 - 8, { width: USABLE - crestW, align: 'center' });
      const y1 = y0 + h + 4, strip = 18, cw = USABLE / 3;
      doc.lineWidth(1).rect(M.left, y1, USABLE, strip).stroke('#000');
      doc.moveTo(M.left + cw, y1).lineTo(M.left + cw, y1 + strip).stroke('#000');
      doc.moveTo(M.left + 2 * cw, y1).lineTo(M.left + 2 * cw, y1 + strip).stroke('#000');
      doc.font('Times-Bold').fontSize(9);
      doc.text('Doc No.: PCG-AOTC-CFL-FR02', M.left + 6, y1 + 4.5, { width: cw - 12, lineBreak: false });
      doc.text('Revision: 0', M.left + cw, y1 + 4.5, { width: cw, align: 'center', lineBreak: false });
      doc.y = M.top;
    }
    doc.on('pageAdded', pageHeader);
    pageHeader();

    const bottomY = A4.height - M.bottom - 26;
    const ensure = h => { if (doc.y + h > bottomY) doc.addPage(); };
    const rule = () => {
      doc.moveTo(M.left, doc.y).lineTo(M.left + USABLE, doc.y).lineWidth(0.5).stroke('#999');
      doc.y += 17;
    };

    // Identity + instructions
    doc.rect(M.left, doc.y, USABLE, 40).lineWidth(0.6).stroke(LINE);
    doc.font('Times-Bold').fontSize(10)
      .text(`To be completed PRIVATELY by the Intended ${isH ? 'Husband' : 'Wife'}`, M.left + 6, doc.y + 5, { lineBreak: false });
    doc.font('Times-Roman').fontSize(10)
      .text(`Name: ${personName || '________________________________'}     Case Ref: ${kase.refNo || ''}     Date: ____________`, M.left + 6, doc.y + 22, { lineBreak: false });
    doc.y += 48;
    doc.font('Times-Italic').fontSize(9)
      .text('Answer honestly and in your own words — there are no right or wrong answers. Your answers are CONFIDENTIAL to your counsellor and will not be shown to your partner without your consent. Where a question needs more space, continue on the back of the page.', M.left, doc.y, { width: USABLE });
    doc.y += 10;

    Q_SECTIONS.forEach(([title, questions]) => {
      ensure(60);
      doc.rect(M.left, doc.y, USABLE, 20).fill(BAR);
      doc.fillColor(INK).font('Times-Bold').fontSize(11).text(title, M.left + 8, doc.y + 4.5, { lineBreak: false });
      doc.fillColor('#000');
      doc.y += 28;
      questions.forEach(([q, nLines], qi) => {
        doc.font('Times-Roman').fontSize(10);
        const qh = doc.heightOfString(`${qi + 1}. ${q}`, { width: USABLE });
        ensure(qh + nLines * 17 + 12);
        doc.text(`${qi + 1}. ${q}`, M.left, doc.y, { width: USABLE });
        doc.y += 6;
        for (let li = 0; li < nLines; li++) { ensure(20); rule(); }
        doc.y += 4;
      });
    });

    ensure(60);
    doc.font('Times-Bold').fontSize(10).text('Declaration', M.left, doc.y);
    doc.y += 4;
    doc.font('Times-Roman').fontSize(9.5).text('I confirm that the answers above are true and complete to the best of my knowledge.', M.left, doc.y, { width: USABLE });
    doc.y += 16;
    doc.font('Times-Roman').fontSize(10).text('Signature: ______________________________          Date: ____________', M.left, doc.y);

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Times-Bold').fontSize(9).fillColor('#000')
        .text(`Page ${i + 1} of ${range.count}`, M.left + (USABLE / 3) * 2, 34 + 56 + 4 + 4.5, { width: USABLE / 3, align: 'center', lineBreak: false });
      doc.font('Times-Italic').fontSize(7.5).fillColor('#333')
        .text('CONFIDENTIAL to the assigned counsellor and the CFL Committee.  This form is an exclusive property of PCG – AOTC. Any disclosure, unauthorized reproduction or use is strictly prohibited except with permission from the Session of PCG – AOTC.',
          M.left, A4.height - 48, { width: USABLE, align: 'center' });
      doc.page.margins.bottom = saved;
    }
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Marriage Register — landscape A4, one ruled line per marriage in the year.
function buildMarriageRegisterPdf(year, rows) {
  return new Promise((resolve, reject) => {
    const L = { width: 841.89, height: 595.28 };
    const m = { top: 54, bottom: 48, left: 40, right: 40 };
    const usable = L.width - m.left - m.right;
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: m, bufferPages: true, info: { Title: `Marriage Register ${year}`, Author: 'PCG — AOTC (CFL)' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    function header() {
      doc.font('Times-Bold').fontSize(13).fillColor('#000')
        .text('Presbyterian Church of Ghana — Adabraka Official Town Congregation', m.left, 26, { width: usable, align: 'center' });
      doc.font('Times-Bold').fontSize(12).fillColor(INK)
        .text(`MARRIAGE REGISTER — ${year}`, m.left, 44, { width: usable, align: 'center' });
      doc.fillColor('#000');
      doc.y = m.top + 20;
    }
    doc.on('pageAdded', header);
    header();

    const widths = [26, 62, 150, 150, 62, 110, 105, 60, 76];
    const heads = ['No.', 'Date', 'Husband', 'Wife', 'Customary', 'Officiating Minister', 'Venue', 'Cert. No.', 'Case Ref'];
    const pad = 4;
    const drawRow = (cells, bold, shade) => {
      doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(9);
      const h = Math.max(20, ...cells.map((c, i) => doc.heightOfString(String(c || ' '), { width: widths[i] - pad * 2 }) + 8));
      if (doc.y + h > L.height - m.bottom - 20) { doc.addPage(); drawRow(heads, true, true); return drawRow(cells, bold, shade); }
      const y = doc.y;
      let x = m.left;
      if (shade) { doc.rect(m.left, y, widths.reduce((a, b) => a + b, 0), h).fill(HEAD); doc.fillColor('#000'); }
      cells.forEach((c, i) => {
        doc.rect(x, y, widths[i], h).lineWidth(0.5).stroke(LINE);
        doc.font(bold ? 'Times-Bold' : 'Times-Roman').fontSize(9).fillColor('#000')
          .text(String(c || ''), x + pad, y + 4, { width: widths[i] - pad * 2 });
        x += widths[i];
      });
      doc.y = y + h;
    };
    drawRow(heads, true, true);
    const fmt = d => d ? toLocalDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    if (!rows.length) {
      doc.font('Times-Italic').fontSize(10).text(`No marriages entered in the register for ${year} yet.`, m.left, doc.y + 8);
    }
    rows.forEach(r => drawRow([r.no, fmt(r.date), r.husband, r.wife, fmt(r.customaryDate), r.officiant, r.venue, r.certificateNo, r.refNo]));

    doc.y += 18;
    doc.font('Times-Roman').fontSize(9.5)
      .text(`Total marriages solemnised in ${year}: ${rows.length}`, m.left, doc.y);
    doc.y += 26;
    doc.text('Session Clerk: ______________________________          Minister: ______________________________          Date: ____________', m.left, doc.y);

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Times-Italic').fontSize(7.5).fillColor('#333')
        .text(`CONFIDENTIAL — Session of PCG-AOTC.  Page ${i + 1} of ${range.count}`, m.left, L.height - 34, { width: usable, align: 'center', lineBreak: false });
      doc.page.margins.bottom = saved;
    }
    doc.end();
  });
}

module.exports = { buildMarriageFormPdf, buildSignedScanPdf, buildQuestionnairePdf, buildMarriageRegisterPdf, D_QUESTIONS };
