// Server-rendered HTML. No front-end framework: fast, tiny, works on any phone.
const { PLANS, SEAT, TRIAL_DAYS } = require('./plans');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const THEME = process.env.THEME || 'classic';
const hidden = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

const layout = ({ title, body, user, csrf, isOwner }) => `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title ? `${title} · We Missed You` : 'We Missed You')}</title>
<meta name="description" content="Never lose a job to a missed call. We Missed You texts every caller you couldn't answer.">
<meta name="theme-color" content="#1b3150">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="apple-mobile-web-app-title" content="We Missed You">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="stylesheet" href="/style.css?v=3">
<script src="/app.js?v=3" defer></script>
</head>
<body class="theme-${esc(THEME)}">
<div class="sheen" aria-hidden="true"></div>
<header class="top">
  <a class="brand" href="/"><span class="logo">WMY</span><span class="brand-name">We Missed You</span></a>
  <nav>${
    user
      ? `<a href="/dashboard">Home</a>${isOwner && user.plan === 'team' ? '<a href="/team">Team</a>' : ''}<a href="/account">Account</a>
         <form method="post" action="/logout" class="inline">${hidden(csrf)}<button class="link">Log out</button></form>`
      : `<a href="/login">Log in</a><a class="btn small" href="/signup">Start free</a>`
  }</nav>
</header>
<main>${body}</main>
<footer>© ${new Date().getFullYear()} Blue Labs LTD · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</body>
</html>`;

const flash = (msg, kind = 'error') => (msg ? `<p class="flash ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(msg)}</p>` : '');

const planCards = (selectable) => `
<div class="billing-toggle" role="radiogroup" aria-label="Billing period">
  <label><input type="radio" name="interval" value="month" checked><span>Monthly</span></label>
  <label><input type="radio" name="interval" value="year"><span>Yearly <em>2 months free</em></span></label>
</div>
<div class="plans">
  ${Object.values(PLANS).map((p, i) => `
  <label class="plan ${p.key === 'team' ? 'featured' : ''}">
    ${selectable ? `<input type="radio" name="plan" value="${p.key}" ${i === 0 ? 'checked' : ''}>` : ''}
    <span class="plan-name">${p.name}</span>
    <span class="plan-blurb muted">${p.blurb}</span>
    <span class="price"><span class="m">${p.month}<small>/month</small></span><span class="y">${p.year}<small>/year</small></span></span>
    <ul>${p.perks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  </label>`).join('')}
</div>`;

const home = () => `
<section class="hero">
  <div class="logo big">WMY</div>
  <h1>Missed a call?<br><span class="lime">We'll text them back.</span></h1>
  <p class="lead">On a roof, under a sink or driving between jobs: when you can't pick up, We Missed You instantly sends your caller a friendly message by SMS or WhatsApp. No more lost jobs.</p>
  <a class="btn" href="/signup">Try it free for ${TRIAL_DAYS} days</a>
  <ol class="steps">
    <li><b>Sign up</b> in 30 seconds</li>
    <li><b>Connect</b> your phone number</li>
    <li><b>Pick</b> SMS or WhatsApp and write your message</li>
    <li><b>Done.</b> Every missed caller hears from you.</li>
  </ol>
</section>
<section class="pricing" id="pricing">
  <h2 class="center">Simple, fair pricing</h2>
  <p class="center muted">Less than 50p a day. One saved job pays for the year.</p>
  ${planCards(false)}
  <p class="center"><a class="btn" href="/signup">Start your free trial</a></p>
</section>`;

const signup = ({ error, values = {} } = {}) => `
<section class="card narrow">
  <h1>Create your account</h1>
  ${flash(error)}
  <form method="post" action="/signup">
    <label>Name<input name="name" required maxlength="80" autocomplete="name" value="${esc(values.name)}"></label>
    <label>Email<input name="email" type="email" required maxlength="160" autocomplete="email" value="${esc(values.email)}"></label>
    <label>Password<input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password"></label>
    <button class="btn full">Sign up</button>
  </form>
  <p class="muted small">By signing up you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
  <p class="muted">Already have an account? <a href="/login">Log in</a></p>
</section>`;

const login = ({ error, notice, email } = {}) => `
<section class="card narrow">
  <h1>Welcome back</h1>
  ${flash(error)}${flash(notice, 'ok')}
  <form method="post" action="/login">
    <label>Email<input name="email" type="email" required autocomplete="email" value="${esc(email)}"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn full">Log in</button>
  </form>
  <p class="muted"><a href="/forgot">Forgot password?</a> · <a href="/signup">Create an account</a></p>
</section>`;

const forgot = ({ sent } = {}) => `
<section class="card narrow">
  <h1>Reset your password</h1>
  ${sent ? flash('If that email has an account, a reset link is on its way. Check your inbox (and spam).', 'ok') : ''}
  <form method="post" action="/forgot">
    <label>Email<input name="email" type="email" required autocomplete="email"></label>
    <button class="btn full">Send reset link</button>
  </form>
  <p class="muted"><a href="/login">Back to log in</a></p>
</section>`;

const setPassword = ({ token, error, heading, button, intro }) => `
<section class="card narrow">
  <h1>${esc(heading)}</h1>
  ${intro ? `<p>${esc(intro)}</p>` : ''}
  ${flash(error)}
  <form method="post">
    <input type="hidden" name="token" value="${esc(token)}">
    <label>New password<input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password"></label>
    <button class="btn full">${esc(button)}</button>
  </form>
</section>`;

const badLink = () => `<section class="card narrow center"><h1>Link expired</h1><p>This link is invalid or has expired.</p><p><a class="btn" href="/forgot">Get a new one</a></p></section>`;

const pay = ({ user, csrf, stripeEnabled, error }) => `
<section class="center">
  <h1>Hi ${esc(user.name.split(' ')[0])} 👋</h1>
  <p class="lead">Pick a plan. ${stripeEnabled ? `Your first ${TRIAL_DAYS} days are free, and you can cancel any time.` : ''}</p>
</section>
${flash(error)}
<form method="post" action="/pay" class="pay-form">
  ${hidden(csrf)}
  ${planCards(true)}
  <button class="btn full">${stripeEnabled ? `Start ${TRIAL_DAYS}-day free trial` : 'Activate (test mode, no payment)'}</button>
  <p class="muted small center">${stripeEnabled ? 'Payments are handled securely by Stripe. Have a code? Enter it at checkout.' : 'Stripe keys aren’t set yet, so this unlocks the account for testing.'}</p>
</form>`;

const setup = ({ user, csrf, error, notice }) => `
<section class="card">
  <h1>${user.wmy_number ? 'Phone settings' : 'Connect your phone'}</h1>
  ${flash(error)}${flash(notice, 'ok')}
  <form method="post" action="/setup">
    ${hidden(csrf)}
    <label>Business name <span class="muted">(optional)</span>
      <input name="business_name" maxlength="80" value="${esc(user.business_name)}" placeholder="e.g. Dave's Plumbing"></label>
    <label>Your mobile number
      <input name="mobile" type="tel" required maxlength="20" value="${esc(user.mobile)}" placeholder="07700 900123" autocomplete="tel"></label>
    <fieldset>
      <legend>How should calls reach We Missed You?</legend>
      <label class="choice"><input type="radio" name="mode" value="forward" ${user.mode !== 'business' ? 'checked' : ''}>
        <span><b>Keep my number</b><br><span class="muted">Calls you don't answer on your mobile get passed to us. Customers keep calling the number they already have.</span></span></label>
      <label class="choice"><input type="radio" name="mode" value="business" ${user.mode === 'business' ? 'checked' : ''}>
        <span><b>Give me a business number</b><br><span class="muted">Customers call your new business number. We ring your mobile first, and if you don't pick up, we message them. Your personal number stays private.</span></span></label>
    </fieldset>
    <fieldset>
      <legend>Send the message by</legend>
      <div class="toggle">
        <label><input type="radio" name="channel" value="sms" ${user.channel !== 'whatsapp' ? 'checked' : ''}><span>SMS</span></label>
        <label><input type="radio" name="channel" value="whatsapp" ${user.channel === 'whatsapp' ? 'checked' : ''}><span>WhatsApp</span></label>
      </div>
    </fieldset>
    <label>Never message these numbers <span class="muted">(optional: family, suppliers… one per line)</span>
      <textarea name="skip_numbers" rows="3" maxlength="2000" placeholder="07700 900456">${esc(user.skip_numbers)}</textarea></label>
    <button class="btn full">${user.wmy_number ? 'Save' : 'Connect'}</button>
  </form>
</section>
${user.wmy_number ? `<section class="card">
  <h2>Your We Missed You number</h2>
  <p class="number">${esc(user.wmy_number)}</p>
  ${user.mode === 'business'
    ? `<p>Put this number on your van, website and cards. Calls ring your mobile (${esc(user.mobile)}) for 20 seconds. Press any key to take the call. If you don't, the caller gets your message.</p>`
    : `<p><b>One-time step:</b> on your mobile, open the phone keypad, type this code and press call:</p>
       <p class="code">**004*${esc(user.wmy_number)}#</p>
       <p class="muted small">This passes on calls you don't answer, decline, or miss with no signal. It works on all UK networks. To turn it off, dial <b>##004#</b>.</p>`}
  <p class="muted small">When customers reply to your message, we text their reply straight to your mobile.</p>
  <form method="post" action="/test">${hidden(csrf)}<button class="btn ghost full">Send a test message to my mobile</button></form>
</section>` : ''}`;

const fmtTime = (s) =>
  new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

const usageBar = (u) => `
<div class="usage ${u.pct >= 100 ? 'full' : u.pct >= 80 ? 'warn' : ''}">
  <div class="row"><span>Texts this month</span><b>${u.used} / ${u.limit}</b></div>
  <div class="bar"><span style="width:${u.pct}%"></span></div>
  ${u.pct >= 100 ? '<p class="small">Limit reached: new missed calls won’t be texted until the 1st. <a href="/account">Upgrade</a></p>'
    : u.pct >= 80 ? '<p class="small">You’re close to your monthly limit. <a href="/account">Need more?</a></p>' : ''}
</div>`;

const presets = [
  "Sorry I missed your call! How can I help? I'll get back to you as soon as I can.",
  "Hi, it's {business}. I'm on a job right now. Reply with what you need and I'll call you back shortly.",
  'Apologies for missing you! Text me your name, address and the job, and I’ll send a quote.',
];

const dashboard = ({ user, csrf, stats, calls, usage, notice }) => `
${flash(notice, 'ok')}
<section class="stats">
  <div class="stat main"><span class="num">${stats.total || 0}</span><span class="lbl">missed calls caught</span></div>
  <div class="stat"><span class="num">${stats.week || 0}</span><span class="lbl">this week</span></div>
  <div class="stat"><span class="num">${stats.sent || 0}</span><span class="lbl">messages sent</span></div>
</section>
${usageBar(usage)}
<section class="card">
  <div class="row">
    <h2>Your message</h2>
    <span class="pill ${user.active ? 'on' : 'off'}">${user.active ? 'ON' : 'PAUSED'} · ${user.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</span>
  </div>
  <form method="post" action="/message">
    ${hidden(csrf)}
    <textarea name="message" rows="4" maxlength="480" required>${esc(user.message)}</textarea>
    <p class="muted small">Tip: write <b>{business}</b> and we'll fill in your business name.</p>
    <div class="presets">${presets.map((p) => `<button type="button" class="chip" data-preset="${esc(p)}">${esc(p.slice(0, 34))}…</button>`).join('')}</div>
    <div class="row gap">
      <button class="btn">Save message</button>
      <button class="btn ghost" name="toggle" value="1">${user.active ? 'Pause' : 'Resume'}</button>
    </div>
  </form>
</section>
<section class="card">
  <h2>Recent missed calls</h2>
  ${calls.length
    ? `<ul class="calls">${calls.map((c) => `<li><a href="tel:${esc(c.caller)}">${esc(c.caller)}</a><span class="muted">${esc(fmtTime(c.created_at))}</span>
        <span class="pill ${c.status === 'sent' ? 'on' : 'off'}" title="${esc(c.status === 'skipped' ? c.detail : '')}">${c.replied ? 'replied' : esc(c.status)}</span></li>`).join('')}</ul>`
    : `<p class="muted">No missed calls yet. When someone calls and you can't answer, they'll show up here.</p>`}
</section>`;

const account = ({ user, owner, plan, usage, csrf, stripeEnabled, notice, error }) => {
  const isOwner = user.id === owner.id;
  return `
${flash(notice, 'ok')}${flash(error)}
<section class="card">
  <h1>Account</h1>
  <p><b>${esc(user.name)}</b><br><span class="muted">${esc(user.email)}</span></p>
  ${isOwner
    ? `<div class="row"><span>Plan</span><span class="pill on">${esc(plan.name)} · ${owner.billing_interval === 'year' ? 'yearly' : 'monthly'}</span></div>`
    : `<p class="muted">You're on <b>${esc(owner.business_name || owner.name)}</b>'s team. Billing is handled by the team owner.</p>`}
  ${usageBar(usage)}
  <p><a class="btn ghost full" href="/setup">Phone &amp; message settings</a></p>
  ${isOwner && plan.key === 'solo' ? `
  <form method="post" action="/account/plan">${hidden(csrf)}<input type="hidden" name="plan" value="team">
    <button class="btn full">Upgrade to Team: ${PLANS.team.month}/month for up to 5 people</button></form>` : ''}
  ${isOwner && plan.key === 'team' ? `<p><a class="btn full" href="/team">Manage team</a></p>` : ''}
  ${isOwner && stripeEnabled && owner.stripe_customer ? `
  <form method="post" action="/billing/portal">${hidden(csrf)}<button class="btn ghost full">Billing, invoices &amp; cancel</button></form>` : ''}
</section>
<section class="card">
  <h2>Change password</h2>
  <form method="post" action="/account/password">${hidden(csrf)}
    <label>Current password<input name="current" type="password" required autocomplete="current-password"></label>
    <label>New password<input name="password" type="password" required minlength="8" maxlength="200" autocomplete="new-password"></label>
    <button class="btn ghost full">Update password</button>
  </form>
  <p class="muted small">Changing your password logs you out on every other device.</p>
</section>
<details class="card danger">
  <summary>Delete account</summary>
  <p>This permanently deletes your account${isOwner && plan.key === 'team' ? ' and your whole team' : ''}, releases your We Missed You number${isOwner ? ' and cancels your subscription' : ''}. It can't be undone.</p>
  <p class="muted small">If you used call forwarding, dial <b>##004#</b> on your mobile afterwards.</p>
  <form method="post" action="/account/delete">${hidden(csrf)}
    <label>Type DELETE to confirm<input name="confirm" required pattern="DELETE" autocomplete="off"></label>
    <button class="btn danger full">Delete my account</button>
  </form>
</details>`;
};

const team = ({ owner, members, plan, usage, csrf, invite, error, notice, publicUrl }) => {
  const used = 1 + members.length;
  return `
${flash(notice, 'ok')}${flash(error)}
${invite ? `<section class="card invite">
  <h2>Invite ready for ${esc(invite.name)}</h2>
  <p>Send them this link. It works for 7 days. ${invite.emailed ? 'We’ve emailed it to them too.' : ''}</p>
  <p class="code small-code">${esc(invite.url)}</p>
  <div class="row gap">
    <a class="btn" href="https://wa.me/?text=${encodeURIComponent(`Join our team on We Missed You: ${invite.url}`)}" target="_blank" rel="noopener">Share on WhatsApp</a>
    <button class="btn ghost" type="button" data-copy="${esc(invite.url)}">Copy link</button>
  </div>
</section>` : ''}
<section class="card">
  <div class="row"><h1>Your team</h1><span class="pill on">${used} / ${plan.seats} people</span></div>
  ${usageBar(usage)}
  <ul class="members">
    <li><span><b>${esc(owner.name)}</b> <span class="muted">(you)</span><br><span class="muted small">${esc(owner.wmy_number || 'not connected yet')}</span></span></li>
    ${members.map((m) => `<li>
      <span><b>${esc(m.name)}</b><br><span class="muted small">${m.password_hash ? esc(m.wmy_number || 'not connected yet') : 'invite pending'} · ${m.stats.total || 0} missed · ${m.stats.month || 0} texts this month</span></span>
      <form method="post" action="/team/remove" data-confirm="Remove ${esc(m.name)} from the team?">${hidden(csrf)}<input type="hidden" name="id" value="${m.id}"><button class="link">Remove</button></form>
    </li>`).join('')}
  </ul>
</section>
<section class="card">
  <h2>Add someone</h2>
  <form method="post" action="/team/invite">${hidden(csrf)}
    <label>Their name<input name="name" required maxlength="80"></label>
    <label>Their email<input name="email" type="email" required maxlength="160"></label>
    <button class="btn full">Create invite</button>
  </form>
  <p class="muted small">${used >= plan.seats ? `Your team is full. Adding another person costs ${SEAT.month}/month (prorated) and adds ${SEAT.texts} texts a month.` : `${plan.seats - used} free place${plan.seats - used === 1 ? '' : 's'} left.`}</p>
</section>`;
};

const legal = (title, html) => `<section class="card prose"><h1>${title}</h1>${html}<p class="muted small">Last updated ${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}. Questions? Contact Blue Labs LTD.</p></section>`;

const privacy = () => legal('Privacy Policy', `
<p>We Missed You is run by <b>Blue Labs LTD</b> (the "data controller"), registered in England and Wales.</p>
<h2>What we collect</h2>
<ul><li>Account details: name, email, a securely hashed password.</li>
<li>Phone details: your mobile number and the We Missed You number we assign you.</li>
<li>Call records: the phone numbers of people who call you and aren't answered, when they called, and whether we messaged them. If they reply, we pass the reply to your mobile and don't keep its text.</li>
<li>Payments are processed by Stripe. We never see or store your card details.</li></ul>
<h2>Why</h2>
<p>To provide the service you signed up for (contract), and to keep it secure and prevent abuse (legitimate interests). We never sell data or use callers' numbers for marketing.</p>
<h2>Who we share it with</h2>
<p>Only the processors needed to run the service: Twilio (calls, SMS, WhatsApp), Meta/WhatsApp (if you choose WhatsApp), Stripe (payments), Render (hosting) and Resend (account emails).</p>
<h2>How long</h2>
<p>We keep call records while your account is open. When you delete your account, your data and call records are deleted straight away.</p>
<h2>Your rights</h2>
<p>You can access, correct, export or delete your data, and you can complain to the ICO (ico.org.uk). You can delete your account any time from the Account page.</p>`);

const terms = () => legal('Terms of Service', `
<p>These terms are between you and <b>Blue Labs LTD</b> for the We Missed You service.</p>
<h2>The service</h2>
<p>We Missed You sends an automatic message to people whose calls you don't answer. Delivery depends on phone networks, Twilio and WhatsApp, so we can't guarantee every message arrives.</p>
<h2>Your responsibilities</h2>
<ul><li>Only use it for genuine replies to people who called you. No marketing, spam or unlawful content.</li>
<li>Keep your login safe, and give accurate details.</li>
<li>You're responsible for the messages you write.</li></ul>
<h2>Billing</h2>
<p>Plans are billed monthly or yearly in advance through Stripe after any free trial. Plans include a monthly text allowance, and texting pauses when it runs out. You can cancel any time from Account → Billing, and the cancellation takes effect at the end of the current period. Your We Missed You number is released when your subscription ends.</p>
<h2>Liability</h2>
<p>The service is provided "as is". To the extent the law allows, our liability is limited to the fees you paid in the last 3 months. Nothing limits liability that can't be limited by law.</p>
<h2>Changes</h2>
<p>We may update these terms and will tell you about important changes by email. These terms are governed by the laws of England and Wales.</p>`);

const notFound = () => `<section class="card narrow center"><h1>Not found</h1><p><a href="/">Go home</a></p></section>`;

module.exports = { layout, home, signup, login, forgot, setPassword, badLink, pay, setup, dashboard, account, team, privacy, terms, notFound };
