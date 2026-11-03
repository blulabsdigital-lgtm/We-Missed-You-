// End-to-end: sign up -> pay (dev) -> connect -> missed call -> message logged -> dashboard count.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmy-')), 't.db');
const app = require('../src/server');

test('full flow', async () => {
  const srv = app.listen(0); const base = `http://localhost:${srv.address().port}`;
  let cookie = '';
  const go = async (p, body) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body && new URLSearchParams(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, loc: r.headers.get('location'), text: await r.text() };
  };
  let r = await go('/signup', { name: 'Dave Smith', email: 'dave@example.com', password: 'password123' });
  assert.equal(r.loc, '/pay');
  assert.equal((await go('/dashboard')).loc, '/pay', 'locked until paid');
  const csrf = (await go('/pay')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal((await go('/pay', { _csrf: csrf })).loc, '/setup');
  r = await go('/setup', { _csrf: csrf, mobile: '07700 900123', mode: 'business', channel: 'whatsapp', business_name: "Dave's Plumbing" });
  assert.equal(r.loc, '/setup?saved=1');
  const page = (await go('/setup')).text; const num = page.match(/class="number">([^<]+)/)[1];
  assert.match(page, /\+447700900123/);

  // Business mode: call rings mobile first
  r = await go('/twilio/voice', { To: num, From: '+447911123456', CallSid: 'CA1' });
  assert.match(r.text, /<Dial[^>]*><Number url="\/twilio\/screen">\+447700900123/);
  // Not answered -> message fires
  r = await go('/twilio/after-dial', { To: num, From: '+447911123456', CallSid: 'CA1', DialCallStatus: 'no-answer' });
  assert.match(r.text, /sent you a message/);
  // Answered (key pressed) -> no message
  await go('/twilio/screen/ok', { ParentCallSid: 'CA2' });
  r = await go('/twilio/after-dial', { To: num, From: '+447911999999', CallSid: 'CA2', DialCallStatus: 'completed' });
  assert.match(r.text, /<Hangup\/>/); assert.doesNotMatch(r.text, /message/);
  // Same caller again within 12h -> skipped (no spam)
  await go('/twilio/after-dial', { To: num, From: '+447911123456', CallSid: 'CA3' });
  await new Promise((s) => setTimeout(s, 50));

  const dash = (await go('/dashboard')).text;
  assert.match(dash, /<span class="num">2<\/span><span class="lbl">missed calls caught/);
  assert.match(dash, /<span class="num">1<\/span><span class="lbl">messages sent/);
  r = await go('/message', { _csrf: csrf, message: 'Hi from {business}!' });
  assert.match((await go('/dashboard')).text, /Hi from \{business\}!/);
  srv.close();
});
