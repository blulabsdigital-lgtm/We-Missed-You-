// Load .env if present (Node 22 built-in, no dotenv needed). Must run before other modules read env.
if (require("node:fs").existsSync(".env")) process.loadEnvFile(".env");

const path = require('node:path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const views = require('./views');
const twilio = require('./twilio');
const stripe = require('./stripe');
const { handleMissedCall, toE164 } = require('./missed');

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const RING_SECONDS = Number(process.env.RING_SECONDS || 20);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Stripe webhook needs the raw body, so it's registered before the body parsers.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const event = stripe.verifyWebhook(req.body.toString('utf8'), req.headers['stripe-signature']);
  if (!event) return res.status(400).send('bad signature');
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed' && obj.client_reference_id) {
    db.setPaid(Number(obj.client_reference_id), true, obj.customer);
  } else if (event.type === 'customer.subscription.deleted' || (event.type === 'customer.subscription.updated' && ['canceled', 'unpaid'].includes(obj.status))) {
    const u = db.userByCustomer(obj.customer);
    if (u) db.setPaid(u.id, false);
  } else if (event.type === 'customer.subscription.updated' && ['active', 'trialing'].includes(obj.status)) {
    const u = db.userByCustomer(obj.customer);
    if (u) db.setPaid(u.id, true);
  }
  res.json({ received: true });
});

app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));

// --- Session + helpers
app.use((req, res, next) => {
  const id = auth.readSession(req);
  req.user = id ? db.userById(id) : null;
  req.csrf = req.user ? auth.csrfToken(req.user.id) : '';
  res.page = (title, body, status = 200) =>
    res.status(status).type('html').send(views.layout({ title, body, user: req.user, csrf: req.csrf }));
  next();
});

const needLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const needPaid = (req, res, next) => (!req.user ? res.redirect('/login') : req.user.paid ? next() : res.redirect('/pay'));
const csrf = (req, res, next) => (req.body._csrf === req.csrf ? next() : res.status(403).send('Session expired — go back and refresh.'));
const nextStep = (u) => (!u.paid ? '/pay' : !u.wmy_number ? '/setup' : '/dashboard');

// --- Public pages
app.get('/', (req, res) => (req.user ? res.redirect(nextStep(req.user)) : res.page(null, views.home())));
app.get('/signup', (req, res) => res.page('Sign up', views.signup()));
app.get('/login', (req, res) => res.page('Log in', views.login()));

app.post('/signup', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  const password = String(req.body.password || '');
  const values = { name, email };
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return res.page('Sign up', views.signup({ error: 'Please enter your name and a valid email.', values }), 400);
  if (password.length < 8) return res.page('Sign up', views.signup({ error: 'Password must be at least 8 characters.', values }), 400);
  if (db.userByEmail(email)) return res.page('Sign up', views.signup({ error: 'That email already has an account — try logging in.', values }), 400);
  const id = db.createUser(name, email, auth.hashPassword(password));
  auth.setSession(res, id);
  res.redirect('/pay');
});

app.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.userByEmail(email);
  if (!user || !auth.checkPassword(String(req.body.password || ''), user.password_hash))
    return res.page('Log in', views.login({ error: 'Wrong email or password.', email }), 401);
  auth.setSession(res, user.id);
  res.redirect(nextStep(user));
});

app.post('/logout', needLogin, csrf, (req, res) => {
  auth.clearSession(res);
  res.redirect('/');
});

// --- Payment gate
app.get('/pay', needLogin, (req, res) => {
  if (req.user.paid) return res.redirect(nextStep(req.user));
  res.page('Activate', views.pay({ user: req.user, csrf: req.csrf, stripeEnabled: stripe.enabled }));
});

app.post('/pay', needLogin, csrf, async (req, res) => {
  if (!stripe.enabled) {
    db.setPaid(req.user.id, true); // DEV mode unlock
    return res.redirect('/setup');
  }
  try {
    const session = await stripe.createCheckout(req.user, PUBLIC_URL);
    res.redirect(303, session.url);
  } catch (err) {
    console.error(err);
    res.page('Activate', views.pay({ user: req.user, csrf: req.csrf, stripeEnabled: true, error: 'Could not start payment. Please try again.' }), 502);
  }
});

app.get('/billing/success', needLogin, async (req, res) => {
  // Confirm directly with Stripe so the user isn't stuck waiting on the webhook.
  try {
    const s = await stripe.getCheckout(String(req.query.session_id || ''));
    if (String(s.client_reference_id) === String(req.user.id) && (s.payment_status === 'paid' || s.status === 'complete')) {
      db.setPaid(req.user.id, true, s.customer);
    }
  } catch (err) {
    console.error(err.message);
  }
  res.redirect(nextStep(db.userById(req.user.id)));
});

app.post('/billing/portal', needPaid, csrf, async (req, res) => {
  if (!stripe.enabled || !req.user.stripe_customer) return res.redirect('/dashboard');
  const portal = await stripe.createPortal(req.user.stripe_customer, PUBLIC_URL).catch(() => null);
  res.redirect(303, portal?.url || '/dashboard');
});

// --- Paid area
app.get('/setup', needPaid, (req, res) => res.page('Settings', views.setup({ user: req.user, csrf: req.csrf, notice: req.query.saved ? 'Saved.' : null })));

app.post('/setup', needPaid, csrf, async (req, res) => {
  const mobile = toE164(req.body.mobile);
  const fields = {
    business_name: String(req.body.business_name || '').trim().slice(0, 80) || null,
    mobile,
    mode: req.body.mode === 'business' ? 'business' : 'forward',
    channel: req.body.channel === 'whatsapp' ? 'whatsapp' : 'sms',
    skip_numbers: String(req.body.skip_numbers || '').slice(0, 2000) || null,
  };
  if (!/^\+\d{9,15}$/.test(mobile)) {
    return res.page('Settings', views.setup({ user: { ...req.user, ...fields }, csrf: req.csrf, error: 'Please enter a valid mobile number.' }), 400);
  }
  db.updateUser(req.user.id, fields);
  if (!req.user.wmy_number) {
    try {
      db.updateUser(req.user.id, { wmy_number: await twilio.provisionNumber(PUBLIC_URL) });
    } catch (err) {
      console.error(err);
      return res.page('Settings', views.setup({ user: db.userById(req.user.id), csrf: req.csrf, error: `Couldn't get you a number: ${err.message}` }), 502);
    }
  }
  res.redirect('/setup?saved=1');
});

app.post('/test', needPaid, csrf, async (req, res) => {
  const u = req.user;
  if (!u.mobile || !u.wmy_number) return res.redirect('/setup');
  try {
    await twilio.sendMessage({ channel: u.channel, from: u.wmy_number, to: u.mobile, body: require('./missed').render(u) });
    res.page('Settings', views.setup({ user: u, csrf: req.csrf, notice: `Test sent to ${u.mobile} by ${u.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}.` }));
  } catch (err) {
    res.page('Settings', views.setup({ user: u, csrf: req.csrf, error: `Test failed: ${err.message}` }), 502);
  }
});

app.get('/dashboard', needPaid, (req, res) => {
  if (!req.user.wmy_number) return res.redirect('/setup');
  res.page('Home', views.dashboard({
    user: req.user, csrf: req.csrf, stats: db.stats(req.user.id), calls: db.recentCalls(req.user.id),
    notice: req.query.saved ? 'Saved.' : null,
  }));
});

app.post('/message', needPaid, csrf, (req, res) => {
  if (req.body.toggle) {
    db.updateUser(req.user.id, { active: req.user.active ? 0 : 1 });
  } else {
    const message = String(req.body.message || '').trim().slice(0, 480);
    if (message) db.updateUser(req.user.id, { message });
  }
  res.redirect('/dashboard?saved=1');
});

// --- Twilio voice webhooks (set automatically on each provisioned number)
const twiml = (res, inner) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const twilioOnly = (req, res, next) => (twilio.validRequest(req, PUBLIC_URL) ? next() : res.status(403).send('forbidden'));
const accepted = new Map(); // parent CallSid -> time the tradesperson pressed a key

app.post('/twilio/voice', twilioOnly, async (req, res) => {
  const user = db.userByNumber(req.body.To);
  if (!user || !user.paid) return twiml(res, '<Say voice="Polly.Amy">Sorry, this number is not in service.</Say><Hangup/>');

  if (user.mode === 'business' && user.active && user.mobile) {
    // Ring the tradesperson. The whisper asks them to press a key, so their voicemail doesn't count as "answered".
    return twiml(res,
      `<Dial timeout="${RING_SECONDS}" callerId="${xml(req.body.From || user.wmy_number)}" action="/twilio/after-dial">` +
      `<Number url="/twilio/screen">${xml(user.mobile)}</Number></Dial>`);
  }

  // Forward mode: the call only reaches us because the user didn't answer.
  handleMissedCall(user, req.body.From); // fire and forget — answer Twilio immediately
  const who = user.business_name ? xml(user.business_name) : 'we';
  twiml(res, `<Say voice="Polly.Amy">Sorry, ${who} couldn't take your call. We've just sent you a message.</Say><Hangup/>`);
});

app.post('/twilio/screen', twilioOnly, (req, res) => {
  twiml(res, `<Gather numDigits="1" timeout="6" action="/twilio/screen/ok"><Say voice="Polly.Amy">We Missed You call. Press any key to accept.</Say></Gather><Hangup/>`);
});

app.post('/twilio/screen/ok', twilioOnly, (req, res) => {
  if (req.body.ParentCallSid) accepted.set(req.body.ParentCallSid, Date.now());
  twiml(res, '');
});

app.post('/twilio/after-dial', twilioOnly, async (req, res) => {
  const sid = req.body.CallSid;
  const answered = accepted.has(sid);
  accepted.delete(sid);
  for (const [k, t] of accepted) if (Date.now() - t > 36e5) accepted.delete(k); // tidy
  if (answered) return twiml(res, '<Hangup/>');

  const user = db.userByNumber(req.body.To);
  if (user) handleMissedCall(user, req.body.From);
  twiml(res, `<Say voice="Polly.Amy">Sorry we couldn't take your call. We've just sent you a message.</Say><Hangup/>`);
});

app.get('/health', (req, res) => res.json({ ok: true, twilio: twilio.enabled, stripe: stripe.enabled }));
app.use((req, res) => res.page('Not found', views.notFound(), 404));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`We Missed You running on ${PUBLIC_URL}`);
    if (!twilio.enabled) console.log('  Twilio: DEV mode (messages are logged, not sent)');
    if (!stripe.enabled) console.log('  Stripe: DEV mode (pay button unlocks for free)');
  });
}

module.exports = app;
