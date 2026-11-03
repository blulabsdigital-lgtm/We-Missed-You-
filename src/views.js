// Server-rendered HTML. No front-end framework: fast, tiny, works on any phone.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const layout = ({ title, body, user, csrf }) => `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title ? `${title} · We Missed You` : 'We Missed You')}</title>
<meta name="description" content="Never lose a job to a missed call. We Missed You texts every caller you couldn't answer.">
<meta name="theme-color" content="#1f3a5f">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="apple-mobile-web-app-title" content="We Missed You">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/"><span class="logo">WMY</span><span class="brand-name">We Missed You</span></a>
  <nav>${
    user
      ? `<a href="/dashboard">Home</a><a href="/setup">Settings</a>
         <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Log out</button></form>`
      : `<a href="/login">Log in</a><a class="btn small" href="/signup">Sign up</a>`
  }</nav>
</header>
<main>${body}</main>
<footer>© ${new Date().getFullYear()} Blue Labs LTD · We Missed You</footer>
</body>
</html>`;

const flash = (msg, kind = 'error') => (msg ? `<p class="flash ${kind}">${esc(msg)}</p>` : '');

const home = () => `
<section class="hero">
  <div class="logo big">WMY</div>
  <h1>Missed a call?<br><span class="lime">We'll text them back.</span></h1>
  <p class="lead">On a roof, under a sink, driving between jobs — when you can't pick up, We Missed You instantly sends your caller a friendly message by SMS or WhatsApp. No more lost jobs.</p>
  <a class="btn" href="/signup">Get started</a>
  <ol class="steps">
    <li><b>Sign up</b> in 30 seconds</li>
    <li><b>Connect</b> your phone number</li>
    <li><b>Pick</b> SMS or WhatsApp &amp; write your message</li>
    <li><b>Done.</b> Every missed caller hears from you.</li>
  </ol>
</section>`;

const signup = ({ error, values = {} } = {}) => `
<section class="card narrow">
  <h1>Create your account</h1>
  ${flash(error)}
  <form method="post" action="/signup">
    <label>Name<input name="name" required autocomplete="name" value="${esc(values.name)}"></label>
    <label>Email<input name="email" type="email" required autocomplete="email" value="${esc(values.email)}"></label>
    <label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
    <button class="btn full">Sign up</button>
  </form>
  <p class="muted">Already have an account? <a href="/login">Log in</a></p>
</section>`;

const login = ({ error, email } = {}) => `
<section class="card narrow">
  <h1>Welcome back</h1>
  ${flash(error)}
  <form method="post" action="/login">
    <label>Email<input name="email" type="email" required autocomplete="email" value="${esc(email)}"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn full">Log in</button>
  </form>
  <p class="muted">New here? <a href="/signup">Create an account</a></p>
</section>`;

const pay = ({ user, csrf, stripeEnabled, error }) => `
<section class="card narrow center">
  <h1>Hi ${esc(user.name.split(' ')[0])} 👋</h1>
  <p>One last step. Activate your subscription to switch on missed-call messages.</p>
  ${flash(error)}
  <form method="post" action="/pay">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <button class="btn full">${stripeEnabled ? 'Continue to secure payment' : 'Activate (test mode — no payment)'}</button>
  </form>
  <p class="muted small">${stripeEnabled ? 'Payments handled securely by Stripe. Cancel any time.' : 'Stripe keys not set yet — this button unlocks the account for testing.'}</p>
</section>`;

const setup = ({ user, csrf, error, notice }) => {
  const forwardCode = user.wmy_number ? `**004*${user.wmy_number}#` : '';
  return `
<section class="card">
  <h1>${user.wmy_number ? 'Settings' : 'Connect your phone'}</h1>
  ${flash(error)}${flash(notice, 'ok')}
  <form method="post" action="/setup">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <label>Business name <span class="muted">(optional)</span>
      <input name="business_name" value="${esc(user.business_name)}" placeholder="e.g. Dave's Plumbing"></label>
    <label>Your mobile number
      <input name="mobile" type="tel" required value="${esc(user.mobile)}" placeholder="07700 900123"></label>

    <fieldset>
      <legend>How should calls reach We Missed You?</legend>
      <label class="choice"><input type="radio" name="mode" value="forward" ${user.mode !== 'business' ? 'checked' : ''}>
        <span><b>Keep my number</b><br><span class="muted">Unanswered calls on your mobile forward to us. Customers keep calling the number they already have.</span></span></label>
      <label class="choice"><input type="radio" name="mode" value="business" ${user.mode === 'business' ? 'checked' : ''}>
        <span><b>Give me a business number</b><br><span class="muted">Customers call your new business number. We ring your mobile first — if you don't pick up, we message them. Your personal number stays private.</span></span></label>
    </fieldset>

    <fieldset>
      <legend>Send the message by</legend>
      <div class="toggle">
        <label><input type="radio" name="channel" value="sms" ${user.channel !== 'whatsapp' ? 'checked' : ''}><span>SMS</span></label>
        <label><input type="radio" name="channel" value="whatsapp" ${user.channel === 'whatsapp' ? 'checked' : ''}><span>WhatsApp</span></label>
      </div>
    </fieldset>

    <label>Never message these numbers <span class="muted">(optional — family, suppliers… one per line)</span>
      <textarea name="skip_numbers" rows="3" placeholder="07700 900456">${esc(user.skip_numbers)}</textarea></label>

    <button class="btn full">${user.wmy_number ? 'Save' : 'Connect'}</button>
  </form>
</section>
${
  user.wmy_number
    ? `<section class="card">
  <h2>Your We Missed You number</h2>
  <p class="number">${esc(user.wmy_number)}</p>
  ${
    user.mode === 'business'
      ? `<p>Put this number on your van, website and cards. Calls ring your mobile (${esc(user.mobile)}) for 20 seconds — if you can't answer, the caller gets your message.</p>`
      : `<p><b>One-time step:</b> on your mobile, open the phone dialler, type this code and press call:</p>
         <p class="code">${esc(forwardCode)}</p>
         <p class="muted small">This forwards calls you don't answer, reject, or miss when you have no signal. To turn it off, dial <b>##004#</b>. Works on all UK networks (EE, O2, Vodafone, Three, giffgaff…). iPhone: Settings isn't needed, just dial the code.</p>`
  }
  <form method="post" action="/test"><input type="hidden" name="_csrf" value="${esc(csrf)}">
    <button class="btn ghost full">Send a test message to my mobile</button></form>
</section>`
    : ''
}`;
};

const fmtTime = (s) => {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
};

const dashboard = ({ user, csrf, stats, calls, notice }) => `
${flash(notice, 'ok')}
<section class="stats">
  <div class="stat main"><span class="num">${stats.total || 0}</span><span class="lbl">missed calls caught</span></div>
  <div class="stat"><span class="num">${stats.week || 0}</span><span class="lbl">this week</span></div>
  <div class="stat"><span class="num">${stats.sent || 0}</span><span class="lbl">messages sent</span></div>
</section>

<section class="card">
  <div class="row">
    <h2>Your message</h2>
    <span class="pill ${user.active ? 'on' : 'off'}">${user.active ? 'ON' : 'PAUSED'} · ${user.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</span>
  </div>
  <form method="post" action="/message">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <textarea name="message" rows="4" maxlength="480" required>${esc(user.message)}</textarea>
    <p class="muted small">Tip: write <b>{business}</b> and we'll fill in your business name.</p>
    <div class="presets">
      ${[
        "Sorry I missed your call! How can I help? I'll get back to you as soon as I can.",
        "Hi, it's {business}. I'm on a job right now — reply with what you need and I'll call you back shortly.",
        'Apologies for missing you! Text me your name, address and the job, and I’ll send a quote.',
      ]
        .map((p) => `<button type="button" class="chip" data-preset="${esc(p)}">${esc(p.slice(0, 34))}…</button>`)
        .join('')}
    </div>
    <div class="row gap">
      <button class="btn">Save message</button>
      <button class="btn ghost" name="toggle" value="1">${user.active ? 'Pause' : 'Resume'}</button>
    </div>
  </form>
</section>

<section class="card">
  <h2>Recent missed calls</h2>
  ${
    calls.length
      ? `<ul class="calls">${calls
          .map(
            (c) => `<li><span>${esc(c.caller)}</span><span class="muted">${esc(fmtTime(c.created_at))}</span>
              <span class="pill ${c.status === 'sent' ? 'on' : 'off'}">${esc(c.status)}</span></li>`
          )
          .join('')}</ul>`
      : `<p class="muted">No missed calls yet. When someone calls and you can't answer, they'll show up here.</p>`
  }
</section>
${user.stripe_customer ? `<form method="post" action="/billing/portal" class="center"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Manage billing</button></form>` : ''}
<script>
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
  document.querySelector('textarea[name=message]').value = b.dataset.preset;
});
</script>`;

const notFound = () => `<section class="card narrow center"><h1>Not found</h1><p><a href="/">Go home</a></p></section>`;

module.exports = { layout, home, signup, login, pay, setup, dashboard, notFound };
