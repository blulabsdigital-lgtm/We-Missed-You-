// Thin Twilio client over fetch — no SDK needed.
// If TWILIO_* env vars are missing, runs in DEV mode: messages are logged, not sent.
const crypto = require('node:crypto');

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. +447700900000 (approved WhatsApp sender)
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
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Twilio ${res.status}`);
  return json;
}

/** Send the missed-call message. channel: 'sms' | 'whatsapp' */
async function sendMessage({ channel, from, to, body }) {
  if (!enabled) {
    console.log(`[DEV] would send ${channel} from ${from} to ${to}: ${body}`);
    return { sid: 'DEV', dev: true };
  }
  const params =
    channel === 'whatsapp'
      ? { From: `whatsapp:${WHATSAPP_FROM || from}`, To: `whatsapp:${to}`, Body: body }
      : { From: from, To: to, Body: body };
  return api('/Messages.json', params);
}

/** Buy a local number for a user and point its voice webhook at us. */
async function provisionNumber(publicUrl) {
  if (!enabled) {
    // Fake number for local testing.
    return `+4470000${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  }
  const found = await api(`/AvailablePhoneNumbers/${COUNTRY}/Mobile.json`, { SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '1' }, 'GET')
    .catch(() => api(`/AvailablePhoneNumbers/${COUNTRY}/Local.json`, { SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '1' }, 'GET'));
  const pick = found.available_phone_numbers?.[0];
  if (!pick) throw new Error('No numbers available right now — try again shortly.');
  const bought = await api('/IncomingPhoneNumbers.json', {
    PhoneNumber: pick.phone_number,
    VoiceUrl: `${publicUrl}/twilio/voice`,
    VoiceMethod: 'POST',
    ...(process.env.TWILIO_ADDRESS_SID ? { AddressSid: process.env.TWILIO_ADDRESS_SID } : {}),
    ...(process.env.TWILIO_BUNDLE_SID ? { BundleSid: process.env.TWILIO_BUNDLE_SID } : {}),
  });
  return bought.phone_number;
}

/** Verify X-Twilio-Signature so nobody can fake calls to our webhook. */
function validRequest(req, publicUrl) {
  if (!enabled) return true;
  const sig = req.headers['x-twilio-signature'];
  if (!sig) return false;
  const url = publicUrl + req.originalUrl;
  const data = Object.keys(req.body || {}).sort().reduce((s, k) => s + k + req.body[k], url);
  const expected = crypto.createHmac('sha1', TOKEN).update(data).digest('base64');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { enabled, sendMessage, provisionNumber, validRequest };
