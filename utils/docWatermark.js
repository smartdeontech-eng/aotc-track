// ShareHub — server-side PDF watermarking for VIEW-ONLY access.
// Stamps the viewer's name + date diagonally across every page BEFORE the
// PDF leaves the server, so screenshots and any saved copy carry the name.
// Users with download rights get the clean file — this is only applied when
// someone's effective level is exactly 'view'.
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

// buffer: original PDF bytes. label: e.g. "Viewed by Kofi Mensah · 29 Jul 2026".
// Returns stamped bytes, or null if the PDF can't be parsed (encrypted /
// malformed) — caller decides the fallback.
async function stampPdf(buffer, label) {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      // Scale the text to the page: aim for ~70% of the diagonal.
      const diag = Math.sqrt(width * width + height * height);
      let size = 28;
      const textWidth = () => font.widthOfTextAtSize(label, size);
      while (textWidth() > diag * 0.7 && size > 8) size -= 1;
      const angle = Math.atan2(height, width) * (180 / Math.PI);
      // Three stamps down the diagonal: center, upper, lower.
      const positions = [0.5, 0.22, 0.78];
      for (const t of positions) {
        page.drawText(label, {
          x: width * t - (textWidth() / 2) * Math.cos(angle * Math.PI / 180),
          y: height * (1 - t) - (textWidth() / 2) * Math.sin(angle * Math.PI / 180),
          size,
          font,
          color: rgb(0.55, 0.55, 0.6),
          opacity: 0.22,
          rotate: degrees(angle),
        });
      }
    }
    return Buffer.from(await doc.save());
  } catch (e) {
    console.error('[docWatermark] stamping failed (serving original):', e.message);
    return null;
  }
}

module.exports = { stampPdf };
