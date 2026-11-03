// Thin Stripe client over fetch — no SDK needed.
// If STRIPE_SECRET_KEY is missing, runs in DEV mode: plans unlock for free for testing.
const crypto = require('node:crypto');
const { TRIAL_DAYS } = require('./plans');

const KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const enabled = !!KEY;

const price = (plan, interval) => process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`];

async function api(path, params, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? new URLSearchParams(params) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Stripe ${res.status}`);
  return json;
}

function createCheckout(user, plan, interval, publicUrl) {
  const p = price(plan, interval);
  if (!p) throw new Error(`Missing Stripe price for ${plan}/${interval}`);
  return api('/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': p,
    'line_items[0][quantity]': '1',
    client_reference_id: String(user.id),
    'metadata[plan]': plan,
    'metadata[interval]': interval,
    'subscription_data[metadata][plan]': plan,
    ...(TRIAL_DAYS > 0 && !user.stripe_customer ? { 'subscription_data[trial_period_days]': String(TRIAL_DAYS) } : {}),
    ...(user.stripe_customer ? { customer: user.stripe_customer } : { customer_email: user.email }),
    success_url: `${publicUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicUrl}/pay`,
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
  });
}

const getCheckout = (id) => api(`/checkout/sessions/${encodeURIComponent(id)}`, null, 'GET');
const getSubscription = (id) => api(`/subscriptions/${encodeURIComponent(id)}`, null, 'GET');

const createPortal = (customer, publicUrl) => api('/billing_portal/sessions', { customer, return_url: `${publicUrl}/account` });

/** Switch a subscription to a different plan (e.g. Solo -> Team), prorated. */
async function changePlan(subscriptionId, plan, interval) {
  const sub = await getSubscription(subscriptionId);
  const main = sub.items.data.find((i) => i.price.id !== price('seat', interval)) || sub.items.data[0];
  return api(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    'items[0][id]': main.id, 'items[0][price]': price(plan, interval),
    'metadata[plan]': plan, proration_behavior: 'create_prorations',
  });
}

/** Set the number of extra team seats (0 removes the line). */
async function setExtraSeats(subscriptionId, interval, qty) {
  const seatPrice = price('seat', interval);
  if (!seatPrice) throw new Error('Missing Stripe price for extra seats');
  const sub = await getSubscription(subscriptionId);
  const item = sub.items.data.find((i) => i.price.id === seatPrice);
  if (item && qty === 0) return api(`/subscription_items/${item.id}`, { proration_behavior: 'create_prorations' }, 'DELETE');
  if (item) return api(`/subscription_items/${item.id}`, { quantity: String(qty), proration_behavior: 'create_prorations' });
  if (qty > 0) return api('/subscription_items', { subscription: subscriptionId, price: seatPrice, quantity: String(qty), proration_behavior: 'create_prorations' });
}

const cancelNow = (subscriptionId) => api(`/subscriptions/${encodeURIComponent(subscriptionId)}`, null, 'DELETE');

/** Verify Stripe-Signature header against the raw body. Returns parsed event or null. */
function verifyWebhook(rawBody, header) {
  if (!WEBHOOK_SECRET || !header) return null;
  const items = header.split(',').map((p) => p.split('='));
  const t = items.find(([k]) => k === 't')?.[1];
  const sigs = items.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  return ok ? JSON.parse(rawBody) : null;
}

module.exports = { enabled, createCheckout, getCheckout, getSubscription, createPortal, changePlan, setExtraSeats, cancelNow, verifyWebhook };
