// SQLite via Node's built-in driver (no native deps, zero cost).
// Swap for Postgres/Supabase later by re-implementing these few functions.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const file = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'wmy.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    paid            INTEGER NOT NULL DEFAULT 0,
    stripe_customer TEXT,
    business_name   TEXT,
    mobile          TEXT,              -- the tradesperson's own phone (E.164)
    wmy_number      TEXT UNIQUE,       -- the Twilio number assigned to them
    mode            TEXT NOT NULL DEFAULT 'forward',   -- 'forward' | 'business'
    channel         TEXT NOT NULL DEFAULT 'sms',       -- 'sms' | 'whatsapp'
    message         TEXT NOT NULL DEFAULT 'Sorry I missed your call! How can I help? I''ll get back to you as soon as I can.',
    active          INTEGER NOT NULL DEFAULT 1,
    skip_numbers    TEXT,              -- numbers never to message, one per line
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    caller      TEXT NOT NULL,
    channel     TEXT,
    status      TEXT NOT NULL,          -- 'sent' | 'failed' | 'skipped'
    detail      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS calls_user ON calls(user_id, created_at);
`);

const q = (sql) => db.prepare(sql);

module.exports = {
  db,
  createUser: (name, email, hash) =>
    q('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, hash).lastInsertRowid,
  userById: (id) => q('SELECT * FROM users WHERE id = ?').get(id),
  userByEmail: (email) => q('SELECT * FROM users WHERE email = ?').get(email),
  userByNumber: (num) => q('SELECT * FROM users WHERE wmy_number = ?').get(num),
  userByCustomer: (cus) => q('SELECT * FROM users WHERE stripe_customer = ?').get(cus),
  setPaid: (id, paid, customer) =>
    q('UPDATE users SET paid = ?, stripe_customer = COALESCE(?, stripe_customer) WHERE id = ?').run(paid ? 1 : 0, customer ?? null, id),
  updateUser: (id, fields) => {
    const allowed = ['business_name', 'mobile', 'wmy_number', 'mode', 'channel', 'message', 'active', 'skip_numbers'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  },
  logCall: (userId, caller, channel, status, detail) =>
    q('INSERT INTO calls (user_id, caller, channel, status, detail) VALUES (?, ?, ?, ?, ?)').run(userId, caller, channel, status, detail ?? null),
  recentCalls: (userId, limit = 25) =>
    q('SELECT * FROM calls WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit),
  stats: (userId) =>
    q(`SELECT
         COUNT(*) AS total,
         SUM(created_at >= datetime('now', '-7 days')) AS week,
         SUM(status = 'sent') AS sent
       FROM calls WHERE user_id = ?`).get(userId),
  // Anti-spam: did we already text this caller recently?
  textedRecently: (userId, caller, hours = 12) =>
    !!q(`SELECT 1 FROM calls WHERE user_id = ? AND caller = ? AND status = 'sent'
         AND created_at >= datetime('now', ?) LIMIT 1`).get(userId, caller, `-${hours} hours`),
};
