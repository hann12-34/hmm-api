/**
 * Optional email/SMS notifications. Works without API keys (logs only).
 * Set RESEND_API_KEY + NOTIFY_FROM_EMAIL for email.
 * Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER for SMS.
 */

async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM_EMAIL;
  if (!key || !from || !to) {
    console.log(`[notify:email] ${to || '(no email)'} — ${subject}`);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[notify:email] failed:', err);
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e) {
    console.error('[notify:email]', e.message);
    return { ok: false, error: e.message };
  }
}

async function sendSMS(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from || !to) {
    console.log(`[notify:sms] ${to || '(no phone)'} — ${body}`);
    return { ok: false, skipped: true };
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[notify:sms] failed:', err);
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e) {
    console.error('[notify:sms]', e.message);
    return { ok: false, error: e.message };
  }
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

async function notifyCustomer(user, { subject, emailHtml, smsText }) {
  if (!user) return;
  await Promise.all([
    sendEmail(user.email, subject, emailHtml),
    user.phoneNumber ? sendSMS(user.phoneNumber, smsText) : Promise.resolve(),
  ]);
}

async function notifyAdmin(subject, html) {
  const adminEmail = process.env.NOTIFY_ADMIN_EMAIL;
  if (adminEmail) await sendEmail(adminEmail, subject, html);
  else console.log(`[notify:admin] ${subject}`);
}

async function notifyVisitRequested(customer, order) {
  const slots = (order.preferredDates || []).map(fmtDate).join(', ') || fmtDate(order.scheduledDate);
  await notifyCustomer(customer, {
    subject: 'HMM — Visit request received',
    emailHtml: `<p>Hi ${customer.name || ''},</p><p>We received your visit request for Unit ${order.unitNumber}.</p><p><strong>Preferred times:</strong> ${slots}</p><p>We'll confirm your appointment shortly.</p>`,
    smsText: `HMM: Visit request received for Unit ${order.unitNumber}. Preferred: ${slots}. We'll confirm soon.`,
  });
  await notifyAdmin(
    `New visit request — Unit ${order.unitNumber}`,
    `<p>Customer: ${customer.name} (${customer.email})</p><p>Unit ${order.unitNumber}</p><p>Preferred: ${slots}</p>`
  );
}

async function notifyVisitConfirmed(customer, order) {
  const when = fmtDate(order.scheduledDate);
  await notifyCustomer(customer, {
    subject: 'HMM — Visit confirmed',
    emailHtml: `<p>Hi ${customer.name || ''},</p><p>Your visit for <strong>Unit ${order.unitNumber}</strong> is confirmed.</p><p><strong>Date:</strong> ${when}</p><p>Services: ${(order.requestedServices || []).join(', ') || 'General maintenance'}</p>`,
    smsText: `HMM: Visit confirmed for Unit ${order.unitNumber} on ${when}.`,
  });
}

async function notifyRedoCreated(customer, originalOrder, redoOrder) {
  await notifyCustomer(customer, {
    subject: 'HMM — Redo visit requested',
    emailHtml: `<p>Hi ${customer.name || ''},</p><p>We received your redo request for Unit ${originalOrder.unitNumber}. Our team will schedule a follow-up visit soon.</p>`,
    smsText: `HMM: Redo visit request received for Unit ${originalOrder.unitNumber}. We'll schedule your follow-up soon.`,
  });
  await notifyAdmin(
    `Redo visit auto-created — Unit ${originalOrder.unitNumber}`,
    `<p>Customer: ${customer.name} (${customer.email})</p><p>Original job completed. New pending redo job created (ID ${redoOrder._id}).</p><p>Feedback: ${originalOrder.customerFeedback || '—'}</p>`
  );
}

module.exports = {
  notifyVisitRequested,
  notifyVisitConfirmed,
  notifyRedoCreated,
};
