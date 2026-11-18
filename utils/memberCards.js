// Printable member ID card sheets (A4, 2 x 5 grid) with QR codes for
// named check-in. QR payload: AOTC:<memberId>:<token>.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const A4 = { width: 595.28, height: 841.89 };
const CREST = path.join(__dirname, '..', 'public', 'img', 'logo.png');

async function buildCardSheet({ members, entityName }) {
  const cardsPerRow = 2, rows = 5;
  const mx = 36, my = 36, gap = 12;
  const cw = (A4.width - mx * 2 - gap) / cardsPerRow;
  const ch = (A4.height - my * 2 - gap * (rows - 1)) / rows;

  const doc = new PDFDocument({ size: 'A4', margins: { top: my, bottom: my, left: mx, right: mx } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  for (let i = 0; i < members.length; i++) {
    const slot = i % (cardsPerRow * rows);
    if (i > 0 && slot === 0) doc.addPage();
    const col = slot % cardsPerRow, row = Math.floor(slot / cardsPerRow);
    const x = mx + col * (cw + gap), y = my + row * (ch + gap);
    const m = members[i];

    doc.roundedRect(x, y, cw, ch, 8).lineWidth(1).stroke('#1D3F94');
    try { if (fs.existsSync(CREST)) doc.image(CREST, x + 10, y + 10, { fit: [34, 40] }); } catch (e) {}
    doc.font('Times-Bold').fontSize(8.5).fillColor('#1D3F94')
      .text('PCG — Adabraka Official Town', x + 50, y + 12, { width: cw - 130 });
    doc.font('Times-Roman').fontSize(7.5).fillColor('#333')
      .text(entityName || m.entityName || '', x + 50, y + 24, { width: cw - 130 });
    doc.font('Times-Bold').fontSize(11).fillColor('#000')
      .text(m.name, x + 12, y + 52, { width: cw - 100 });
    doc.font('Times-Roman').fontSize(8.5).fillColor('#333')
      .text(m.position || 'Member', x + 12, y + 68, { width: cw - 100 });
    doc.font('Times-Roman').fontSize(7).fillColor('#777')
      .text(`Member No. ${m.memberNo || m.id}`, x + 12, y + ch - 16);

    const qrData = await QRCode.toDataURL(`AOTC:${m.id}:${m.qrToken}`, { margin: 0, width: 160 });
    const png = Buffer.from(qrData.split(',')[1], 'base64');
    doc.image(png, x + cw - 78, y + (ch - 68) / 2, { fit: [68, 68] });
  }
  doc.end();
  return done;
}

module.exports = { buildCardSheet };
