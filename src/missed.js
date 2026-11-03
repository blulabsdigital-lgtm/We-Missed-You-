// The core job: someone called, nobody answered -> send them the user's message.
const db = require('./db');
const twilio = require('./twilio');

/** Normalise UK-style input to E.164 (+44...). Leaves other + numbers alone. */
function toE164(input, defaultCc = process.env.DEFAULT_COUNTRY_CODE || '44') {
  let n = String(input || '').replace(/[^\d+]/g, '');
  if (!n) return '';
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (n.startsWith('+')) return n;
  if (n.startsWith('0')) return `+${defaultCc}${n.slice(1)}`;
  if (n.startsWith(defaultCc)) return `+${n}`;
  return `+${n}`;
}

const isWithheld = (n) => !n || !/^\+\d{7,15}$/.test(n) || ['+266696687', '+86282452253', '+8656696'].includes(n);

const render = (user) =>
  (user.message || '').replaceAll('{business}', user.business_name || user.name).trim();

/**
 * Handle one missed call for a user. Returns the logged status.
 * Never throws — telephony webhooks must always answer quickly.
 */
async function handleMissedCall(user, rawCaller) {
  const caller = toE164(rawCaller);
  if (!user.paid || !user.active) return log(user, caller || 'unknown', 'skipped', 'inactive');
  if (isWithheld(caller)) return log(user, 'Withheld', 'skipped', 'no caller ID');
  if (caller === user.mobile) return log(user, caller, 'skipped', 'own number');

  const skip = String(user.skip_numbers || '').split(/[\n,]+/).map((s) => toE164(s)).filter(Boolean);
  if (skip.includes(caller)) return log(user, caller, 'skipped', 'on do-not-message list');
  if (db.textedRecently(user.id, caller)) return log(user, caller, 'skipped', 'already messaged in last 12h');

  try {
    const res = await twilio.sendMessage({ channel: user.channel, from: user.wmy_number, to: caller, body: render(user) });
    return log(user, caller, 'sent', res.sid);
  } catch (err) {
    console.error('send failed', err.message);
    return log(user, caller, 'failed', err.message);
  }
}

function log(user, caller, status, detail) {
  db.logCall(user.id, caller, user.channel, status, detail);
  return status;
}

module.exports = { handleMissedCall, toE164, render };
