// Thin Twilio client over fetch — no SDK needed.
// If TWILIO_* env vars are missing, runs in DEV mode: messages are logged, not sent.
const crypto = require('node:crypto');

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // shared, Meta-approved WhatsApp sender (E.164)
const COUNTRY = process.env.TWILIO_NUMBER_COUNTRY || 'GB';
const enabled = !!(SID && TOKEN);

async function api(path, params, method = 'POST') {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}${path}`;
  const body = params ? new URLSearchParams(params) : undefined;
  const res = await fetch(method === 'GET' && body ? `${url}?${body}` : url, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? body : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Twilio ${res.status}`);
  return json;
}

/** channel: 'sms' | 'whatsapp' */
async function sendMessage({ channel, from, to, body }) {
  if (!enabled) {
    console.log(`[DEV] would send ${channel} from ${from} to ${to}: ${body}`);
    return { sid: 'DEV', dev: true };
  }
  const params = channel === 'whatsapp'
    ? { From: `whatsapp:${WHATSAPP_FROM || from}`, To: `whatsapp:${to}`, Body: body }
    : { From: from, To: to, Body: body };
  return api('/Messages.json', params);
}

/** Buy a number and point its voice + SMS webhooks at us. Returns { number, sid }. */
async function provisionNumber(publicUrl) {
  if (!enabled) {
    return { number: `+4470000${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`, sid: null };
  }
  const search = (type) => api(`/AvailablePhoneNumbers/${COUNTRY}/${type}.json`, { SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '1' }, 'GET');
  const found = await search('Mobile').catch(() => search('Local'));
  const pick = found.available_phone_numbers?.[0];
  if (!pick) throw new Error('No numbers available right now. Please try again in a minute.');
  const bought = await api('/IncomingPhoneNumbers.json', {
    PhoneNumber: pick.phone_number,
    FriendlyName: 'We Missed You',
    VoiceUrl: `${publicUrl}/twilio/voice`, VoiceMethod: 'POST',
    SmsUrl: `${publicUrl}/twilio/sms`, SmsMethod: 'POST',
    ...(process.env.TWILIO_ADDRESS_SID ? { AddressSid: process.env.TWILIO_ADDRESS_SID } : {}),
    ...(process.env.TWILIO_BUNDLE_SID ? { BundleSid: process.env.TWILIO_BUNDLE_SID } : {}),
  });
  return { number: bought.phone_number, sid: bought.sid };
}

/** Give a number back to Twilio so we stop paying for it. */
async function releaseNumber(sid) {
  if (!enabled || !sid) return;
  await api(`/IncomingPhoneNumbers/${sid}.json`, null, 'DELETE').catch((e) => console.error('release failed', sid, e.message));
}

/** Verify X-Twilio-Signature so nobody can fake calls to our webhooks. */
function validRequest(req, publicUrl) {
  if (!enabled) return true;
  const sig = String(req.headers['x-twilio-signature'] || '');
  if (!sig) return false;
  const data = Object.keys(req.body || {}).sort().reduce((s, k) => s + k + req.body[k], publicUrl + req.originalUrl);
  const expected = crypto.createHmac('sha1', TOKEN).update(data).digest('base64');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { enabled, sendMessage, provisionNumber, releaseNumber, validRequest };
