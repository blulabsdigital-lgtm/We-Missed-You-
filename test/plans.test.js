const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmy-')), 't.db');
process.env.SOLO_TEXTS = '2';
const app = require('../src/server');
const db = require('../src/db');

function client(base) {
  let cookie = '';
  const go = async (p, body) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body && new URLSearchParams(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, loc: r.headers.get('location'), text: await r.text(), headers: r.headers };
  };
  go.csrf = async (p) => (await go(p)).text.match(/name="_csrf" value="([^"]+)"/)[1];
  return go;
}

test('plans, teams, limits, replies, security', async () => {
  const srv = app.listen(0); const base = `http://localhost:${srv.address().port}`;
  const owner = client(base);
  await owner('/signup', { name: 'Olly Owner', email: 'olly@example.com', password: 'password123' });
  let csrf = await owner.csrf('/pay');

  // CSRF required
  assert.equal((await owner('/pay', { plan: 'team' })).status, 403);
  // Security headers
  const h = (await owner('/pay')).headers;
  assert.match(h.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(h.get('x-frame-options'), 'DENY');

  // Solo plan, text limit of 2 (test env)
  await owner('/pay', { _csrf: csrf, plan: 'solo', interval: 'year' });
  await owner('/setup', { _csrf: csrf, mobile: '07700900001', mode: 'forward', channel: 'sms' });
  const u = db.userByEmail('olly@example.com');
  assert.equal(u.plan, 'solo'); assert.equal(u.billing_interval, 'year');
  for (const n of ['+447911000001', '+447911000002', '+447911000003'])
    await owner('/twilio/voice', { To: u.wmy_number, From: n, CallSid: 'x' + n });
  await new Promise((s) => setTimeout(s, 50));
  const calls = db.recentCalls(u.id);
  assert.equal(calls.filter((c) => c.status === 'sent').length, 2);
  assert.equal(calls[0].detail, 'monthly text limit reached');
  assert.match((await owner('/dashboard')).text, /Limit reached/);

  // Customer reply is forwarded and marked
  await owner('/twilio/sms', { To: u.wmy_number, From: '+447911000001', Body: 'Need a boiler fixed' });
  assert.match((await owner('/dashboard')).text, />replied</);

  // Upgrade to Team -> invite -> member joins
  assert.equal((await owner('/team')).loc, '/account');
  assert.equal((await owner('/account/plan', { _csrf: csrf, plan: 'team' })).loc, '/team');
  let r = await owner('/team/invite', { _csrf: csrf, name: 'Mia Member', email: 'mia@example.com' });
  const link = r.text.match(/\/join\?token=([\w-]+)/)[1];

  // Pending invite cannot log in, even with the dummy password
  const evil = client(base);
  assert.equal((await evil('/login', { email: 'mia@example.com', password: 'timing-equaliser' })).status, 401);

  const mia = client(base);
  assert.equal((await mia(`/join?token=${link}`)).status, 200);
  assert.equal((await mia('/join', { token: link, password: 'miapassword' })).loc, '/setup');
  assert.equal((await mia('/join', { token: link, password: 'again12345' })).status, 400, 'token is single-use');
  const mcsrf = await mia.csrf('/setup');
  await mia('/setup', { _csrf: mcsrf, mobile: '07700900002', mode: 'business', channel: 'whatsapp' });
  assert.match((await mia('/dashboard')).text, /missed calls caught/);
  assert.equal((await mia('/team')).loc, '/dashboard', 'members cannot manage team');
  assert.equal((await mia('/pay', { _csrf: mcsrf, plan: 'solo' })).loc, '/dashboard', 'members cannot change billing');

  // Seats: 5 included, 6th person adds an extra seat
  for (let i = 0; i < 4; i++) await owner('/team/invite', { _csrf: csrf, name: 'P' + i, email: `p${i}@example.com` });
  assert.equal(db.userByEmail('olly@example.com').extra_seats, 1);
  const p3 = db.userByEmail('p3@example.com');
  await owner('/team/remove', { _csrf: csrf, id: String(p3.id) });
  assert.equal(db.userByEmail('olly@example.com').extra_seats, 0);

  // Password change logs out other sessions
  const second = client(base);
  await second('/login', { email: 'olly@example.com', password: 'password123' });
  assert.equal((await second('/dashboard')).status, 200);
  await owner('/account/password', { _csrf: csrf, current: 'password123', password: 'newpassword1' });
  assert.equal((await second('/dashboard')).loc, '/login');
  csrf = await owner.csrf('/account');

  // Reset flow never reveals whether an email exists
  const a = await client(base)('/forgot', { email: 'nobody@example.com' });
  const b = await client(base)('/forgot', { email: 'olly@example.com' });
  assert.equal(a.text, b.text);

  // Delete owner removes the whole team
  await owner('/account/delete', { _csrf: csrf, confirm: 'DELETE' });
  assert.equal(db.userByEmail('olly@example.com'), undefined);
  assert.equal(db.userByEmail('mia@example.com'), undefined);

  // Login rate limit
  const brute = client(base); let last;
  for (let i = 0; i < 12; i++) last = await brute('/login', { email: 'x@example.com', password: 'wrongwrong' });
  assert.equal(last.status, 429);
  srv.close();
});
