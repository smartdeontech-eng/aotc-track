// SMS notifications via mNotify (https://mnotify.com), a Ghana bulk-SMS
// gateway. Uses the built-in fetch (Node 18+) — no extra dependency needed.
// If SMS_API_KEY isn't set, this safely does nothing (like mailer.js does
// for SMTP), so the app never crashes or blocks on missing SMS config.
//
// Configure in .env:
//   SMS_API_KEY    your mNotify API key (Account > API Keys on mnotify.com)
//   SMS_SENDER_ID  your approved Sender ID, max 11 characters (must be
//                  registered/approved with mNotify before it will deliver)

const { logNotification } = require('./notifications');

const MNOTIFY_URL = 'https://api.mnotify.com/api/sms/quick';

function isConfigured() {
  return !!process.env.SMS_API_KEY;
}

// mNotify is a Ghana-network gateway: it expects local-format numbers
// (leading 0, no country code) and reliably delivers only to Ghanaian
// (+233) numbers. We only attempt to send when the customer's phone is
// on a +233 line; other numbers are skipped rather than silently failing.
function toLocalGhanaFormat(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('233')) return '0' + digits.slice(3);
  if (digits.startsWith('0')) return digits;
  // Customer/technician phone numbers are stored as the bare 9-digit local
  // number with no leading 0 and no country code (see formatPhoneDisplay()
  // in app.js, which reconstructs "+233 (0)..." for display only — the
  // stored value itself has neither). That's a valid Ghana mobile number
  // missing only the trunk 0, e.g. "244273830" -> "0244273830".
  if (digits.length === 9) return '0' + digits;
  return null;
}

async function sendSms({ to, phoneCountry, message }) {
  if (!to) return { skipped: 'no-recipient' };
  if (!isConfigured()) {
    console.log(`[sms] SMS_API_KEY not configured — skipping SMS to ${to}`);
    return { skipped: 'not-configured' };
  }
  if (phoneCountry && phoneCountry !== '+233') {
    console.log(`[sms] ${to} is not a +233 number — mNotify can't reliably deliver, skipping.`);
    return { skipped: 'unsupported-country' };
  }
  const recipient = toLocalGhanaFormat(to);
  if (!recipient) return { skipped: 'invalid-number' };

  const sender = (process.env.SMS_SENDER_ID || 'PCG-AOTC').slice(0, 11);
  const url = `${MNOTIFY_URL}?key=${encodeURIComponent(process.env.SMS_API_KEY)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: [recipient],
        sender,
        message,
        is_schedule: false,
        schedule_date: '',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[sms] failed to send to ${recipient}: HTTP ${res.status}`, data);
      logNotification({
        level: 'error', source: 'sms',
        message: `SMS to ${recipient} failed: HTTP ${res.status}${data && data.message ? ' — ' + data.message : ''}`,
        meta: { recipient, httpStatus: res.status, response: data },
      });
      return { error: `HTTP ${res.status}` };
    }
    // mNotify can return HTTP 200 even when the message did NOT actually go
    // out — e.g. an account-level issue (a suspended/flagged sending
    // account) is reported via `code`/`message` in the body, not the HTTP
    // status. Treat anything other than their documented success code
    // ('2000') as a real delivery failure worth surfacing, since it can mean
    // something as serious as the whole SMS account being blocked.
    if (data && data.code && data.code !== '2000') {
      console.error(`[sms] mNotify reported a failure for ${recipient}:`, data.message || data);
      logNotification({
        level: 'error', source: 'sms',
        message: data.message || `mNotify reported a failure (code ${data.code}) sending to ${recipient}.`,
        meta: { recipient, response: data },
      });
      return { error: data.message || `mNotify code ${data.code}` };
    }
    console.log(`[sms] sent to ${recipient}`);
    return data;
  } catch (err) {
    // Never let an SMS failure break the business action (e.g. marking an invoice paid).
    console.error(`[sms] failed to send to ${recipient}:`, err.message);
    logNotification({
      level: 'error', source: 'sms',
      message: `SMS to ${recipient} failed: ${err.message}`,
      meta: { recipient },
    });
    return { error: err.message };
  }
}

function money(n, symbol) {
  return (symbol || '₵') + Number(n || 0).toFixed(2);
}

// Texted to the client when a service-request job generates its invoice —
// many clients are SMS-first, and email only reaches those with an address
// on file.
async function sendServiceInvoiceSms(invoice) {
  if (!invoice.customerPhone) return { skipped: 'no-customer-phone' };
  const { getSettings } = require('./settings');
  const currencySymbol = getSettings().currencySymbol;
  const message = `AOTC Track: Invoice ${invoice.invoiceNumber} for ${money(invoice.total, currencySymbol)} has been prepared for your service request. Thank you!`;
  return sendSms({ to: invoice.customerPhone, phoneCountry: invoice.customerPhoneCountry, message });
}

// `payment` is optional context about the specific payment just recorded:
// { amount, installmentSeq, totalInstallments, balance, fullyPaid }. Omitted
// (or fullyPaid true) reads as a plain full-payment confirmation.

module.exports = { isConfigured, sendSms, toLocalGhanaFormat };
