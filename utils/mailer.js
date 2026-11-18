// Email notifications. Uses nodemailer if SMTP is configured via environment
// variables; otherwise it safely does nothing (logs and returns) so the app
// never crashes or blocks on a missing/broken mail server.
//
// Configure in .env:
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE ("true"/"false"), SMTP_USER, SMTP_PASS
//   MAIL_FROM        e.g. "AOTC Track <[email protected]>"
//   NOTIFY_EMAIL     where low-stock alerts are sent (the business owner)
//   APP_URL          base URL of the app, used in links (optional)

const nodemailer = require('nodemailer');
const { invoicePdfBuffer } = require('./pdf');
const { getSettings } = require('./settings');
const { logNotification } = require('./notifications');

let injectedTransport = null; // for tests
let cachedTransport = null;

// Allow tests to inject a fake transport (an object with sendMail()).
function setTransport(t) {
  injectedTransport = t;
  cachedTransport = null;
}

function getTransport() {
  if (injectedTransport) return injectedTransport;
  if (cachedTransport) return cachedTransport;
  if (!process.env.SMTP_HOST) return null; // not configured
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return cachedTransport;
}

function money(n) {
  return (getSettings().currencySymbol || '\u20B5') + Number(n || 0).toFixed(2);
}

async function sendMail({ to, subject, html, attachments }) {
  if (!to) return { skipped: 'no-recipient' };
  const transport = getTransport();
  if (!transport) {
    console.log(`[mail] SMTP not configured — skipping "${subject}" to ${to}`);
    return { skipped: 'not-configured' };
  }
  const from = process.env.MAIL_FROM || 'PCG Adabraka Official Town Congregation <no-reply@localhost>';
  try {
    const info = await transport.sendMail({ from, to, subject, html, attachments });
    console.log(`[mail] sent "${subject}" to ${to}`);
    return info;
  } catch (err) {
    // Never let email failure break the business action.
    console.error(`[mail] failed to send "${subject}" to ${to}:`, err.message);
    logNotification({
      level: 'error', source: 'email',
      message: `Email "${subject}" to ${to} failed: ${err.message}`,
      meta: { to, subject },
    });
    return { error: err.message };
  }
}

// ---- Notification templates ----

// Invoice issued: goes to the client first (if they have an email on file),
// then always to the business inbox (NOTIFY_EMAIL, falling back to the
// company email in Settings) so there's an internal copy of every invoice.
async function sendInvoiceEmail(invoice) {
  const rows = invoice.items.map(i =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${i.name}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${i.quantity}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${money(i.lineTotal)}</td></tr>`
  ).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a">
      <h2 style="color:#1F6F5C">Invoice ${invoice.invoiceNumber}</h2>
      <p>Dear ${invoice.customerName},</p>
      <p>Please find your invoice from PCG Adabraka Official Town Congregation attached. A summary is below.</p>
      <table style="border-collapse:collapse;width:100%;max-width:480px">
        <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid #1F6F5C">Item</th>
            <th align="right" style="padding:6px 10px;border-bottom:2px solid #1F6F5C">Qty</th>
            <th align="right" style="padding:6px 10px;border-bottom:2px solid #1F6F5C">Total</th></tr>
        ${rows}
        <tr><td colspan="2" style="padding:8px 10px;text-align:right;font-weight:bold">Total</td>
            <td style="padding:8px 10px;text-align:right;font-weight:bold">${money(invoice.total)}</td></tr>
      </table>
      ${invoice.dueDate ? `<p>Due date: <strong>${invoice.dueDate}</strong></p>` : ''}
      <p style="color:#666;font-size:13px">Thank you for your business.</p>
    </div>`;
  let attachments = [];
  try {
    const pdf = await invoicePdfBuffer(invoice);
    attachments = [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdf }];
  } catch (e) {
    console.error('[mail] could not attach invoice PDF:', e.message);
  }
  const results = {};

  // 1) Client copy first
  if (invoice.customerEmail) {
    results.client = await sendMail({
      to: invoice.customerEmail,
      subject: `Invoice ${invoice.invoiceNumber} from PCG Adabraka Official Town Congregation`,
      html,
      attachments,
    });
  } else {
    results.client = { skipped: 'no-customer-email' };
  }

  // 2) Then the business inbox copy
  const companyTo = process.env.NOTIFY_EMAIL || getSettings().email;
  if (companyTo) {
    results.company = await sendMail({
      to: companyTo,
      subject: `Invoice issued: ${invoice.invoiceNumber} — ${invoice.customerName}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#1a1a1a">
          <h2 style="color:#0B4C86">Invoice issued</h2>
          <p><strong>${invoice.invoiceNumber}</strong> for <strong>${invoice.customerName}</strong>
             — total ${money(invoice.total)}${invoice.dueDate ? `, due ${invoice.dueDate}` : ''}.
             Created by ${invoice.createdBy || '—'}.</p>
          <table style="border-collapse:collapse;width:100%;max-width:480px">
            <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid #0B4C86">Item</th>
                <th align="right" style="padding:6px 10px;border-bottom:2px solid #0B4C86">Qty</th>
                <th align="right" style="padding:6px 10px;border-bottom:2px solid #0B4C86">Total</th></tr>
            ${rows}
            <tr><td colspan="2" style="padding:8px 10px;text-align:right;font-weight:bold">Total</td>
                <td style="padding:8px 10px;text-align:right;font-weight:bold">${money(invoice.total)}</td></tr>
          </table>
          ${results.client.skipped ? '<p style="color:#B3261E;font-size:13px">Note: client copy was NOT sent (no customer email on file).</p>' : ''}
        </div>`,
      attachments,
    });
  }
  return results;
}

// `payment` is optional context about the specific payment just recorded:
// { amount, method, installmentSeq, totalInstallments, balance, fullyPaid }.
// When omitted (or fullyPaid is true), this reads as a plain full-payment
// receipt email, same as before installment plans existed.
// Client copy goes first (if they have an email on file), then an internal
// copy always goes to the business inbox (NOTIFY_EMAIL / Settings email).
async function sendPaymentEmail(invoice, payment) {
  const isInstallment = payment && payment.installmentSeq != null && !payment.fullyPaid;
  const amount = payment ? payment.amount : invoice.total;
  const method = (payment && payment.method) || invoice.paymentMethod;

  const html = isInstallment
    ? `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a">
      <h2 style="color:#1F6F5C">Payment received</h2>
      <p>Dear ${invoice.customerName},</p>
      <p>We've received your installment payment of <strong>${money(amount)}</strong>
         (payment ${payment.installmentSeq} of ${payment.totalInstallments})
         for invoice <strong>${invoice.invoiceNumber}</strong>${method ? ` via ${method}` : ''}.</p>
      <p>Remaining balance on this payment plan: <strong>${money(payment.balance)}</strong>.</p>
      <p style="color:#666;font-size:13px">Thank you!</p>
    </div>`
    : `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a">
      <h2 style="color:#1F6F5C">Payment received</h2>
      <p>Dear ${invoice.customerName},</p>
      <p>We've received your payment of <strong>${money(amount)}</strong>
         for invoice <strong>${invoice.invoiceNumber}</strong>${method ? ` via ${method}` : ''}.</p>
      <p>This invoice is now fully paid. Your receipt is attached. Thank you!</p>
    </div>`;
  let attachments = [];
  if (!isInstallment) {
    try {
      const pdf = await invoicePdfBuffer(invoice);
      attachments = [{ filename: `${invoice.invoiceNumber}-receipt.pdf`, content: pdf }];
    } catch (e) {
      console.error('[mail] could not attach receipt PDF:', e.message);
    }
  }
  const results = {};

  // 1) Client copy first
  if (invoice.customerEmail) {
    results.client = await sendMail({
      to: invoice.customerEmail,
      subject: isInstallment ? `Payment received — invoice ${invoice.invoiceNumber}` : `Receipt for invoice ${invoice.invoiceNumber}`,
      html,
      attachments,
    });
  } else {
    results.client = { skipped: 'no-customer-email' };
  }

  // 2) Then the business inbox copy
  const companyTo = process.env.NOTIFY_EMAIL || getSettings().email;
  if (companyTo) {
    results.company = await sendMail({
      to: companyTo,
      subject: isInstallment
        ? `Installment received: ${invoice.invoiceNumber} — ${invoice.customerName} (${payment.installmentSeq}/${payment.totalInstallments})`
        : `Invoice paid: ${invoice.invoiceNumber} — ${invoice.customerName}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#1a1a1a">
          <h2 style="color:#0B4C86">${isInstallment ? 'Installment payment received' : 'Invoice fully paid'}</h2>
          <p><strong>${money(amount)}</strong> received${method ? ` via ${method}` : ''} from
             <strong>${invoice.customerName}</strong> on invoice <strong>${invoice.invoiceNumber}</strong>${
             isInstallment
               ? ` (payment ${payment.installmentSeq} of ${payment.totalInstallments}, remaining balance ${money(payment.balance)})`
               : ' — receipt attached'}.</p>
          ${results.client.skipped ? '<p style="color:#B3261E;font-size:13px">Note: client copy was NOT sent (no customer email on file).</p>' : ''}
        </div>`,
      attachments,
    });
  }
  return results;
}

// ---- Payment plan reminders ----
async function sendInstallmentReminderEmail(invoice, installment, kind) {
  if (!invoice.customerEmail) return { skipped: 'no-customer-email' };
  const subjectByKind = {
    before: `Upcoming payment due — invoice ${invoice.invoiceNumber}`,
    dueDay: `Payment due today — invoice ${invoice.invoiceNumber}`,
    overdue: `Payment overdue — invoice ${invoice.invoiceNumber}`,
  };
  const introByKind = {
    before: `This is a friendly reminder that a payment on your installment plan is coming up.`,
    dueDay: `This is a reminder that a payment on your installment plan is due today.`,
    overdue: `Our records show a payment on your installment plan is now overdue.`,
  };
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a">
      <h2 style="color:${kind === 'overdue' ? '#B3261E' : '#1F6F5C'}">${subjectByKind[kind]}</h2>
      <p>Dear ${invoice.customerName},</p>
      <p>${introByKind[kind]}</p>
      <p>Invoice <strong>${invoice.invoiceNumber}</strong> — installment ${installment.seq} of <strong>${money(installment.amount)}</strong>,
         due <strong>${installment.dueDate}</strong>.</p>
      <p style="color:#666;font-size:13px">Please make payment at your earliest convenience. Thank you!</p>
    </div>`;
  return sendMail({ to: invoice.customerEmail, subject: subjectByKind[kind], html });
}

// Job completion notice: goes to the client (if they have an email on file)
// and always to the business inbox (NOTIFY_EMAIL, falling back to the
// company email in Settings) so there's an internal record of every close.
const JOB_TYPE_LABELS_MAIL = {
  installation: 'Installation', maintenance: 'Maintenance',
  'tech-support': 'Tech support', repair: 'Repair', other: 'Service',
};

async function sendJobClosedEmail(job, customerEmail, { notifyCompany = true } = {}) {
  const typeLabel = JOB_TYPE_LABELS_MAIL[job.jobType] || 'Service';
  const detailRows = [
    ['Job number', job.jobNumber],
    ['Type', typeLabel],
    ['Invoice', job.invoiceNumber],
    ['Scheduled', `${job.scheduledDate || ''} ${job.scheduledTime || ''}`.trim()],
    ['Technician', job.technicianName || '—'],
    ['Location', job.location || '—'],
    ['Closed by', job.closedBy],
    ['Work description', job.description || '—'],
  ];
  if (job.closeNotes) detailRows.push(['Closing notes', job.closeNotes]);
  const table = detailRows.map(([k, v]) =>
    `<tr><td style="padding:5px 10px;color:#666;white-space:nowrap">${k}</td>
         <td style="padding:5px 10px;border-bottom:1px solid #eee">${v}</td></tr>`).join('');

  // Review link (only present when a token was issued on close — i.e. the
  // job is finished with no pending return visit). APP_URL is the real
  // domain in production.
  const reviewLink = job.reviewToken
    ? `${(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '')}/review.html?t=${job.reviewToken}`
    : null;
  const reviewBlock = reviewLink ? `
      <p style="margin:18px 0 8px">How did we do? We'd love your feedback — it only takes a moment.</p>
      <p><a href="${reviewLink}" style="display:inline-block;background:#1F6F5C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">★ Rate your experience</a></p>` : '';

  const clientHtml = `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a">
      <h2 style="color:#1F6F5C">Job completed</h2>
      <p>Dear ${job.customerName},</p>
      <p>Your ${typeLabel.toLowerCase()} job <strong>${job.jobNumber}</strong> has been completed and closed.</p>
      <table style="border-collapse:collapse">${table}</table>
      ${reviewBlock}
      <p style="color:#666;font-size:13px">Thank you for choosing PCG Adabraka Official Town Congregation.</p>
    </div>`;

  const results = {};
  if (customerEmail) {
    results.client = await sendMail({
      to: customerEmail,
      subject: `Job ${job.jobNumber} completed — AOTC Track`,
      html: clientHtml,
    });
  } else {
    results.client = { skipped: 'no-customer-email' };
  }

  // Skipped on a manual "resend to customer" (Reviews page) — the company
  // already got the one-time "job closed" notice the first time around, and
  // firing it again on every resend would be noise.
  const companyTo = notifyCompany && (process.env.NOTIFY_EMAIL || getSettings().email);
  if (companyTo) {
    results.company = await sendMail({
      to: companyTo,
      subject: `Job closed: ${job.jobNumber} — ${job.customerName}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#1a1a1a">
          <h2 style="color:#0B4C86">Job closed</h2>
          <p><strong>${job.jobNumber}</strong> (${typeLabel}) for <strong>${job.customerName}</strong> was closed by ${job.closedBy}.</p>
          <table style="border-collapse:collapse">${table}</table>
        </div>`,
    });
  }
  return results;
}

// Packing list for a scheduled job — emailed to the business inbox so
// whoever packs the technician's kit knows exactly what to bring and which
// items need a second look (per-product "packing notes", e.g. "Confirm
// batteries are in the box — often missing"). Sent once, when both the
// client and technician have confirmed the visit (see utils/jobCards.js).
async function sendPackingListEmail(job, invoice) {
  const companyTo = process.env.NOTIFY_EMAIL || getSettings().email;
  if (!companyTo) return { skipped: 'no-company-inbox' };

  const e = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const items = (invoice && invoice.items) || [];
  // Only goods need packing (services have nothing to carry).
  const goods = items.filter(i => !i.isService);
  const rows = goods.map(i => {
    const note = i.packingNotes ? `<div style="color:#B3261E;font-size:12px;margin-top:2px">⚠ ${e(i.packingNotes)}</div>` : '';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${e(i.name)}${note}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${e(i.quantity)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="2" style="padding:6px 10px;color:#666">No stocked goods on this invoice.</td></tr>`;

  const flagged = goods.filter(i => i.packingNotes);
  const checklist = flagged.length
    ? `<h3 style="color:#B3261E;margin:18px 0 6px">Things to look out for</h3>
       <ul style="margin:0;padding-left:18px">${flagged.map(i => `<li>${e(i.name)}: ${e(i.packingNotes)}</li>`).join('')}</ul>`
    : '';

  return sendMail({
    to: companyTo,
    subject: `Packing list — ${job.jobNumber} (${job.customerName}) scheduled ${job.scheduledDate || ''}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#1a1a1a">
        <h2 style="color:#0B4C86">Packing list — ${e(job.jobNumber)}</h2>
        <p><strong>${e(job.customerName)}</strong> · ${e(JOB_TYPE_LABELS_MAIL[job.jobType] || 'Service')}
           · Scheduled ${e(job.scheduledDate || '—')} ${e(job.scheduledTime || '')}
           · Technician ${e(job.technicianName || '—')}</p>
        <p style="color:#666;font-size:13px">Location: ${e(job.location || '—')} · Invoice ${e(job.invoiceNumber || '—')}</p>
        <table style="border-collapse:collapse;width:100%;max-width:520px">
          <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid #0B4C86">Item to pack</th>
              <th align="right" style="padding:6px 10px;border-bottom:2px solid #0B4C86">Qty</th></tr>
          ${rows}
        </table>
        ${checklist}
      </div>`,
  });
}

async function sendPasswordResetEmail(user, resetLink) {
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a">
      <h2 style="color:#0B4C86">Reset your password</h2>
      <p>Hi ${user.name},</p>
      <p>We received a request to reset the password for your AOTC Track staff account (${user.email}).</p>
      <p><a href="${resetLink}" style="background:#0B4C86;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Reset password</a></p>
      <p style="color:#666;font-size:13px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password will not change.</p>
    </div>`;
  return sendMail({ to: user.email, subject: 'Reset your AOTC Track password', html });
}

async function sendForgotEmailRequest({ user, requestedName, admins }) {
  const recipients = (admins || []).map(a => a.email).filter(Boolean);
  const to = recipients.join(',') || process.env.NOTIFY_EMAIL;
  if (!to) return { skipped: 'no-admin-email' };
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a">
      <h2 style="color:#0B4C86">Login email recovery request</h2>
      <p>Someone using the phone number on file for <strong>${user.name}</strong> asked to recover their login email
         ${requestedName ? `(they identified themselves as "${requestedName}")` : ''}.</p>
      <p>Their account email is: <strong>${user.email}</strong></p>
      <p style="color:#666;font-size:13px">Please verify their identity before sharing this, then help them sign in.</p>
    </div>`;
  return sendMail({ to, subject: 'Staff login recovery request', html });
}

async function sendLowStockEmail(products) {
  const to = process.env.NOTIFY_EMAIL;
  if (!to) return { skipped: 'no-notify-email' };
  if (!products || !products.length) return { skipped: 'no-products' };
  const rows = products.map(p =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${p.name}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee">${p.sku || '—'}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#B3261E">${p.quantity}</td>
         <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${p.reorderLevel}</td></tr>`
  ).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a">
      <h2 style="color:#B3261E">Low stock alert</h2>
      <p>The following item${products.length > 1 ? 's have' : ' has'} reached or dropped below the reorder level:</p>
      <table style="border-collapse:collapse;width:100%;max-width:520px">
        <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid #B3261E">Item</th>
            <th align="left" style="padding:6px 10px;border-bottom:2px solid #B3261E">SKU</th>
            <th align="right" style="padding:6px 10px;border-bottom:2px solid #B3261E">In stock</th>
            <th align="right" style="padding:6px 10px;border-bottom:2px solid #B3261E">Reorder at</th></tr>
        ${rows}
      </table>
      <p style="color:#666;font-size:13px">Consider restocking soon.</p>
    </div>`;
  return sendMail({ to, subject: `Low stock alert — ${products.length} item(s) need attention`, html });
}

module.exports = {
  setTransport, getTransport, sendMail, sendInvoiceEmail, sendPaymentEmail, sendLowStockEmail,
  sendPasswordResetEmail, sendForgotEmailRequest, sendJobClosedEmail, sendInstallmentReminderEmail,
  sendPackingListEmail,
};
