// AOTC Track — correspondence, exported to share (Oct 2026).
//
// One builder for every place letters are listed: the Correspondence Inbox,
// the Session's correspondence register, and the Correspondence tab of a set
// of minutes. Each letter is written out with its details — who it is from,
// when it was dated and received, what it asks for and by when, the summary,
// the action, and where it went — so the file can be sent to someone who has
// no account. The scanned pages can be put in too (JPG and PNG; a page that was
// uploaded as a PDF is named, not embedded, because neither library can place a
// PDF page inside another document).
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun, PageBreak, BorderStyle,
} = require('docx');

const CREST = path.join(__dirname, '..', 'public', 'img', 'logo.png');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-09-24" → "24 September 2026". Calendar days are kept as text, never
// turned into an instant, so the day cannot shift (see dates-and-timezones.md).
function longDay(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function whereItWent(c) {
  switch (c.status) {
    case 'tabled': return c.meetingDate ? `Read at the Session meeting of ${longDay(c.meetingDate)}` : 'In a set of Session minutes';
    case 'session': return 'Waiting for the Session' + (c.returnedFrom && c.returnedFrom.date ? ` (sent back from the meeting of ${longDay(c.returnedFrom.date)})` : '');
    case 'handled': return 'Handled without the Session' + (c.handledNote ? ` — ${c.handledNote}` : '');
    default: return 'Waiting to be sorted';
  }
}

// The details of one letter, as label/value pairs, in the order a reader wants.
function detailsOf(c) {
  return [
    ['From', c.from],
    ['Dated', longDay(c.letterDate)],
    ['Received', longDay(c.receivedOn)],
    ['Asks for a response or event on', longDay(c.eventDate)],
    ['Where it is', whereItWent(c)],
    ['Action', c.action],
    ['Scanned in by', c.addedBy],
    ['Pages', c.pageCount ? String(c.pageCount) : ''],
  ].filter(([, v]) => v);
}

// Width and height of a JPEG or PNG, read from its header, so the page can be
// fitted without an image library.
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
        return { type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// The scanned pages of a letter that can be placed in the document, and the
// ones that cannot (a PDF page, a missing file, WebP/GIF).
function pageImages(c, filesDir) {
  const out = [], skipped = [];
  (c.files || []).forEach((f, i) => {
    const label = `Page ${i + 1}`;
    try {
      const fp = path.join(filesDir, path.basename(f.filename || ''));
      if (!f.filename || !fs.existsSync(fp)) { skipped.push(`${label}: the file is missing on the server`); return; }
      if (f.mimetype === 'application/pdf') { skipped.push(`${label} was uploaded as a PDF — open it in AOTC Track`); return; }
      const buf = fs.readFileSync(fp);
      const size = imageSize(buf);
      if (!size) { skipped.push(`${label} is not a JPG or PNG — open it in AOTC Track`); return; }
      out.push({ label, buf, ...size });
    } catch (e) { skipped.push(`${label} could not be read`); }
  });
  return { images: out, skipped };
}

// ---------------------------------------------------------------- PDF -------
const A4 = { width: 595.28, height: 841.89 };
const M = { top: 54, bottom: 60, left: 56, right: 56 };
const W = A4.width - M.left - M.right;
const BLUE = '#1D3F94';

function buildCorrespondencePdf(data, opts = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, info: { Title: data.title || 'Correspondence' } });
    const chunks = [];
    doc.on('data', ch => chunks.push(ch));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Letterhead
    doc.font('Times-Bold').fontSize(14).fillColor('#000').text('Presbyterian Church of Ghana', M.left, M.top, { width: W, align: 'center' });
    const crestY = doc.y + 4;
    try { if (fs.existsSync(CREST)) doc.image(CREST, (A4.width - 52) / 2, crestY, { fit: [52, 60] }); } catch (e) {}
    doc.y = crestY + 64;
    doc.font('Times-Bold').fontSize(11.5).text('Adabraka Official Town Congregation', M.left, doc.y, { width: W, align: 'center' });
    doc.moveDown(0.6);
    doc.font('Times-Bold').fontSize(13).text(String(data.title || 'Correspondence').toUpperCase(), { width: W, align: 'center' });
    if (data.subtitle) doc.font('Times-Roman').fontSize(10.5).fillColor('#333').text(data.subtitle, { width: W, align: 'center' });
    doc.fillColor('#000').moveDown(0.8);

    const letters = data.letters || [];
    if (!letters.length) doc.font('Times-Italic').fontSize(11).text('No letters to show.', { width: W });

    const room = need => { if (doc.y + need > A4.height - M.bottom) doc.addPage(); };
    letters.forEach((c, n) => {
      doc.font('Times-Bold').fontSize(12);
      const head = `${n + 1}.  ${c.heading || 'Untitled letter'}`;
      room(doc.heightOfString(head, { width: W }) + 60);
      doc.fillColor(BLUE).text(head, M.left, doc.y, { width: W });
      doc.fillColor('#000').moveDown(0.25);
      detailsOf(c).forEach(([label, value]) => {
        doc.font('Times-Bold').fontSize(10);
        const lw = 150;
        const h = Math.max(doc.heightOfString(label, { width: lw }), doc.font('Times-Roman').heightOfString(String(value), { width: W - lw }));
        room(h + 2);
        const y = doc.y;
        doc.font('Times-Bold').fillColor('#444').text(label, M.left, y, { width: lw });
        doc.font('Times-Roman').fillColor('#000').text(String(value), M.left + lw, y, { width: W - lw });
        doc.y = y + h + 2;
      });
      if (c.summary) {
        doc.moveDown(0.3);
        doc.font('Times-Roman').fontSize(11);
        String(c.summary).split(/\n+/).filter(s => s.trim()).forEach(para => {
          room(Math.min(doc.heightOfString(para, { width: W, align: 'justify' }), 120));
          doc.text(para, M.left, doc.y, { width: W, align: 'justify' });
          doc.moveDown(0.3);
        });
      }
      let placed = 0;
      if (opts.pages) {
        const { images, skipped } = pageImages(c, opts.filesDir);
        skipped.forEach(s => { room(14); doc.font('Times-Italic').fontSize(9.5).fillColor('#555').text(s, M.left, doc.y, { width: W }); });
        doc.fillColor('#000');
        images.forEach(img => {
          doc.addPage();
          doc.font('Times-Roman').fontSize(9).fillColor('#555')
            .text(`${n + 1}. ${c.heading || 'Letter'} — ${img.label}`, M.left, M.top, { width: W });
          doc.fillColor('#000');
          const top = doc.y + 6, maxH = A4.height - M.bottom - top;
          try { doc.image(img.buf, M.left, top, { fit: [W, maxH], align: 'center' }); } catch (e) {
            doc.font('Times-Italic').fontSize(10).text(`${img.label} could not be placed.`, M.left, top);
          }
          placed += 1;
        });
      }
      if (placed) {
        // The next letter starts on a fresh page after its own scans.
        if (n < letters.length - 1) { doc.addPage(); doc.y = M.top; }
      } else {
        doc.moveDown(0.4);
        room(16);
        doc.moveTo(M.left, doc.y).lineTo(M.left + W, doc.y).strokeColor('#C9CFDD').lineWidth(0.6).stroke();
        doc.moveDown(0.8);
      }
    });

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing below the bottom margin would make pdfkit start a new page.
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Times-Roman').fontSize(8.5).fillColor('#666')
        .text(`${data.footer || 'AOTC Track'} · page ${i + 1} of ${range.count}`, M.left, A4.height - M.bottom + 18, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

// --------------------------------------------------------------- Word -------
const FONT = 'Times New Roman';
const run = (text, o = {}) => new TextRun({ text: String(text == null ? '' : text), font: FONT, size: o.size || 22, bold: !!o.bold, italics: !!o.italics, color: o.color });
const para = (children, o = {}) => new Paragraph({
  alignment: o.center ? AlignmentType.CENTER : (o.justify ? AlignmentType.BOTH : AlignmentType.LEFT),
  spacing: { before: o.before || 0, after: o.after != null ? o.after : 60 },
  keepNext: !!o.keepNext,
  border: o.rule ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C9CFDD', space: 4 } } : undefined,
  children: Array.isArray(children) ? children : [run(children, o)],
});

function buildCorrespondenceDocx(data, opts = {}) {
  const kids = [];
  kids.push(para('PRESBYTERIAN CHURCH OF GHANA', { bold: true, center: true, size: 26, after: 40 }));
  try {
    if (fs.existsSync(CREST)) {
      const buf = fs.readFileSync(CREST);
      const s = imageSize(buf);
      if (s) kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new ImageRun({ type: s.type, data: buf, transformation: { width: 56, height: Math.round(56 * s.height / s.width) } })] }));
    }
  } catch (e) {}
  kids.push(para('ADABRAKA OFFICIAL TOWN CONGREGATION', { bold: true, center: true, size: 22, after: 160 }));
  kids.push(para(String(data.title || 'Correspondence').toUpperCase(), { bold: true, center: true, size: 26, after: 40 }));
  if (data.subtitle) kids.push(para(data.subtitle, { center: true, size: 20, color: '444444', after: 240 }));

  const letters = data.letters || [];
  if (!letters.length) kids.push(para('No letters to show.', { italics: true }));
  letters.forEach((c, n) => {
    kids.push(para(`${n + 1}.  ${c.heading || 'Untitled letter'}`, { bold: true, size: 24, color: '1D3F94', before: 200, after: 80, keepNext: true }));
    detailsOf(c).forEach(([label, value]) => {
      kids.push(para([run(`${label}: `, { bold: true, size: 20, color: '444444' }), run(value, { size: 20 })], { after: 20, keepNext: true }));
    });
    String(c.summary || '').split(/\n+/).filter(s => s.trim()).forEach((s, i) => {
      kids.push(para(s, { justify: true, before: i ? 0 : 100, after: 100 }));
    });
    if (opts.pages) {
      const { images, skipped } = pageImages(c, opts.filesDir);
      skipped.forEach(s => kids.push(para(s, { italics: true, size: 18, color: '555555' })));
      images.forEach(img => {
        // Fit to a 6.3in × 8.6in box (the A4 text area), in pixels at 96 dpi.
        const k = Math.min(605 / img.width, 825 / img.height, 1);
        kids.push(new Paragraph({ children: [new PageBreak()] }));
        kids.push(para(`${n + 1}. ${c.heading || 'Letter'} — ${img.label}`, { size: 18, color: '555555' }));
        kids.push(new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new ImageRun({ type: img.type, data: img.buf, transformation: { width: Math.round(img.width * k), height: Math.round(img.height * k) } })] }));
      });
    }
    kids.push(para('', { rule: true, after: 120 }));
  });
  if (data.footer) kids.push(para(data.footer, { size: 16, color: '777777', center: true, before: 200 }));

  const doc = new Document({
    creator: 'AOTC Track', title: data.title || 'Correspondence',
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1134, right: 1134 } } }, children: kids }],
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildCorrespondencePdf, buildCorrespondenceDocx, detailsOf, whereItWent, longDay, imageSize };
