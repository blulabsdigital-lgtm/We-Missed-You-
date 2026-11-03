// SQLite via Node's built-in driver (no native deps, zero cost).
// Swap for Postgres/Supabase later by re-implementing these functions.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const file = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'wmy.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    paid            INTEGER NOT NULL DEFAULT 0,
    stripe_customer TEXT,
    business_name   TEXT,
    mobile          TEXT,
    wmy_number      TEXT UNIQUE,
    mode            TEXT NOT NULL DEFAULT 'forward',
    channel         TEXT NOT NULL DEFAULT 'sms',
    message         TEXT NOT NULL DEFAULT 'Sorry I missed your call! How can I help? I''ll get back to you as soon as I can.',
    active          INTEGER NOT NULL DEFAULT 1,
    skip_numbers    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    caller      TEXT NOT NULL,
    channel     TEXT,
    status      TEXT NOT NULL,          -- 'sent' | 'failed' | 'skipped'
    detail      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS calls_user ON calls(user_id, created_at);
  CREATE INDEX IF NOT EXISTS calls_caller ON calls(caller, created_at);
`);

// Additive migrations: safe to run on every boot.
function addColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
addColumn('users', 'team_owner_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'); // null = account owner
addColumn('users', 'plan', "TEXT NOT NULL DEFAULT 'solo'");        // 'solo' | 'team' (owner only)
addColumn('users', 'billing_interval', "TEXT NOT NULL DEFAULT 'month'");
addColumn('users', 'stripe_subscription', 'TEXT');
addColumn('users', 'extra_seats', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'wmy_number_sid', 'TEXT');
addColumn('users', 'session_version', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'token_hash', 'TEXT');                          // password reset / invite
addColumn('users', 'token_expires', 'INTEGER');
addColumn('calls', 'replied', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS users_team ON users(team_owner_id)');
db.exec('CREATE INDEX IF NOT EXISTS users_token ON users(token_hash)');

const q = (sql) => db.prepare(sql);

const USER_FIELDS = ['name', 'password_hash', 'business_name', 'mobile', 'wmy_number', 'wmy_number_sid', 'mode', 'channel',
  'message', 'active', 'skip_numbers', 'plan', 'billing_interval', 'stripe_subscription', 'extra_seats',
  'token_hash', 'token_expires', 'session_version'];

module.exports = {
  db,
  createUser: (name, email, hash, teamOwnerId = null) =>
    Number(q('INSERT INTO users (name, email, password_hash, team_owner_id) VALUES (?, ?, ?, ?)').run(name, email, hash, teamOwnerId).lastInsertRowid),
  userById: (id) => q('SELECT * FROM users WHERE id = ?').get(id),
  userByEmail: (email) => q('SELECT * FROM users WHERE email = ?').get(email),
  userByNumber: (num) => q('SELECT * FROM users WHERE wmy_number = ?').get(num),
  userByCustomer: (cus) => q('SELECT * FROM users WHERE stripe_customer = ? AND team_owner_id IS NULL').get(cus),
  userByToken: (hash) => q('SELECT * FROM users WHERE token_hash = ? AND token_expires > ?').get(hash, Date.now()),
  setPaid: (id, paid, customer) =>
    q('UPDATE users SET paid = ?, stripe_customer = COALESCE(?, stripe_customer) WHERE id = ?').run(paid ? 1 : 0, customer ?? null, id),
  updateUser: (id, fields) => {
    const keys = Object.keys(fields).filter((k) => USER_FIELDS.includes(k));
    if (!keys.length) return;
    q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  },
  deleteUser: (id) => { q('DELETE FROM calls WHERE user_id = ?').run(id); q('DELETE FROM users WHERE id = ?').run(id); },

  // Teams: the owner row holds billing; members point at it.
  teamMembers: (ownerId) => q('SELECT * FROM users WHERE team_owner_id = ? ORDER BY id').all(ownerId),
  teamIds: (ownerId) => [ownerId, ...q('SELECT id FROM users WHERE team_owner_id = ?').all(ownerId).map((r) => r.id)],

  logCall: (userId, caller, channel, status, detail) =>
    q('INSERT INTO calls (user_id, caller, channel, status, detail) VALUES (?, ?, ?, ?, ?)').run(userId, caller, channel, status, detail ?? null),
  recentCalls: (userId, limit = 25) => q('SELECT * FROM calls WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit),
  stats: (userId) =>
    q(`SELECT COUNT(*) AS total, SUM(created_at >= datetime('now', '-7 days')) AS week, SUM(status = 'sent') AS sent
       FROM calls WHERE user_id = ? AND detail IS NOT 'test'`).get(userId),
  memberStats: (userId) =>
    q(`SELECT COUNT(*) AS total, SUM(status = 'sent' AND created_at >= datetime('now', 'start of month')) AS month
       FROM calls WHERE user_id = ?`).get(userId),
  // Messages sent this calendar month across a whole account (owner + members).
  sentThisMonth: (ids) =>
    q(`SELECT COUNT(*) AS n FROM calls WHERE status = 'sent' AND created_at >= datetime('now', 'start of month')
       AND user_id IN (${ids.map(() => '?').join(',')})`).get(...ids).n,
  textedRecently: (userId, caller, hours = 12) =>
    !!q(`SELECT 1 FROM calls WHERE user_id = ? AND caller = ? AND status = 'sent'
         AND created_at >= datetime('now', ?) LIMIT 1`).get(userId, caller, `-${hours} hours`),
  // Who did we last message from this caller? (routes replies on the shared WhatsApp sender)
  lastCallTo: (caller) =>
    q(`SELECT * FROM calls WHERE caller = ? AND status = 'sent' AND created_at >= datetime('now', '-30 days') ORDER BY id DESC LIMIT 1`).get(caller),
  markReplied: (userId, caller) =>
    q(`UPDATE calls SET replied = 1 WHERE id = (SELECT id FROM calls WHERE user_id = ? AND caller = ? AND status = 'sent' ORDER BY id DESC LIMIT 1)`).run(userId, caller),
};
