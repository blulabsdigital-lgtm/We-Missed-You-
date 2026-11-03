// Transactional email via Resend's HTTP API. Without RESEND_API_KEY, emails are logged (DEV mode).
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || 'We Missed You <onboarding@resend.dev>';
const enabled = !!KEY;

async function send(to, subject, text) {
  if (!enabled) {
    console.log(`[DEV] email to ${to}: ${subject}\n${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) console.error('email failed', res.status, await res.text().catch(() => ''));
}

module.exports = { enabled, send };
