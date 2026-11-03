// Password hashing + signed session cookie, using only node:crypto.
const crypto = require('node:crypto');

const SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const COOKIE = 'wmy_session';
const MAX_AGE_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');

function setSession(res, userId) {
  const exp = Date.now() + MAX_AGE_DAYS * 864e5;
  const value = `${userId}.${exp}`;
  res.cookie(COOKIE, `${value}.${sign(value)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_DAYS * 864e5,
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE);
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const expected = sign(`${id}.${exp}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now()) return null;
  return Number(id);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

// Simple CSRF token tied to the session id.
const csrfToken = (userId) => sign(`csrf:${userId}`);

module.exports = { hashPassword, checkPassword, setSession, clearSession, readSession, csrfToken };
