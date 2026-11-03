// The core job: someone called, nobody answered -> send them the user's message.
const db = require('./db');
const twilio = require('./twilio');
const { ownerOf, usage } = require('./plans');

/** Normalise UK-style input to E.164 (+44...). Leaves other + numbers alone. */
function toE164(input, defaultCc = process.env.DEFAULT_COUNTRY_CODE || '44') {
  let n = String(input || '').replace(/^whatsapp:/, '').replace(/[^\d+]/g, '');
  if (!n) return '';
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (n.startsWith('+')) return n;
  if (n.startsWith('0')) return `+${defaultCc}${n.slice(1)}`;
  return `+${n}`;
}
const validE164 = (n) => /^\+[1-9]\d{8,14}$/.test(n);
const isWithheld = (n) => !validE164(n) || ['+266696687', '+86282452253', '+8656696'].includes(n);

const render = (user) => (user.message || '').replaceAll('{business}', user.business_name || user.name).trim();

/** Handle one missed call. Never throws: telephony webhooks must answer fast. */
async function handleMissedCall(user, rawCaller) {
  const caller = toE164(rawCaller);
  const owner = ownerOf(user);
  if (!owner?.paid || !user.active) return log(user, caller || 'unknown', 'skipped', 'inactive');
  if (isWithheld(caller)) return log(user, 'Withheld', 'skipped', 'no caller ID');
  if (caller === user.mobile) return log(user, caller, 'skipped', 'own number');

  const skip = String(user.skip_numbers || '').split(/[\n,]+/).map((s) => toE164(s)).filter(Boolean);
  if (skip.includes(caller)) return log(user, caller, 'skipped', 'on do-not-message list');
  if (db.textedRecently(user.id, caller)) return log(user, caller, 'skipped', 'already messaged in last 12h');
  if (usage(owner).left <= 0) return log(user, caller, 'skipped', 'monthly text limit reached');

  try {
    const res = await twilio.sendMessage({ channel: user.channel, from: user.wmy_number, to: caller, body: render(user) });
    return log(user, caller, 'sent', res.sid);
  } catch (err) {
    console.error('send failed', err.message);
    return log(user, caller, 'failed', err.message.slice(0, 200));
  }
}

/** A customer replied to our message: pass it straight to the tradesperson's mobile. */
async function handleReply({ to, from, body }) {
  const caller = toE164(from);
  const isWhatsApp = String(from).startsWith('whatsapp:');
  // SMS replies arrive on the user's own number; WhatsApp replies arrive on the shared sender.
  let user = isWhatsApp ? null : db.userByNumber(toE164(to));
  if (!user) { const last = db.lastCallTo(caller); user = last && db.userById(last.user_id); }
  if (!user || !user.mobile || !ownerOf(user)?.paid) return false;
  db.markReplied(user.id, caller);
  const text = `We Missed You: reply from ${caller}${isWhatsApp ? ' (WhatsApp)' : ''}:\n"${String(body).slice(0, 600)}"\nCall or text them back on ${caller}`;
  await twilio.sendMessage({ channel: 'sms', from: user.wmy_number, to: user.mobile, body: text }).catch((e) => console.error('reply forward failed', e.message));
  return true;
}

function log(user, caller, status, detail) {
  db.logCall(user.id, caller, user.channel, status, detail);
  return status;
}

module.exports = { handleMissedCall, handleReply, toE164, validE164, render };
