// Access control for Fit Cube ERP.
//
// Design notes, because the constraints here are unusual:
//  * There is no email server and no password-reset flow, so the owner can
//    reset a staff password from inside the app and nobody can lock
//    themselves out permanently — except the owner, who is warned about that.
//  * Sessions are stored server-side rather than being self-contained tokens,
//    so removing someone (or signing out a lost phone) takes effect at once.
//  * Passwords are hashed with scrypt from node's own crypto module. No extra
//    dependency to install, and it's deliberately slow, which is what makes
//    guessing expensive.
const crypto = require('crypto');
const { db } = require('./db/client');

const SESSION_COOKIE = 'fc_session';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

// ---------- passwords ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  let expected;
  try {
    expected = Buffer.from(hash, 'hex');
  } catch (err) {
    return false;
  }
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  // Constant-time compare so a wrong password can't be narrowed down by
  // measuring how long the comparison took.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// A password rule that's strict enough to matter but not so fussy that it
// pushes someone towards writing it on a sticky note.
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 200) return 'That password is too long.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number.';
  }
  const weak = ['password1', '12345678', 'fitcube1', 'qwerty123', 'password123'];
  if (weak.includes(password.toLowerCase())) return 'That password is too easy to guess.';
  return null;
}

function usernameProblem(username) {
  if (typeof username !== 'string') return 'Username is required.';
  const u = username.trim();
  if (u.length < 3) return 'Username must be at least 3 characters.';
  if (u.length > 40) return 'Username is too long.';
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) return 'Username can only use letters, numbers, dots, dashes and underscores.';
  return null;
}

// ---------- session tokens ----------

// The cookie carries `<id>.<secret>`. Only a hash of the secret is stored, so
// a leaked copy of the database still doesn't let anyone mint a valid cookie.
function newSessionToken() {
  const id = crypto.randomBytes(12).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  return { id, secret, cookie: `${id}.${secret}`, secretHash: sha256(secret) };
}

function sha256(v) {
  return crypto.createHash('sha256').update(v).digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

async function createSession(userId, userAgent) {
  const { id, cookie, secretHash } = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  // The stored key is `<id>:<hash of the secret>`. The cookie holds the raw
  // secret, so the row alone can't be turned back into a working cookie.
  await db.execute({
    sql: 'INSERT INTO auth_sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
    args: [`${id}:${secretHash}`, userId, expires, (userAgent || '').slice(0, 300)],
  });
  return { cookie, expires };
}

async function lookupSession(cookieValue) {
  if (!cookieValue || !cookieValue.includes('.')) return null;
  const [id, secret] = cookieValue.split('.');
  if (!id || !secret) return null;
  const row = (
    await db.execute({
      sql: `SELECT s.id as sid, s.user_id, s.expires_at, u.username, u.display_name, u.role, u.active
            FROM auth_sessions s JOIN users u ON u.id = s.user_id
            WHERE s.id = ?`,
      args: [`${id}:${sha256(secret)}`],
    })
  ).rows[0];
  if (!row) return null;
  if (!row.active) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.execute({ sql: 'DELETE FROM auth_sessions WHERE id = ?', args: [row.sid] });
    return null;
  }
  return {
    sessionId: row.sid,
    id: Number(row.user_id),
    username: row.username,
    display_name: row.display_name,
    role: row.role,
  };
}

async function destroySession(sessionId) {
  if (!sessionId) return;
  await db.execute({ sql: 'DELETE FROM auth_sessions WHERE id = ?', args: [sessionId] });
}

async function destroyAllSessionsForUser(userId) {
  await db.execute({ sql: 'DELETE FROM auth_sessions WHERE user_id = ?', args: [userId] });
}

function sessionCookieHeader(value, { clear = false, req = null } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${clear ? '' : value}`,
    'Path=/',
    'HttpOnly',   // JavaScript on the page can never read the session
    'SameSite=Lax', // another site can't make the browser use it
  ];
  // Marked Secure whenever the request actually arrived over https (Render
  // terminates TLS in front of the app, hence `trust proxy`). Deciding from
  // the request rather than NODE_ENV means the flag is right on the live site
  // even if the environment isn't labelled the way we expect, and absent on
  // plain-http local development, where it would break sign-in entirely.
  const secure = req ? req.secure || req.headers['x-forwarded-proto'] === 'https' : process.env.NODE_ENV === 'production';
  if (secure) parts.push('Secure');
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${SESSION_DAYS * 86400}`);
  return parts.join('; ');
}

// ---------- brute-force protection ----------

// In-memory, per username+IP. A restart clears it, which is fine: the point
// is to make online guessing impractically slow, and scrypt already makes
// each attempt expensive.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

function attemptKey(req, username) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  return `${ip}|${String(username || '').toLowerCase()}`;
}

function lockoutRemainingMs(req, username) {
  const rec = attempts.get(attemptKey(req, username));
  if (!rec || rec.count < MAX_ATTEMPTS) return 0;
  const remaining = rec.until - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailedAttempt(req, username) {
  const key = attemptKey(req, username);
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  rec.until = Date.now() + LOCKOUT_MS;
  attempts.set(key, rec);
}

function clearAttempts(req, username) {
  attempts.delete(attemptKey(req, username));
}

// ---------- users ----------

async function userCount() {
  return Number((await db.execute('SELECT COUNT(*) as n FROM users')).rows[0].n);
}

async function findUserByUsername(username) {
  return (
    await db.execute({
      sql: 'SELECT * FROM users WHERE username = ? COLLATE NOCASE',
      args: [String(username || '').trim()],
    })
  ).rows[0];
}

async function createUser({ username, displayName, password, role }) {
  const result = await db.execute({
    sql: 'INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)',
    args: [String(username).trim(), String(displayName).trim(), hashPassword(password), role],
  });
  return Number(result.lastInsertRowid);
}

// ---------- activity ----------

async function logActivity(user, action, summary) {
  try {
    await db.execute({
      sql: 'INSERT INTO activity_log (user_id, username, action, summary) VALUES (?, ?, ?, ?)',
      args: [user ? user.id : null, user ? user.username : null, action, summary || null],
    });
  } catch (err) {
    // Never let bookkeeping break the actual request.
  }
}

module.exports = {
  SESSION_COOKIE,
  SESSION_DAYS,
  hashPassword,
  verifyPassword,
  passwordProblem,
  usernameProblem,
  parseCookies,
  createSession,
  lookupSession,
  destroySession,
  destroyAllSessionsForUser,
  sessionCookieHeader,
  lockoutRemainingMs,
  recordFailedAttempt,
  clearAttempts,
  userCount,
  findUserByUsername,
  createUser,
  logActivity,
};
