// Passwords, sessions, CSRF, tokens and rate limiting, using only node:crypto.
const crypto = require('node:crypto');

const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || (PROD ? null : 'dev-only-change-me');
if (!SECRET || (PROD && SECRET.length < 32)) {
  console.error('SESSION_SECRET must be set to a random string of 32+ characters in production.');
  process.exit(1);
}
const COOKIE = PROD ? '__Host-wmy' : 'wmy_session'; // __Host- = HTTPS-only, no domain spoofing
const MAX_AGE = 30 * 864e5;

// scrypt with explicit cost params (N=16384, r=8, p=1 is the OWASP baseline).
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64, SCRYPT).toString('hex')}`;
}
const DUMMY = hashPassword('timing-equaliser');
function checkPassword(pw, stored) {
  // Always do the scrypt work (even for unknown users) so timing doesn't reveal which emails exist.
  const [salt, hash] = String(stored || DUMMY).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  const real = Buffer.from(hash, 'hex');
  return !!stored && real.length === test.length && crypto.timingSafeEqual(real, test);
}

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Cookie = id.version.expiry.sig. Bumping users.session_version logs out every device.
function setSession(res, user) {
  const value = `${user.id}.${user.session_version || 0}.${Date.now() + MAX_AGE}`;
  res.cookie(COOKIE, `${value}.${sign(value)}`, { httpOnly: true, sameSite: 'lax', secure: PROD, path: '/', maxAge: MAX_AGE });
}
const clearSession = (res) => res.clearCookie(COOKIE, { path: '/', secure: PROD, httpOnly: true, sameSite: 'lax' });

function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  const parts = raw ? raw.split('.') : [];
  if (parts.length !== 4) return null;
  const [id, ver, exp, sig] = parts;
  if (!safeEq(sig, sign(`${id}.${ver}.${exp}`)) || Number(exp) < Date.now()) return null;
  return { id: Number(id), version: Number(ver) };
}

function parseCookies(header = '') {
  const out = {};
  for (const c of header.split(';')) {
    const i = c.indexOf('=');
    if (i > 0) try { out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  return out;
}

const csrfToken = (user) => sign(`csrf:${user.id}:${user.session_version || 0}`);
const csrfOk = (user, token) => !!user && typeof token === 'string' && safeEq(token, csrfToken(user));

// One-time tokens (password reset, team invites): we store only the hash.
function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Tiny in-memory rate limiter (fine for a single server).
const hits = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const k = `${req.path}:${key(req)}`;
    const now = Date.now();
    const h = hits.get(k);
    if (!h || now > h.reset) hits.set(k, { n: 1, reset: now + windowMs });
    else if (++h.n > max) {
      res.set('Retry-After', Math.ceil((h.reset - now) / 1000));
      return res.status(429).type('text').send('Too many attempts. Please wait a few minutes and try again.');
    }
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60000).unref();

module.exports = { hashPassword, checkPassword, setSession, clearSession, readSession, csrfToken, csrfOk, newToken, hashToken, rateLimit };
