const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { getSettings } = require('./settings');
const { toLocalDate } = require('./dates');

const INK = '#1A1A1A';
const MUTED = '#4A4A4A';
const RULE = '#E0E0E0';
const DARK_RULE = '#111111';

function money(n, symbol = '₵') {
  const formatted = Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${symbol}${formatted}`;
}

function formatDate(d) {
  return toLocalDate(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Phones are stored as the bare local number with no leading 0 (e.g.
// "277600016") plus a separate country code. For display, +233 numbers get
// their trunk 0 back ("0277600016"); other countries show "+CC number".
function formatPhone(phone, country) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const dial = country || '+233';
  if (dial === '+233') return digits.startsWith('0') ? digits : '0' + digits;
  return `${dial} ${digits.replace(/^0+/, '')}`;
}

const FONT_REGULAR = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');

const LEFT = 50;
const RIGHT = 545;
const CONTENT_W = RIGHT - LEFT;

function generateInvoicePdf(invoice) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const company = getSettings();
  const logoPath = path.join(__dirname, '..', 'public', company.logoPath.replace(/^\//, ''));

  // Register a Unicode font so the cedi sign (₵) renders correctly.
  // Helvetica (PDF's built-in font) does not include this glyph.
  doc.registerFont('Body', FONT_REGULAR);
  doc.registerFont('Body-Bold', FONT_BOLD);
  doc.font('Body');

  const isReceipt = invoice.status === 'paid';
  const docLabel = isReceipt ? 'RECEIPT' : 'INVOICE';

  // --- Header: logo top-left (constrained to a box so any aspect ratio fits),
  //     company block top-right. The two never overlap.
  const logoBoxW = 160, logoBoxH = 70;
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, LEFT, 45, { fit: [logoBoxW, logoBoxH] });
  }

  const companyX = 320, companyW = RIGHT - companyX;
  doc.fillColor(INK).fontSize(10.5).font('Body-Bold').text(company.companyName, companyX, 45, { width: companyW });
  doc.font('Body').fontSize(9.5).fillColor(MUTED);
  let cy = 61;
  [...company.addressLines, ...company.phones, `Email: ${company.email}`].forEach(line => {
    doc.text(line, companyX, cy, { width: companyW });
    cy += 13.5;
  });

  const headerBottom = Math.max(45 + logoBoxH, cy);

  // --- Document title: its own row, below the header block ---
  const titleY = headerBottom + 32;
  doc.fillColor(INK).fontSize(20).font('Body-Bold').text(docLabel, LEFT, titleY);

  // --- Bill To (left) and meta block (right) on the same band ---
  const bandTop = titleY + 42;

  doc.font('Body').fontSize(10).fillColor(INK).text(invoice.customerName || 'N/A', LEFT, bandTop, { width: 250 });
  let custY = bandTop + 15;
  doc.fontSize(9).fillColor(MUTED);
  if (invoice.customerPhone) { doc.text(formatPhone(invoice.customerPhone, invoice.customerPhoneCountry), LEFT, custY, { width: 250 }); custY += 12; }
  if (invoice.customerEmail) { doc.text(invoice.customerEmail, LEFT, custY, { width: 250 }); custY += 12; }

  const metaLabelX = 340, metaValueX = 455;
  const metaRows = [
    ['Invoice Number:', invoice.invoiceNumber],
    ['Invoice Date:', formatDate(invoice.createdAt)],
  ];
  if (invoice.orderNumber) metaRows.push(['Order Number:', invoice.orderNumber]);
  if (invoice.orderDate) metaRows.push(['Order Date:', formatDate(invoice.orderDate)]);
  if (invoice.receiptNumber) metaRows.push(['Receipt Number:', invoice.receiptNumber]);
  if (invoice.paidAt) metaRows.push(['Receipt Date:', formatDate(invoice.paidAt)]);

  let my = bandTop;
  doc.font('Body').fontSize(9.5);
  metaRows.forEach(([label, value]) => {
    doc.fillColor(INK).text(label, metaLabelX, my, { width: metaValueX - metaLabelX - 5 });
    doc.text(String(value), metaValueX, my, { width: RIGHT - metaValueX });
    my += 16;
  });

  // --- Table (paginates: long item lists flow onto extra pages, with the
  //     black header bar redrawn at the top of each new page) ---
  const tableTop = Math.max(my, custY) + 28;
  const colProduct = 60, colProductW = 285;
  const colQty = 360, colQtyW = 70;
  const colPrice = 455, colPriceW = 90;
  const headerH = 26;

  // Keep content above this line; below it is reserved for the footer terms
  // (drawn on the last page) and the page number.
  const CONTENT_LIMIT = doc.page.height - 150;
  doc.page.margins.bottom = 0; // we manage page breaks ourselves throughout

  function drawTableHeader(y) {
    doc.fillColor('#000000').rect(LEFT, y, CONTENT_W, headerH).fill();
    doc.fillColor('#FFFFFF').fontSize(9.5).font('Body-Bold');
    doc.text('Product', colProduct, y + 8, { width: colProductW });
    doc.text('Quantity', colQty, y + 8, { width: colQtyW });
    doc.text('Price', colPrice, y + 8, { width: colPriceW });
    return y + headerH;
  }

  // Starts a fresh page and returns the new cursor Y. Rows continue right
  // under a repeated table header; totals/notes just continue near the top.
  function newPage(withTableHeader) {
    doc.addPage();
    doc.page.margins.bottom = 0;
    return withTableHeader ? drawTableHeader(50) : 50;
  }

  let rowY = drawTableHeader(tableTop);
  const padTop = 9;

  invoice.items.forEach((item) => {
    doc.font('Body').fontSize(9.5);
    const nameHeight = doc.heightOfString(item.name, { width: colProductW });
    const hasDiscount = Number(item.discount) > 0;
    // Extra vertical space per sub-line (material and/or discount note).
    const subLines = (item.material ? 1 : 0) + (hasDiscount ? 1 : 0);
    const rowHeight = padTop + nameHeight + (subLines ? subLines * 12 + 10 : 10);

    if (rowY + rowHeight > CONTENT_LIMIT) rowY = newPage(true);

    doc.font('Body').fontSize(9.5);
    doc.fillColor(INK).text(item.name, colProduct, rowY + padTop, { width: colProductW });
    doc.text(String(item.quantity), colQty, rowY + padTop, { width: colQtyW });
    doc.text(money(item.lineTotal, company.currencySymbol), colPrice, rowY + padTop, { width: colPriceW });

    let subY = rowY + padTop + nameHeight + 6;
    if (item.material) {
      doc.font('Body-Bold').fontSize(8.5).fillColor(MUTED)
        .text('Material: ', colProduct, subY, { continued: true, width: colProductW })
        .font('Body').text(item.material);
      subY += 12;
    }
    if (hasDiscount) {
      // Show the discount so the ₵0 (or reduced) line is self-explanatory,
      // e.g. a free replacement for a defective unit.
      const gross = money(Number(item.unitPrice) * Number(item.quantity), company.currencySymbol);
      const off = money(Number(item.discount), company.currencySymbol);
      const label = `Discount: ${gross} less ${off}${item.discountReason ? ' — ' + item.discountReason : ''}`;
      doc.font('Body').fontSize(8.5).fillColor(MUTED).text(label, colProduct, subY, { width: colProductW });
    }

    rowY += rowHeight;
    doc.moveTo(LEFT, rowY).lineTo(RIGHT, rowY).strokeColor(RULE).lineWidth(0.5).stroke();
  });

  // --- Totals (right side, black rules like the sample) ---
  // Keep the whole totals block together on one page (~90pt incl. paid/void line).
  if (rowY + 100 > CONTENT_LIMIT) rowY = newPage(false);
  rowY += 12;
  doc.font('Body-Bold').fontSize(9.5).fillColor(INK).text('Subtotal', colQty, rowY, { width: colQtyW });
  doc.font('Body').text(money(invoice.subtotal, company.currencySymbol), colPrice, rowY, { width: colPriceW });
  rowY += 17;
  doc.moveTo(colQty, rowY).lineTo(RIGHT, rowY).strokeColor(DARK_RULE).lineWidth(0.75).stroke();
  rowY += 9;
  doc.font('Body-Bold').fillColor(INK).text('Total', colQty, rowY, { width: colQtyW });
  doc.text(money(invoice.total, company.currencySymbol), colPrice, rowY, { width: colPriceW });
  rowY += 17;
  doc.moveTo(colQty, rowY).lineTo(RIGHT, rowY).strokeColor(DARK_RULE).lineWidth(2).stroke();

  if (invoice.status === 'paid') {
    rowY += 14;
    doc.font('Body').fontSize(9).fillColor(MUTED)
      .text(`Paid via ${invoice.paymentMethod || 'Cash'} on ${formatDate(invoice.paidAt)}`, colQty, rowY, { width: RIGHT - colQty });
  } else if (invoice.status === 'void') {
    rowY += 14;
    doc.font('Body-Bold').fontSize(9).fillColor('#B3261E').text('VOID', colQty, rowY, { width: RIGHT - colQty });
  }

  if (invoice.notes) {
    rowY += 34;
    doc.font('Body').fontSize(9.5);
    const notesHeight = 14 + doc.heightOfString(invoice.notes, { width: CONTENT_W });
    if (rowY + notesHeight > CONTENT_LIMIT) rowY = newPage(false) + 10;
    doc.font('Body-Bold').fontSize(9.5).fillColor(INK).text('Notes', LEFT, rowY);
    doc.font('Body').fontSize(9.5).fillColor(MUTED).text(invoice.notes, LEFT, rowY + 14, { width: CONTENT_W });
  }

  // --- Footer terms (anchored to the bottom of the LAST page; editable from Settings → Invoice terms) ---
  const terms = (company.invoiceTerms && company.invoiceTerms.length) ? company.invoiceTerms : [];
  doc.font('Body').fontSize(9);
  const termGap = 9;
  const termsHeight = terms.reduce((h, line) => h + doc.heightOfString(line, { width: CONTENT_W, align: 'center' }) + termGap, 0);
  const pageBottom = doc.page.height - 40;
  const footerTop = pageBottom - termsHeight - 14;
  doc.moveTo(LEFT, footerTop).lineTo(RIGHT, footerTop).strokeColor(RULE).lineWidth(0.5).stroke();
  let ty = footerTop + 14;
  doc.fillColor(MUTED);
  terms.forEach((line) => {
    doc.text(line, LEFT, ty, { width: CONTENT_W, align: 'center', lineBreak: true });
    ty += doc.heightOfString(line, { width: CONTENT_W, align: 'center' }) + termGap;
  });

  // --- Per-page overlays: a diagonal "PAID" watermark on receipts, plus
  //     page numbers ("1 of 2") at the very bottom of every page ---
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // avoid auto page-break when writing near the edge

    // A large, faint, rotated "PAID" stamp — only on receipts (fully paid).
    // Low opacity so it reads as a watermark and never obscures the details.
    if (isReceipt) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Body-Bold').fontSize(130).fillColor('#1F6F5C').opacity(0.08);
      doc.text('PAID', 0, doc.page.height / 2 - 80, { width: doc.page.width, align: 'center', lineBreak: false });
      doc.restore(); // restores opacity + rotation for the page-number text below
    }

    doc.font('Body').fontSize(8).fillColor(MUTED)
      .text(`${i + 1} of ${range.count}`, LEFT, doc.page.height - 26, { width: CONTENT_W, align: 'center', lineBreak: false });
  }

  doc.end();
  return doc;
}

// --- Printable job card (A4) — hand to the technician or file it. ---
const JOB_TYPE_LABELS_PDF = {
  installation: 'Installation', maintenance: 'Maintenance',
  'tech-support': 'Tech support', repair: 'Repair', other: 'Other',
};

function generateJobCardPdf(job) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const company = getSettings();
  const logoPath = path.join(__dirname, '..', 'public', company.logoPath.replace(/^\//, ''));

  doc.registerFont('Body', FONT_REGULAR);
  doc.registerFont('Body-Bold', FONT_BOLD);
  doc.font('Body');

  // Header: same layout as invoices — logo left, company block right.
  const logoBoxW = 160, logoBoxH = 70;
  if (fs.existsSync(logoPath)) doc.image(logoPath, LEFT, 45, { fit: [logoBoxW, logoBoxH] });
  const companyX = 320, companyW = RIGHT - companyX;
  doc.fillColor(INK).fontSize(10.5).font('Body-Bold').text(company.companyName, companyX, 45, { width: companyW });
  doc.font('Body').fontSize(9.5).fillColor(MUTED);
  let cy = 61;
  [...company.addressLines, ...company.phones, `Email: ${company.email}`].forEach(line => {
    doc.text(line, companyX, cy, { width: companyW });
    cy += 13.5;
  });

  const titleY = Math.max(45 + logoBoxH, cy) + 32;
  doc.fillColor(INK).fontSize(20).font('Body-Bold').text('JOB CARD', LEFT, titleY);
  doc.fontSize(11).fillColor(MUTED).font('Body').text(job.jobNumber, LEFT, titleY + 26);
  const statusLabel = (job.displayStatus || 'open').toUpperCase();
  doc.font('Body-Bold').fontSize(11).fillColor(job.displayStatus === 'cancelled' ? '#B3261E' : INK)
    .text(statusLabel, 400, titleY + 8, { width: RIGHT - 400, align: 'right' });

  let y = titleY + 56;

  function section(title) {
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(DARK_RULE).lineWidth(0.75).stroke();
    y += 10;
    doc.font('Body-Bold').fontSize(10.5).fillColor(INK).text(title, LEFT, y);
    y += 18;
  }

  function kv(label, value) {
    doc.font('Body-Bold').fontSize(9.5).fillColor(MUTED).text(label, LEFT, y, { width: 130 });
    doc.font('Body').fillColor(INK).fontSize(9.5);
    const text = value || '—';
    const h = doc.heightOfString(text, { width: RIGHT - LEFT - 140 });
    doc.text(text, LEFT + 140, y, { width: RIGHT - LEFT - 140 });
    y += Math.max(14, h + 4);
  }

  section('Job details');
  kv('Type', JOB_TYPE_LABELS_PDF[job.jobType] || 'Installation');
  kv('Invoice', job.invoiceNumber);
  kv('Work description', job.description);
  kv('Created', `${formatDate(job.createdAt)} by ${job.createdBy}`);
  y += 8;

  section('Client');
  kv('Name', job.customerName);
  kv('Phone', formatPhone(job.customerPhone, job.customerPhoneCountry));
  kv('Location', job.location);
  y += 8;

  section('Schedule');
  kv('Date', job.scheduledDate ? formatDate(job.scheduledDate) : 'Not set');
  kv('Time', job.scheduledTime);
  kv('Client confirmed', job.clientConfirmed ? `Yes — ${formatDate(job.clientConfirmedAt)}` : 'Not yet');
  kv('Technician confirmed', job.techConfirmed ? `Yes — ${formatDate(job.techConfirmedAt)}` : 'Not yet');
  y += 8;

  section('Technician');
  kv('Name', job.technicianName || 'Not assigned');
  kv('Phone', job.technicianPhone);
  y += 8;

  if (job.status === 'closed') {
    section('Completion');
    kv('Closed', `${formatDate(job.closedAt)} by ${job.closedBy}`);
    kv('Closing notes', job.closeNotes);
    y += 8;
  }

  // Signature block near the bottom (fits on one page for normal content).
  const sigY = Math.max(y + 30, doc.page.height - 150);
  if (sigY < doc.page.height - 90) {
    const half = (RIGHT - LEFT - 40) / 2;
    doc.moveTo(LEFT, sigY).lineTo(LEFT + half, sigY).strokeColor(INK).lineWidth(0.75).stroke();
    doc.moveTo(RIGHT - half, sigY).lineTo(RIGHT, sigY).strokeColor(INK).lineWidth(0.75).stroke();
    doc.font('Body').fontSize(9).fillColor(MUTED);
    doc.text('Technician signature & date', LEFT, sigY + 6, { width: half });
    doc.text('Client signature & date', RIGHT - half, sigY + 6, { width: half });
  }

  doc.end();
  return doc;
}

// --- Procurement account statement (A4) — one account's RMB swaps and
//     shipments in a single hand-off document (useful for referrals). ---
function rmbMoney(n) {
  return '¥' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const SHIP_METHOD_PDF = { sea: 'By sea', air: 'By air' };
const STATUS_PDF = { requested: 'Requested', ordered: 'Ordered', shipped: 'Shipped', arrived: 'Arrived', cancelled: 'Cancelled' };

function generateAccountStatementPdf(data) {
  const { account, summary, swaps, shipments, transfers = [] } = data;
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const company = getSettings();
  const sym = company.currencySymbol || '₵';
  const logoPath = path.join(__dirname, '..', 'public', company.logoPath.replace(/^\//, ''));

  doc.registerFont('Body', FONT_REGULAR);
  doc.registerFont('Body-Bold', FONT_BOLD);
  doc.font('Body');

  // Header: logo left, company block right (same as invoices/job cards).
  const logoBoxW = 160, logoBoxH = 70;
  if (fs.existsSync(logoPath)) doc.image(logoPath, LEFT, 45, { fit: [logoBoxW, logoBoxH] });
  const companyX = 320, companyW = RIGHT - companyX;
  doc.fillColor(INK).fontSize(10.5).font('Body-Bold').text(company.companyName, companyX, 45, { width: companyW });
  doc.font('Body').fontSize(9.5).fillColor(MUTED);
  let cy = 61;
  [...company.addressLines, ...company.phones, `Email: ${company.email}`].forEach(line => {
    doc.text(line, companyX, cy, { width: companyW });
    cy += 13.5;
  });

  const titleY = Math.max(45 + logoBoxH, cy) + 32;
  doc.fillColor(INK).fontSize(20).font('Body-Bold').text('ACCOUNT STATEMENT', LEFT, titleY);
  doc.font('Body').fontSize(9.5).fillColor(MUTED)
    .text(`Generated ${formatDate(new Date())}`, 345, titleY + 6, { width: RIGHT - 345, align: 'right' });

  // Account identity (left) + type (right).
  const bandTop = titleY + 40;
  doc.font('Body-Bold').fontSize(12).fillColor(INK).text(account.name, LEFT, bandTop, { width: 280 });
  let ay = bandTop + 17;
  doc.font('Body').fontSize(9).fillColor(MUTED);
  if (account.phone) { doc.text(formatPhone(account.phone), LEFT, ay, { width: 280 }); ay += 12; }
  if (account.notes) { doc.text(account.notes, LEFT, ay, { width: 280 }); ay += 12; }
  doc.font('Body-Bold').fontSize(9.5).fillColor(INK)
    .text(account.isBusiness ? 'Business account' : 'External account', 345, bandTop, { width: RIGHT - 345, align: 'right' });

  let y = Math.max(ay, bandTop + 20) + 18;

  // Summary strip.
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(DARK_RULE).lineWidth(0.75).stroke();
  y += 12;
  const stats = [
    ['RMB balance', rmbMoney(summary.rmbBalance)],
    ['RMB bought', rmbMoney(summary.rmbIn)],
    [`Cedis paid in`, money(summary.ghsIn, sym)],
    ['Blended ' + sym + '/¥', Number(summary.blendedRate || 0).toFixed(4)],
  ];
  const bw = CONTENT_W / stats.length;
  stats.forEach((s, i) => {
    const bx = LEFT + i * bw;
    doc.font('Body').fontSize(8).fillColor(MUTED).text(s[0].toUpperCase(), bx, y, { width: bw - 6 });
    doc.font('Body-Bold').fontSize(13).fillColor(INK).text(s[1], bx, y + 12, { width: bw - 6 });
  });
  y += 46;

  const LIMIT = doc.page.height - 55;

  // Generic table renderer with a repeating black header bar across pages.
  function renderTable(title, cols, rows, emptyMsg) {
    doc.font('Body-Bold').fontSize(11).fillColor(INK);
    if (y + 40 > LIMIT) { doc.addPage(); y = 50; }
    doc.text(title, LEFT, y);
    y += 18;

    const headerH = 22, pad = 6;
    const drawHead = (yy) => {
      doc.fillColor('#000000').rect(LEFT, yy, CONTENT_W, headerH).fill();
      doc.fillColor('#FFFFFF').font('Body-Bold').fontSize(8.5);
      cols.forEach(c => doc.text(c.title, c.x, yy + 7, { width: c.w, align: c.align || 'left' }));
      return yy + headerH;
    };
    y = drawHead(y);

    if (!rows.length) {
      doc.font('Body').fontSize(9).fillColor(MUTED).text(emptyMsg, LEFT, y + 8, { width: CONTENT_W });
      y += 30;
      return;
    }
    rows.forEach(r => {
      doc.font('Body').fontSize(8.5);
      const h = Math.max(...cols.map(c => doc.heightOfString(String(r[c.key] ?? ''), { width: c.w, align: c.align || 'left' })));
      const rh = h + pad * 2;
      if (y + rh > LIMIT) { doc.addPage(); y = 50; y = drawHead(y); }
      cols.forEach(c => doc.fillColor(c.color || INK).text(String(r[c.key] ?? ''), c.x, y + pad, { width: c.w, align: c.align || 'left' }));
      y += rh;
      doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(RULE).lineWidth(0.5).stroke();
    });
    y += 22;
  }

  // ---- Swaps ----
  const swapCols = [
    { title: 'Date', key: 'date', x: 52, w: 66 },
    { title: 'Cedis in', key: 'ghs', x: 120, w: 82, align: 'right' },
    { title: 'RMB out', key: 'rmb', x: 206, w: 78, align: 'right' },
    { title: sym + '/¥', key: 'rate', x: 288, w: 52, align: 'right' },
    { title: 'Notes', key: 'notes', x: 348, w: RIGHT - 348 - 2 },
  ];
  const swapRows = swaps.map(c => ({
    date: formatDate(c.date),
    ghs: money(c.ghsAmount, sym),
    rmb: rmbMoney(c.rmbAmount),
    rate: Number(c.rate || 0).toFixed(4),
    notes: c.notes || '—',
  }));
  // Totals row appended in bold-ish muted (as an extra line under the table).
  renderTable('RMB Swaps', swapCols, swapRows, 'No RMB swaps recorded for this account.');
  if (swapRows.length) {
    doc.font('Body-Bold').fontSize(8.5).fillColor(INK);
    doc.text('Total', 52, y - 16, { width: 66 });
    doc.text(money(summary.ghsIn, sym), 120, y - 16, { width: 82, align: 'right' });
    doc.text(rmbMoney(summary.rmbIn), 206, y - 16, { width: 78, align: 'right' });
    y += 6;
  }

  // ---- Transfers (wallet-to-wallet moves touching this account, either
  // direction — direction is relative to `account`, not a fixed from/to) ----
  const transferCols = [
    { title: 'Date', key: 'date', x: 52, w: 54 },
    { title: 'Direction', key: 'direction', x: 110, w: 120 },
    { title: 'RMB', key: 'rmb', x: 234, w: 64, align: 'right' },
    { title: 'Cost basis ' + sym, key: 'ghs', x: 302, w: 66, align: 'right' },
    { title: sym + '/¥', key: 'rate', x: 372, w: 46, align: 'right' },
    { title: 'Notes', key: 'notes', x: 422, w: RIGHT - 422 - 2 },
  ];
  const transferRows = transfers.map(t => {
    const outgoing = t.fromAccountId === account.id;
    return {
      date: formatDate(t.date),
      direction: outgoing ? `-> ${t.toAccountName}` : `<- ${t.fromAccountName}`,
      rmb: (outgoing ? '-' : '+') + rmbMoney(t.rmbAmount),
      ghs: money(t.ghsValue, sym),
      rate: Number(t.rate || 0).toFixed(4),
      notes: t.notes || '—',
    };
  });
  renderTable('Transfers', transferCols, transferRows, 'No transfers between accounts recorded for this account.');

  // ---- Shipments ----
  const shipCols = [
    { title: 'PO №', key: 'po', x: 52, w: 54 },
    { title: 'Ordered', key: 'date', x: 108, w: 58 },
    { title: 'Supplier', key: 'supplier', x: 168, w: 92 },
    { title: 'Method', key: 'method', x: 262, w: 42 },
    { title: 'Status', key: 'status', x: 306, w: 54 },
    { title: 'Goods ¥', key: 'goods', x: 362, w: 62, align: 'right' },
    { title: 'Landed ' + sym, key: 'landed', x: 426, w: 62, align: 'right' },
    { title: 'Arrived', key: 'arrived', x: 490, w: RIGHT - 490 - 2 },
  ];
  const shipRows = shipments.map(o => ({
    po: o.orderNumber,
    date: o.dateOrdered ? formatDate(o.dateOrdered) : (o.dateRequested ? formatDate(o.dateRequested) : '—'),
    supplier: o.supplier || '—',
    method: SHIP_METHOD_PDF[o.shippingMethod] || '—',
    status: STATUS_PDF[o.status] || o.status,
    goods: rmbMoney(o.goodsTotalRmb),
    landed: money(o.landedTotalGhs, sym),
    arrived: o.dateArrived ? formatDate(o.dateArrived) : '—',
  }));
  renderTable('Shipments', shipCols, shipRows, 'No shipments recorded for this account.');

  // Page numbers.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.font('Body').fontSize(8).fillColor(MUTED)
      .text(`${i + 1} of ${range.count}`, LEFT, doc.page.height - 26, { width: CONTENT_W, align: 'center', lineBreak: false });
  }

  doc.end();
  return doc;
}

// Render an invoice PDF to a Buffer (for email attachments).
function invoicePdfBuffer(invoice) {
  return new Promise((resolve, reject) => {
    const doc = generateInvoicePdf(invoice);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

module.exports = { generateInvoicePdf, invoicePdfBuffer, generateJobCardPdf, generateAccountStatementPdf };
