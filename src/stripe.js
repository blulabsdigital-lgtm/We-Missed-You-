// Thin Stripe client over fetch — no SDK needed.
// If STRIPE_SECRET_KEY is missing, runs in DEV mode: a button unlocks the account for testing.
const crypto = require('node:crypto');

const KEY = process.env.STRIPE_SECRET_KEY;
const PRICE = process.env.STRIPE_PRICE_ID; // recurring price, set in the Stripe dashboard
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const enabled = !!(KEY && PRICE);

async function api(path, params, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? new URLSearchParams(params) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Stripe ${res.status}`);
  return json;
}

function createCheckout(user, publicUrl) {
  return api('/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': PRICE,
    'line_items[0][quantity]': '1',
    client_reference_id: String(user.id),
    ...(user.stripe_customer ? { customer: user.stripe_customer } : { customer_email: user.email }),
    success_url: `${publicUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicUrl}/pay`,
    allow_promotion_codes: 'true',
  });
}

const getCheckout = (id) => api(`/checkout/sessions/${encodeURIComponent(id)}`, null, 'GET');

function createPortal(customer, publicUrl) {
  return api('/billing_portal/sessions', { customer, return_url: `${publicUrl}/dashboard` });
}

/** Verify Stripe-Signature header against the raw body. Returns parsed event or null. */
function verifyWebhook(rawBody, header) {
  if (!WEBHOOK_SECRET || !header) return null;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = parts.t;
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length) return null;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return null; // 5 min tolerance
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  return ok ? JSON.parse(rawBody) : null;
}

module.exports = { enabled, createCheckout, getCheckout, createPortal, verifyWebhook };
