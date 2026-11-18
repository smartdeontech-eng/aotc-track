// Minutes and agenda as Word documents, built inside the organisation's own file.
//
// The body is generated with the `docx` library and then spliced into the
// organisation's template (its page size and margins, masthead, watermark,
// footer, styles and fonts come across byte-for-byte; only <w:body> is ours).
// With no template the document is built standalone with a plain masthead.
//
// Everything that names an organisation, a font or a measurement comes in as
// `style`; the defaults are neutral. AOTC Track's measured values live in AOTC.
//
//   const { createMinutesDocx } = require('@deontech/minutes');
//   const W = createMinutesDocx({ docx: require('docx'), JSZip: require('jszip'), style });
//   const buf = await W.minutes(data);   // data: see minutes() below
//   const buf = await W.agenda(data);
'use strict';

const fs = require('fs');
const { bulletise, longDate } = require('./text');

const DEFAULT_STYLE = {
  minutes: {
    font: 'Calibri', bodyFont: 'Calibri', size: 24, bodySize: 20, smallSize: 20,
    line: 360,                       // 1.5 lines on the body
    cols: [635, 8084, 1838], indent: -765, posTab: 6237,
    gridColor: '000000', gridSize: 8,
    headers: { no: 'No.', subject: 'Subject', action: 'Action' },
    signatures: { recorded: 'Recorded by', confirmed: 'Confirmed by', recordedTitle: 'Secretary', confirmedTitle: 'Chairperson', shade: 'D9E2F3' },
    defaultHeading: 'MEETING',
    attendancePageBreak: true,
    rosterFont: null,                // null: the template's own default font
    templates: [],
    masthead: [],                    // standalone only
    owner: null,                     // (xml, owner) => xml, applied to footers when data.owner is set
  },
  agenda: {
    font: 'Calibri', titleFont: 'Calibri', headFont: 'Calibri Light', blue: '1F4E79',
    cols: [2141, 4678, 3989], indent: -180, defaultHeading: 'MEETING',
    templates: [], masthead: [],
  },
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k]) && typeof v !== 'function'
      ? { ...base[k], ...v } : v;
  }
  return out;
}

function createMinutesDocx({ docx, JSZip, style = {} } = {}) {
  if (!docx || !JSZip) throw new Error('@deontech/minutes: pass { docx, JSZip } from the app');
  const {
    Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell,
    WidthType, VerticalAlign, BorderStyle, PageBreak, TabStopType, UnderlineType, Tab, TableLayoutType,
    ShadingType, VerticalMergeType,
  } = docx;
  const S = merge(DEFAULT_STYLE.minutes, style.minutes);
  const A = merge(DEFAULT_STYLE.agenda, style.agenda);
  const LINE = { line: S.line, lineRule: 'auto' };
  const TABLE_W = S.cols.reduce((a, b) => a + b, 0);
  const rule = { style: BorderStyle.SINGLE, size: S.gridSize, color: S.gridColor };
  const GRID = { top: rule, bottom: rule, left: rule, right: rule, insideHorizontal: rule, insideVertical: rule };

  function t(text, o = {}) {
    return new TextRun({
      text: String(text == null ? '' : text),
      font: o.font || S.font,
      size: o.size === 0 ? undefined : (o.size || S.size),
      bold: !!o.bold,
      italics: !!o.italics,
      color: o.color,
      underline: o.underline ? { type: UnderlineType.SINGLE } : undefined,
    });
  }
  function p(text, o = {}) {
    return new Paragraph({
      alignment: o.center ? AlignmentType.CENTER : (o.justify ? AlignmentType.BOTH : AlignmentType.LEFT),
      keepNext: !!o.keepNext,
      spacing: { after: o.after != null ? o.after : 0, before: o.before || 0, ...(o.line15 ? LINE : {}) },
      children: Array.isArray(text) ? text : [t(text, o)],
    });
  }
  function cell(children, o = {}) {
    const paras = Array.isArray(children) ? children : [new Paragraph({ children: [t(children, o)] })];
    return new TableCell({
      width: { size: o.dxa || 1000, type: WidthType.DXA },
      verticalAlign: VerticalAlign.TOP,
      margins: o.pad ? { right: 340, left: 0, top: 0, bottom: 0 } : undefined,
      shading: o.shade ? { type: ShadingType.CLEAR, fill: o.shade } : undefined,
      children: paras,
    });
  }
  // A point hangs at 720 twips; the tab must live inside the run or Word drops it.
  // 0.5.2: style.minutes.justifyPoints sets points justified like the prose
  // around them (AOTC, 21 Oct 2026); otherwise they stay ranged left.
  function bullet(text, o = {}) {
    return new Paragraph({
      alignment: S.justifyPoints && o.justify !== false ? AlignmentType.BOTH : AlignmentType.LEFT,
      indent: { left: 720, hanging: 360 },
      tabStops: [{ type: TabStopType.LEFT, position: 720 }],
      spacing: { after: 0, ...LINE },
      children: [
        new TextRun({ font: o.font || S.font, size: o.size === 0 ? undefined : (o.size || S.size), children: ['•', new Tab()] }),
        t(text, o),
      ],
    });
  }
  // Body text: paragraphs, points, and labelled lines ("Decision:", "Motion:")
  // with the label in italics. Justified, except points.
  function textParas(body, o = {}) {
    o = { font: S.bodyFont, size: S.bodySize, ...o };
    const lines = bulletise(body);
    const align = o.justify === false ? AlignmentType.LEFT : AlignmentType.BOTH;
    if (!lines.length) return [new Paragraph({ alignment: align, children: [t('', o)] })];
    return lines.map((l) => (l.bullet
      ? bullet(l.text, o)
      : new Paragraph({ alignment: align, spacing: { after: 0, ...LINE },
        children: l.label
          ? [t(l.label, { ...o, italics: true }), t(l.text.slice(l.label.length), o)]
          : [t(l.text, o)] })));
  }

  // "1. <tab> NAME <tab> POSITION", in capitals.
  function rosterLines(people) {
    const list = Array.isArray(people) ? people : [];
    if (!list.length) return [p('NIL', { after: 0 })];
    // 0.5.1: an optional `details` line under the name (someone in attendance:
    // "Third-year student, Trinity Theological Seminary"), in ordinary letters,
    // aligned with the name and kept on the same page as it.
    return list.flatMap((m, i) => {
      const details = String(m.details || '').trim();
      const line = new Paragraph({
        spacing: { after: 0 },
        indent: { left: 360, hanging: 360 },
        keepNext: !!details,
        tabStops: [{ type: TabStopType.LEFT, position: S.posTab }],
        children: [new TextRun({
          size: S.size,
          ...(S.rosterFont ? { font: S.rosterFont } : {}),
          children: [`${i + 1}.`, new Tab(), String(m.name || '').toUpperCase(), new Tab(), String(m.position || 'MEMBER').toUpperCase()],
        })],
      });
      if (!details) return [line];
      return [line, new Paragraph({
        spacing: { after: 40 },
        indent: { left: 360 },
        children: [new TextRun({ size: S.detailsSize || S.size, ...(S.rosterFont ? { font: S.rosterFont } : {}), text: details })],
      })];
    });
  }

  // A grid of figures inside an item (a finance statement, a vote count).
  function nestedGrid(grid) {
    const head = grid.head || [];
    const n = Math.max(1, head.length);
    const inner = S.cols[1] - 200;
    const labelW = Math.round(inner * 0.26);
    const colW = Math.round((inner - labelW) / (n - 1 || 1));
    const w = (i) => (i === 0 ? labelW : colW);
    const strong = grid.strong || /BALANCE|RECEIPTS|PAYMENTS/;
    const mini = (text, i, o = {}) => new TableCell({
      width: { size: w(i), type: WidthType.DXA },
      verticalAlign: VerticalAlign.TOP,
      children: [new Paragraph({ alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT, spacing: { after: 0 },
        children: [t(text, { size: S.smallSize, bold: !!o.bold })] })],
    });
    const rows = [new TableRow({ tableHeader: true, children: head.map((h, i) => mini(h, i, { bold: true })) })];
    (grid.rows || []).forEach((r) => {
      const bold = strong.test(String(r[0] || ''));
      rows.push(new TableRow({ children: r.map((c, i) => mini(c, i, { bold })) }));
    });
    return new Table({ width: { size: inner, type: WidthType.DXA }, columnWidths: head.map((_, i) => w(i)), borders: GRID, rows });
  }

  function bodyTable(rows) {
    const H = S.headers;
    const out = [new TableRow({
      tableHeader: true,
      children: [
        cell([p(H.no, { bold: true })], { dxa: S.cols[0] }),
        cell([p(H.subject, { bold: true })], { dxa: S.cols[1] }),
        cell([p(H.action, { bold: true, size: S.smallSize, center: true })], { dxa: S.cols[2] }),
      ],
    })];
    (rows || []).forEach((r) => {
      const subject = [];
      if (r.subject) subject.push(p(r.subject, { bold: true, justify: true, line15: true }));
      if (r.body) subject.push(...textParas(r.body));
      if (r.table) { subject.push(nestedGrid(r.table)); subject.push(p('')); }
      if (!subject.length) subject.push(p(''));
      out.push(new TableRow({
        children: [
          cell([p(r.no || '', { bold: true })], { dxa: S.cols[0] }),
          cell(subject, { dxa: S.cols[1] }),
          cell(r.action ? textParas(r.action, { justify: false }) : [p('')], { dxa: S.cols[2] }),
        ],
      }));
    });
    return new Table({ width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: S.cols,
      indent: { size: S.indent, type: WidthType.DXA }, borders: GRID, rows: out });
  }

  // Recorded by | Confirmed by: room to sign, the name, the office. No date
  // line: the minutes are dated by their meeting.
  function signatureBlock(sig = {}) {
    const L = S.signatures;
    const rec = sig.recordedBy || {}, con = sig.confirmedBy || {};
    const half = Math.round(TABLE_W / 2);
    const F = { font: S.bodyFont, size: S.bodySize, center: true };
    const head = (label) => cell([p(label, { font: S.font, size: S.size, center: true, bold: true, after: 0, keepNext: true })], { dxa: half, shade: L.shade });
    const col = (who, title) => cell([p('', F), p('', F), p('', F), p(who || '', { ...F, bold: true, after: 0 }), p(`(${title})`, { ...F, after: 60 })], { dxa: half });
    return new Table({
      width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: [half, half],
      indent: { size: S.indent, type: WidthType.DXA }, borders: GRID,
      rows: [
        new TableRow({ tableHeader: true, children: [head(L.recorded), head(L.confirmed)] }),
        new TableRow({ cantSplit: true, children: [col(rec.name, rec.title || L.recordedTitle), col(con.name, con.title || L.confirmedTitle)] }),
      ],
    });
  }

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function appendixChildren(appendices) {
    const out = [];
    (appendices || []).filter((a) => (a.title && a.title.trim()) || (a.body && a.body.trim())).forEach((a, i) => {
      out.push(new Paragraph({ children: [new PageBreak()] }));
      out.push(p(`Appendix ${LETTERS[i] || i + 1}`, { bold: true, after: 160 }));
      if (a.title && a.title.trim()) out.push(p(a.title.trim().toUpperCase(), { bold: true, center: true, after: 200 }));
      if (a.body && a.body.trim()) out.push(...textParas(a.body, { justify: true }));
    });
    return out;
  }

  function minutesTitle(data) {
    if (S.title) return S.title(data);
    const venue = (data.venue || '').trim();
    return `MINUTES OF THE ${(data.heading || S.defaultHeading).toUpperCase()}`
      + (venue ? ` HELD AT ${venue.toUpperCase()}` : '')
      + ` ON ${longDate(data.date, { upper: true, comma: true })}`;
  }
  // The attendance blocks, in order. An app may set data.attendance itself
  // ([{ label, people, hideIfEmpty }]); otherwise the four usual lists.
  function attendanceOf(data) {
    if (Array.isArray(data.attendance)) return data.attendance;
    return [
      { label: 'MEMBERS PRESENT:', people: data.present },
      { label: 'IN ATTENDANCE:', people: data.inAttendance, hideIfEmpty: true },
      { label: 'MEMBERS WITH APOLOGIES:', people: data.apologies },
      { label: 'MEMBERS ABSENT:', people: data.absent },
    ];
  }

  function minutesChildren(data) {
    const c = [];
    c.push(p(minutesTitle(data), { bold: true, center: true, underline: true, before: 40, after: 9 }));
    if (data.subtitle) c.push(p(data.subtitle, { center: true, after: 0, font: S.bodyFont, size: S.bodySize }));
    c.push(p(''));
    for (const block of attendanceOf(data)) {
      if (block.hideIfEmpty && !(block.people || []).length) continue;
      c.push(p(block.label, { bold: true, after: 0 }));
      c.push(...rosterLines(block.people));
      if (block.note) c.push(p(block.note, { font: S.bodyFont, size: S.bodySize, after: 0 }));
      c.push(p(''));
    }
    if (S.attendancePageBreak) c.push(new Paragraph({ children: [new PageBreak()] }));
    c.push(bodyTable(data.rows));
    c.push(p('', { font: S.bodyFont, size: S.bodySize }));
    c.push(signatureBlock(data.signatories || {}));
    c.push(...appendixChildren(data.appendices));
    return c;
  }

  // ---- the agenda ------------------------------------------------------------
  // One table row per LINE (item, then sub-items) so each name stays level with
  // its own line; rules above each item and below its last sub-item; a single
  // vertical rule after Time; the time and a whole-block owner merged down the block.
  const AG_W = A.cols.reduce((a, b) => a + b, 0);
  const AG_RULE = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
  const AG_NONE = { style: BorderStyle.NONE };
  const LETTER = 'abcdefghijklmnopqrstuvwxyz';

  function agendaTitleRuns(data) {
    const R = { font: A.titleFont, bold: true, underline: { type: UnderlineType.SINGLE } };
    const text = A.title ? A.title(data)
      : `AGENDA FOR ${(data.heading || A.defaultHeading).toUpperCase()} ON ${longDate(data.date, { upper: true })}`;
    const m = text.match(/^(.*?\b\d{1,2})(ST|ND|RD|TH)(\b.*)$/);
    if (!m) return [new TextRun({ ...R, text })];
    return [new TextRun({ ...R, text: m[1] }), new TextRun({ ...R, text: m[2], superScript: true }), new TextRun({ ...R, text: m[3] })];
  }

  function agendaChildren(data) {
    const c = [];
    c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0, line: 240, lineRule: 'auto' }, children: agendaTitleRuns(data) }));
    if (data.subtitle) c.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [new TextRun({ text: data.subtitle, font: A.font })] }));
    c.push(new Paragraph({}));
    const acell = (children, i, opts = {}) => new TableCell({
      width: { size: A.cols[i], type: WidthType.DXA }, verticalAlign: VerticalAlign.TOP,
      borders: { top: opts.top === false ? AG_NONE : AG_RULE, bottom: opts.bottom === false ? AG_NONE : AG_RULE, left: AG_NONE, right: i === 0 ? AG_RULE : AG_NONE },
      children,
    });
    const heading = (txt) => new Paragraph({ spacing: { before: 100, after: 100, line: 240, lineRule: 'auto' },
      children: [new TextRun({ text: txt, font: A.headFont, bold: true, color: A.blue })] });
    const numbered = (mark, txt, opts = {}) => new Paragraph({
      spacing: { before: 100, after: 100, line: 240, lineRule: 'auto' },
      indent: opts.sub ? { left: 811, hanging: 360 } : { left: 451, hanging: 360 },
      tabStops: [{ type: TabStopType.LEFT, position: opts.sub ? 811 : 451 }],
      children: [new TextRun({ bold: !opts.sub, ...(A.bodyFont ? { font: A.bodyFont } : {}), children: [mark, new Tab(), txt] })],
    });
    const who = (txt) => new Paragraph({ spacing: { before: 100, after: 100, line: 240, lineRule: 'auto' },
      children: [new TextRun({ text: txt, ...(A.bodyFont ? { font: A.bodyFont } : {}) })] });
    const H = A.headers || { time: 'Time', item: 'Item', responsible: 'Responsible' };
    const rows = [new TableRow({ tableHeader: true, children: [acell([heading(H.time)], 0), acell([heading(H.item)], 1), acell([heading(H.responsible)], 2)] })];

    (data.rows || []).forEach((r, idx) => {
      const subs = (r.subItems || []).map((sub) => ({ label: String((sub && sub.item) || sub || '').trim(), name: String((sub && sub.responsible) || '').trim() })).filter((x) => x.label);
      const perLine = subs.some((x) => x.name);
      const wholeBlock = subs.length > 0 && !perLine && !!String(r.responsible || '').trim();
      const lines = [{ item: numbered(r.mark || `${idx + 1}.`, r.item || ''), name: (!wholeBlock && r.responsible) ? who(r.responsible) : new Paragraph({}) }]
        .concat(subs.map((x, j) => ({ item: numbered(`${LETTER[j] || j + 1})`, x.label, { sub: true }), name: x.name ? who(x.name) : new Paragraph({}) })));
      const time = r.time != null ? String(r.time) : `${String(r.at || '')}${r.mins ? ` (${r.mins} min${r.mins === 1 ? '' : 's'})` : ''}`.trim();
      lines.forEach((ln, li) => {
        const first = li === 0, last = li === lines.length - 1;
        rows.push(new TableRow({ children: [
          new TableCell({ width: { size: A.cols[0], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
            verticalMerge: first ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE,
            borders: { top: first ? AG_RULE : AG_NONE, bottom: last ? AG_RULE : AG_NONE, left: AG_NONE, right: AG_RULE },
            children: first ? [who(time)] : [new Paragraph({})] }),
          acell([ln.item], 1, { top: first, bottom: last }),
          wholeBlock
            ? new TableCell({ width: { size: A.cols[2], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
              verticalMerge: first ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE,
              borders: { top: first ? AG_RULE : AG_NONE, bottom: last ? AG_RULE : AG_NONE, left: AG_NONE, right: AG_NONE },
              children: first ? [who(r.responsible)] : [new Paragraph({})] })
            : acell([ln.name], 2, { top: first, bottom: last }),
        ] }));
      });
    });
    c.push(new Table({
      width: { size: AG_W, type: WidthType.DXA }, columnWidths: A.cols, indent: { size: A.indent, type: WidthType.DXA },
      // Silenced explicitly: left alone the library writes a full default grid.
      borders: { top: AG_NONE, bottom: AG_NONE, left: AG_NONE, right: AG_NONE, insideHorizontal: AG_NONE, insideVertical: AG_NONE },
      layout: TableLayoutType.FIXED, margins: { left: 0, right: 115 }, rows,
    }));
    if (data.notes) {
      c.push(new Paragraph({}));
      for (const line of String(data.notes).split('\n')) c.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: line, ...(A.bodyFont ? { font: A.bodyFont } : {}) })] }));
    }
    return c;
  }

  // ---- template plumbing -----------------------------------------------------
  function bodyInnerXml(documentXml) {
    const open = documentXml.match(/<w:body[^>]*>/);
    if (!open) return '';
    let inner = documentXml.slice(documentXml.indexOf(open[0]) + open[0].length);
    inner = inner.replace(/<\/w:body>\s*<\/w:document>\s*$/, '');
    inner = inner.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>\s*$/, '').replace(/<w:sectPr[^>]*\/>\s*$/, '');
    return inner;
  }
  async function renderBodyOnlyXml(children) {
    const buf = await Packer.toBuffer(new Document({ sections: [{ properties: {}, children }] }));
    const zip = await JSZip.loadAsync(buf);
    return bodyInnerXml(await zip.file('word/document.xml').async('string'));
  }
  async function buildFromBaseTemplate(children, templatePath, owner, ownerRule) {
    const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
    if (owner && ownerRule) {
      const safe = String(owner).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      for (const name of Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n))) {
        zip.file(name, ownerRule(await zip.file(name).async('string'), safe));
      }
    }
    const docFile = zip.file('word/document.xml');
    if (!docFile) throw new Error('template has no document.xml');
    const docXml = await docFile.async('string');
    const open = docXml.match(/<w:body[^>]*>/);
    const sect = (docXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) || []).pop();
    if (!open || !sect) throw new Error('template body/sectPr not found');
    const head = docXml.slice(0, docXml.indexOf(open[0]) + open[0].length);
    zip.file('word/document.xml', head + (await renderBodyOnlyXml(children)) + sect + '</w:body></w:document>');
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
  async function buildStandalone(children, masthead, font) {
    const head = (masthead || []).map((line, i, a) => p(line, { font, bold: true, center: true, size: S.smallSize, after: i === a.length - 1 ? 200 : 0 }));
    return Packer.toBuffer(new Document({ sections: [{ properties: {}, children: head.concat(children) }] }));
  }
  async function build(children, candidates, masthead, font, owner, ownerRule) {
    for (const tpl of candidates) {
      try {
        if (tpl && fs.existsSync(tpl)) return await buildFromBaseTemplate(children, tpl, owner, ownerRule);
      } catch (e) {
        console.error('[@deontech/minutes] template failed, trying next:', tpl, e.message);
      }
    }
    return buildStandalone(children, masthead, font);
  }

  // data: { heading, date, venue, subtitle?, present/inAttendance/apologies/absent
  //         or attendance:[{label,people,hideIfEmpty,note}], rows:[{no,subject,body,action,table}],
  //         signatories:{recordedBy:{name,title},confirmedBy:{name,title}}, appendices, owner }
  function minutes(data, opts = {}) {
    return build(minutesChildren(data), [opts.templatePath].concat(S.templates), S.masthead, S.font, data.owner, S.owner);
  }
  // data: { heading, date, subtitle?, rows:[{at,mins,item,responsible,subItems,time?,mark?}], notes? }
  function agenda(data, opts = {}) {
    return build(agendaChildren(data), [opts.templatePath].concat(A.templates), A.masthead, A.titleFont);
  }
  // A letter or notice on the same letterhead: blocks of
  // { text, bold, italic, size, center, right, justify, before, after, list }.
  // `list: true` makes it a point; text may be an array of runs { text, bold, italics }.
  function letterChildren(blocks) {
    return (blocks || []).map((b) => {
      const runs = (Array.isArray(b.text) ? b.text : [{ text: b.text }])
        .map((r) => t(r.text, { font: S.bodyFont, size: b.size || S.bodySize, bold: r.bold || b.bold, italics: r.italics || b.italic, color: r.color || b.color, underline: r.underline || b.underline }));
      if (b.pageBreak) return new Paragraph({ children: [new PageBreak()] });
      return new Paragraph({
        alignment: b.center ? AlignmentType.CENTER : b.right ? AlignmentType.RIGHT : b.justify ? AlignmentType.BOTH : AlignmentType.LEFT,
        spacing: { before: b.before || 0, after: b.after != null ? b.after : 120 },
        keepNext: !!b.keep,
        ...(b.list ? { indent: { left: 720, hanging: 360 }, tabStops: [{ type: TabStopType.LEFT, position: 720 }] } : b.indent ? { indent: { left: 360 } } : {}),
        children: b.list ? [new TextRun({ font: S.bodyFont, size: b.size || S.bodySize, children: ['\u2022', new Tab()] })].concat(runs) : runs,
      });
    });
  }
  function letter(blocks, opts = {}) {
    return build(letterChildren(blocks), [opts.templatePath].concat(S.templates), S.masthead, S.font);
  }
  return { minutes, agenda, letter, minutesChildren, agendaChildren, style: { minutes: S, agenda: A } };
}

module.exports = { createMinutesDocx, DEFAULT_STYLE };
