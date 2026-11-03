// Load .env if present (Node 22 built-in, no dotenv needed). Must run before other modules read env.
if (require('node:fs').existsSync('.env')) process.loadEnvFile('.env');

const path = require('node:path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const views = require('./views');
const twilio = require('./twilio');
const stripe = require('./stripe');
const mail = require('./mail');
const { PLANS, ownerOf, planOf, usage } = require('./plans');
const { handleMissedCall, handleReply, toE164, validE164, render } = require('./missed');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const RING_SECONDS = Number(process.env.RING_SECONDS || 20);
const HOUR = 36e5;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- Security headers
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'",
      "img-src 'self' data:", "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'",
      "frame-ancestors 'none'", "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(PROD ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
  });
  next();
});

// ---------- Stripe webhook (raw body, before parsers)
app.post('/stripe/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const event = stripe.verifyWebhook(req.body.toString('utf8'), req.headers['stripe-signature']);
  if (!event) return res.status(400).send('bad signature');
  const obj = event.data.object;
  try {
    if (event.type === 'checkout.session.completed' && obj.client_reference_id) {
      activate(Number(obj.client_reference_id), obj);
    } else if (event.type.startsWith('customer.subscription.')) {
      const owner = db.userByCustomer(obj.customer);
      if (owner) {
        const live = ['active', 'trialing', 'past_due'].includes(obj.status) && event.type !== 'customer.subscription.deleted';
        db.setPaid(owner.id, live);
        if (live && obj.metadata?.plan && PLANS[obj.metadata.plan]) db.updateUser(owner.id, { plan: obj.metadata.plan });
        if (!live) await releaseTeamNumbers(owner.id); // stop paying for numbers of cancelled accounts
      }
    }
  } catch (err) {
    console.error('webhook error', err);
  }
  res.json({ received: true });
});

function activate(userId, session) {
  const u = db.userById(userId);
  if (!u || u.team_owner_id) return;
  db.setPaid(u.id, true, session.customer);
  const plan = PLANS[session.metadata?.plan] ? session.metadata.plan : u.plan;
  db.updateUser(u.id, { plan, billing_interval: session.metadata?.interval === 'year' ? 'year' : 'month', stripe_subscription: session.subscription || u.stripe_subscription });
}

async function releaseTeamNumbers(ownerId) {
  for (const id of db.teamIds(ownerId)) {
    const m = db.userById(id);
    if (m?.wmy_number) {
      await twilio.releaseNumber(m.wmy_number_sid);
      db.updateUser(id, { wmy_number: null, wmy_number_sid: null });
    }
  }
}

app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: PROD ? '7d' : 0 }));

// ---------- Session + helpers
app.use((req, res, next) => {
  const s = auth.readSession(req);
  const u = s && db.userById(s.id);
  req.user = u && (u.session_version || 0) === s.version && u.password_hash ? u : null;
  req.owner = req.user ? ownerOf(req.user) : null;
  req.csrf = req.user ? auth.csrfToken(req.user) : '';
  res.page = (title, body, status = 200) => {
    if (req.user) res.set('Cache-Control', 'no-store');
    const isOwner = !!req.user && req.owner?.id === req.user.id;
    res.status(status).type('html').send(views.layout({ title, body, user: req.user && { ...req.user, plan: req.owner?.plan }, csrf: req.csrf, isOwner }));
  };
  next();
});

const needLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const needPaid = (req, res, next) => (!req.user ? res.redirect('/login') : req.owner?.paid ? next() : res.redirect('/pay'));
const needOwner = (req, res, next) => (req.user && req.owner?.id === req.user.id ? next() : res.redirect('/dashboard'));
const csrf = (req, res, next) => (auth.csrfOk(req.user, req.body._csrf) ? next() : res.status(403).type('text').send('Your session expired. Go back and refresh the page.'));
const nextStep = (u) => (!ownerOf(u)?.paid ? '/pay' : !u.wmy_number ? '/setup' : '/dashboard');
const limitAuth = auth.rateLimit({ windowMs: 15 * 60e3, max: 10, key: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}` });
const limitIp = auth.rateLimit({ windowMs: 60 * 60e3, max: 20, key: (req) => req.ip });
const cleanEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 160);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// ---------- Public pages
app.get('/', (req, res) => (req.user ? res.redirect(nextStep(req.user)) : res.page(null, views.home())));
app.get('/signup', (req, res) => res.page('Sign up', views.signup()));
app.get('/login', (req, res) => res.page('Log in', views.login({ notice: req.query.reset ? 'Password updated. Please log in.' : null })));
app.get('/privacy', (req, res) => res.page('Privacy', views.privacy()));
app.get('/terms', (req, res) => res.page('Terms', views.terms()));

app.post('/signup', limitIp, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  const values = { name, email };
  const fail = (error) => res.page('Sign up', views.signup({ error, values }), 400);
  if (!name || !validEmail(email)) return fail('Please enter your name and a valid email.');
  if (password.length < 8 || password.length > 200) return fail('Password must be at least 8 characters.');
  if (db.userByEmail(email)) return fail('That email already has an account. Try logging in.');
  const id = db.createUser(name, email, auth.hashPassword(password));
  auth.setSession(res, db.userById(id));
  res.redirect('/pay');
});

app.post('/login', limitAuth, (req, res) => {
  const email = cleanEmail(req.body.email);
  const user = db.userByEmail(email);
  if (!auth.checkPassword(String(req.body.password || '').slice(0, 200), user?.password_hash))
    return res.page('Log in', views.login({ error: 'Wrong email or password.', email }), 401);
  auth.setSession(res, user);
  res.redirect(nextStep(user));
});

app.post('/logout', needLogin, csrf, (req, res) => {
  auth.clearSession(res);
  res.redirect('/');
});

// ---------- Password reset + team invites (one-time tokens)
app.get('/forgot', (req, res) => res.page('Reset password', views.forgot()));
app.post('/forgot', limitAuth, async (req, res) => {
  const user = db.userByEmail(cleanEmail(req.body.email));
  if (user && user.password_hash) {
    const { token, hash } = auth.newToken();
    db.updateUser(user.id, { token_hash: hash, token_expires: Date.now() + HOUR });
    await mail.send(user.email, 'Reset your We Missed You password',
      `Hi ${user.name},\n\nReset your password here (link works for 1 hour):\n${PUBLIC_URL}/reset?token=${token}\n\nIf you didn't ask for this, ignore this email.\n\nWe Missed You, Blu Labs LTD`);
  }
  res.page('Reset password', views.forgot({ sent: true })); // same response either way: no account enumeration
});

const tokenPage = (kind) => (req, res) => {
  const token = String(req.query.token || req.body?.token || '').slice(0, 100);
  const u = db.userByToken(auth.hashToken(token));
  const isInvite = kind === 'join';
  if (!u || (isInvite ? !!u.password_hash : !u.password_hash)) return res.page('Link expired', views.badLink(), 400);
  const owner = isInvite ? ownerOf(u) : null;
  const page = (error) => views.setPassword({
    token, error,
    heading: isInvite ? `Join ${owner.business_name || owner.name}'s team` : 'Choose a new password',
    intro: isInvite ? `Hi ${u.name}! Set a password to start catching your missed calls.` : '',
    button: isInvite ? 'Join team' : 'Save password',
  });
  if (req.method === 'GET') return res.page(isInvite ? 'Join team' : 'New password', page());
  const pw = String(req.body.password || '');
  if (pw.length < 8 || pw.length > 200) return res.page('New password', page('Password must be at least 8 characters.'), 400);
  db.updateUser(u.id, { password_hash: auth.hashPassword(pw), token_hash: null, token_expires: null, session_version: (u.session_version || 0) + 1 });
  if (isInvite) {
    auth.setSession(res, db.userById(u.id));
    return res.redirect('/setup');
  }
  res.redirect('/login?reset=1');
};
app.get('/reset', tokenPage('reset'));
app.post('/reset', limitIp, tokenPage('reset'));
app.get('/join', tokenPage('join'));
app.post('/join', limitIp, tokenPage('join'));

// ---------- Plans + payment
app.get('/pay', needLogin, (req, res) => {
  if (req.owner.paid) return res.redirect(nextStep(req.user));
  if (req.user.team_owner_id) return res.page('Account paused', `<section class="card narrow center"><h1>Account paused</h1><p>Your team's subscription isn't active. Ask your team owner to check billing.</p></section>`);
  res.page('Choose a plan', views.pay({ user: req.user, csrf: req.csrf, stripeEnabled: stripe.enabled }));
});

app.post('/pay', needLogin, needOwner, csrf, async (req, res) => {
  const plan = PLANS[req.body.plan] ? req.body.plan : 'solo';
  const interval = req.body.interval === 'year' ? 'year' : 'month';
  if (!stripe.enabled) {
    db.setPaid(req.user.id, true);
    db.updateUser(req.user.id, { plan, billing_interval: interval });
    return res.redirect('/setup');
  }
  try {
    const session = await stripe.createCheckout(req.user, plan, interval, PUBLIC_URL);
    res.redirect(303, session.url);
  } catch (err) {
    console.error(err.message);
    res.page('Choose a plan', views.pay({ user: req.user, csrf: req.csrf, stripeEnabled: true, error: 'Could not start payment. Please try again.' }), 502);
  }
});

app.get('/billing/success', needLogin, async (req, res) => {
  try {
    const s = await stripe.getCheckout(String(req.query.session_id || '').slice(0, 200));
    if (String(s.client_reference_id) === String(req.user.id) && s.status === 'complete') activate(req.user.id, s);
  } catch (err) {
    console.error(err.message);
  }
  res.redirect(nextStep(db.userById(req.user.id)));
});

app.post('/billing/portal', needPaid, needOwner, csrf, async (req, res) => {
  if (!stripe.enabled || !req.owner.stripe_customer) return res.redirect('/account');
  const portal = await stripe.createPortal(req.owner.stripe_customer, PUBLIC_URL).catch(() => null);
  res.redirect(303, portal?.url || '/account');
});

// ---------- Paid area
const accountPage = (req, extra = {}) => views.account({
  user: req.user, owner: req.owner, plan: planOf(req.owner), usage: usage(req.owner), csrf: req.csrf, stripeEnabled: stripe.enabled, ...extra,
});

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
  if (!validE164(mobile)) return res.page('Settings', views.setup({ user: { ...req.user, ...fields }, csrf: req.csrf, error: 'Please enter a valid mobile number.' }), 400);
  db.updateUser(req.user.id, fields);
  if (!req.user.wmy_number) {
    try {
      const { number, sid } = await twilio.provisionNumber(PUBLIC_URL);
      db.updateUser(req.user.id, { wmy_number: number, wmy_number_sid: sid });
    } catch (err) {
      console.error(err);
      return res.page('Settings', views.setup({ user: db.userById(req.user.id), csrf: req.csrf, error: `Couldn't get you a number: ${err.message}` }), 502);
    }
  }
  res.redirect('/setup?saved=1');
});

app.post('/test', needPaid, csrf, limitIp, async (req, res) => {
  const u = req.user;
  if (!u.mobile || !u.wmy_number) return res.redirect('/setup');
  try {
    await twilio.sendMessage({ channel: u.channel, from: u.wmy_number, to: u.mobile, body: render(u) });
    res.page('Settings', views.setup({ user: u, csrf: req.csrf, notice: `Test sent to ${u.mobile} by ${u.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}.` }));
  } catch (err) {
    res.page('Settings', views.setup({ user: u, csrf: req.csrf, error: `Test failed: ${err.message}` }), 502);
  }
});

app.get('/dashboard', needPaid, (req, res) => {
  if (!req.user.wmy_number) return res.redirect('/setup');
  res.page('Home', views.dashboard({
    user: req.user, csrf: req.csrf, stats: db.stats(req.user.id), calls: db.recentCalls(req.user.id),
    usage: usage(req.owner), notice: req.query.saved ? 'Saved.' : null,
  }));
});

app.post('/message', needPaid, csrf, (req, res) => {
  if (req.body.toggle) db.updateUser(req.user.id, { active: req.user.active ? 0 : 1 });
  else {
    const message = String(req.body.message || '').trim().slice(0, 480);
    if (message) db.updateUser(req.user.id, { message });
  }
  res.redirect('/dashboard?saved=1');
});

// ---------- Account
app.get('/account', needPaid, (req, res) => res.page('Account', accountPage(req, { notice: req.query.saved ? 'Saved.' : null })));

app.post('/account/plan', needPaid, needOwner, csrf, async (req, res) => {
  const plan = PLANS[req.body.plan] ? req.body.plan : null;
  if (!plan || plan === req.owner.plan) return res.redirect('/account');
  try {
    if (stripe.enabled && req.owner.stripe_subscription) await stripe.changePlan(req.owner.stripe_subscription, plan, req.owner.billing_interval);
    db.updateUser(req.owner.id, { plan });
    res.redirect(plan === 'team' ? '/team' : '/account?saved=1');
  } catch (err) {
    res.page('Account', accountPage(req, { error: `Couldn't change plan: ${err.message}` }), 502);
  }
});

app.post('/account/password', needLogin, csrf, limitAuth, (req, res) => {
  const pw = String(req.body.password || '');
  if (!auth.checkPassword(String(req.body.current || '').slice(0, 200), req.user.password_hash)) return res.page('Account', accountPage(req, { error: 'Current password is wrong.' }), 400);
  if (pw.length < 8 || pw.length > 200) return res.page('Account', accountPage(req, { error: 'New password must be at least 8 characters.' }), 400);
  db.updateUser(req.user.id, { password_hash: auth.hashPassword(pw), session_version: (req.user.session_version || 0) + 1 });
  auth.setSession(res, db.userById(req.user.id)); // keep this device logged in
  res.redirect('/account?saved=1');
});

app.post('/account/delete', needLogin, csrf, async (req, res) => {
  if (req.body.confirm !== 'DELETE') return res.redirect('/account');
  if (req.owner?.id === req.user.id) {
    if (stripe.enabled && req.user.stripe_subscription) await stripe.cancelNow(req.user.stripe_subscription).catch((e) => console.error(e.message));
    await releaseTeamNumbers(req.user.id);
    for (const m of db.teamMembers(req.user.id)) db.deleteUser(m.id);
  } else {
    await twilio.releaseNumber(req.user.wmy_number_sid);
    await syncSeats(req.owner, -1).catch((e) => console.error(e.message));
  }
  db.deleteUser(req.user.id);
  auth.clearSession(res);
  res.redirect('/');
});

// ---------- Team (Team plan owners)
const needTeam = (req, res, next) => (req.owner.plan === 'team' ? next() : res.redirect('/account'));
const teamPage = (req, extra = {}) => views.team({
  owner: req.owner, plan: planOf(req.owner), usage: usage(req.owner), csrf: req.csrf,
  members: db.teamMembers(req.owner.id).map((m) => ({ ...m, stats: db.memberStats(m.id) })), ...extra,
});

/** Keep the paid extra seats in line with team size. delta = change about to happen. */
async function syncSeats(owner, delta) {
  if (owner.plan !== 'team') return;
  const people = 1 + db.teamMembers(owner.id).length + delta;
  const extra = Math.max(0, people - PLANS.team.seats);
  if (extra === (owner.extra_seats || 0)) return;
  if (stripe.enabled && owner.stripe_subscription) await stripe.setExtraSeats(owner.stripe_subscription, owner.billing_interval, extra);
  db.updateUser(owner.id, { extra_seats: extra });
}

app.get('/team', needPaid, needOwner, needTeam, (req, res) => res.page('Team', teamPage(req)));

app.post('/team/invite', needPaid, needOwner, needTeam, csrf, limitIp, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = cleanEmail(req.body.email);
  if (!name || !validEmail(email)) return res.page('Team', teamPage(req, { error: 'Please enter their name and a valid email.' }), 400);
  if (db.userByEmail(email)) return res.page('Team', teamPage(req, { error: 'That email already has a We Missed You account.' }), 400);
  try {
    await syncSeats(req.owner, +1);
  } catch (err) {
    return res.page('Team', teamPage(req, { error: `Couldn't add a place: ${err.message}` }), 502);
  }
  const id = db.createUser(name, email, '', req.owner.id);
  const { token, hash } = auth.newToken();
  db.updateUser(id, { token_hash: hash, token_expires: Date.now() + 7 * 24 * HOUR, business_name: req.owner.business_name });
  const url = `${PUBLIC_URL}/join?token=${token}`;
  await mail.send(email, `${req.owner.name} added you to We Missed You`,
    `Hi ${name},\n\n${req.owner.name} has added you to their team on We Missed You, so callers you miss get an instant reply.\n\nSet up your account here (link works for 7 days):\n${url}\n\nWe Missed You, Blu Labs LTD`);
  req.owner = db.userById(req.owner.id);
  res.page('Team', teamPage(req, { invite: { name, url, emailed: mail.enabled } }));
});

app.post('/team/remove', needPaid, needOwner, needTeam, csrf, async (req, res) => {
  const m = db.userById(Number(req.body.id));
  if (!m || m.team_owner_id !== req.owner.id) return res.redirect('/team');
  await twilio.releaseNumber(m.wmy_number_sid);
  db.deleteUser(m.id);
  await syncSeats(db.userById(req.owner.id), 0).catch((e) => console.error(e.message));
  res.redirect('/team');
});

// ---------- Twilio webhooks
const twiml = (res, inner) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const twilioOnly = (req, res, next) => (twilio.validRequest(req, PUBLIC_URL) ? next() : res.status(403).send('forbidden'));
const say = (t) => `<Say voice="Polly.Amy" language="en-GB">${t}</Say>`;
const accepted = new Map(); // parent CallSid -> time the tradesperson pressed a key

app.post('/twilio/voice', twilioOnly, (req, res) => {
  const user = db.userByNumber(req.body.To);
  if (!user || !ownerOf(user)?.paid) return twiml(res, `${say('Sorry, this number is not in service.')}<Hangup/>`);
  if (user.mode === 'business' && user.active && user.mobile) {
    // Ring the tradesperson. The whisper asks them to press a key, so their voicemail doesn't count as answered.
    const caller = validE164(toE164(req.body.From)) ? toE164(req.body.From) : user.wmy_number;
    return twiml(res, `<Dial timeout="${RING_SECONDS}" callerId="${xml(caller)}" action="/twilio/after-dial"><Number url="/twilio/screen">${xml(user.mobile)}</Number></Dial>`);
  }
  handleMissedCall(user, req.body.From); // forward mode: reaching us means it was missed
  twiml(res, `${say(`Sorry, ${user.business_name ? xml(user.business_name) : 'we'} couldn't take your call. We've just sent you a message.`)}<Hangup/>`);
});

app.post('/twilio/screen', twilioOnly, (req, res) =>
  twiml(res, `<Gather numDigits="1" timeout="6" action="/twilio/screen/ok">${say('We Missed You call. Press any key to accept.')}</Gather><Hangup/>`));

app.post('/twilio/screen/ok', twilioOnly, (req, res) => {
  if (req.body.ParentCallSid) accepted.set(req.body.ParentCallSid, Date.now());
  twiml(res, '');
});

app.post('/twilio/after-dial', twilioOnly, (req, res) => {
  const answered = accepted.delete(req.body.CallSid);
  for (const [k, t] of accepted) if (Date.now() - t > HOUR) accepted.delete(k);
  if (answered) return twiml(res, '<Hangup/>');
  const user = db.userByNumber(req.body.To);
  if (user) handleMissedCall(user, req.body.From);
  twiml(res, `${say("Sorry we couldn't take your call. We've just sent you a message.")}<Hangup/>`);
});

// Customer replied by SMS (to the user's number) or WhatsApp (to the shared sender).
app.post('/twilio/sms', twilioOnly, async (req, res) => {
  await handleReply({ to: req.body.To, from: req.body.From, body: req.body.Body || '' });
  twiml(res, '');
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.use((req, res) => res.page('Not found', views.notFound(), 404));
app.use((err, req, res, next) => { // never leak stack traces
  console.error(err);
  res.status(500).type('text').send('Something went wrong. Please try again.');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`We Missed You running on ${PUBLIC_URL}`);
    if (!twilio.enabled) console.log('  Twilio: DEV mode (messages are logged, not sent)');
    if (!stripe.enabled) console.log('  Stripe: DEV mode (plans unlock for free)');
    if (!mail.enabled) console.log('  Email: DEV mode (emails are logged)');
  });
}

module.exports = app;

// Async handlers in Express 4 don't reach the error middleware; log instead of crashing.
process.on('unhandledRejection', (err) => console.error('unhandled', err));
