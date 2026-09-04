require('dotenv').config();
const path = require('path');
const express = require('express');
const { db, init } = require('./db/client');
const auth = require('./auth');

const app = express();
// Render terminates TLS in front of this app; without this, req.secure and
// the client IP used for rate limiting are both wrong.
app.set('trust proxy', 1);

// This app is only ever used from its own origin. Allowing other sites to
// call the API with credentials would hand them the whole database, so CORS
// stays off deliberately — its absence here is the correct setting, not an
// oversight.

app.use(express.json({ limit: '20mb' })); // generous limit so a full backup restore upload never gets rejected

app.use((req, res, next) => {
  // Nothing here is meant to be framed, sniffed, or used as a referrer
  // source, and the app loads no third-party code at all.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // The app's own inline handlers and styles; no external origins.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
  // Don't let this address turn up in a search engine.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// The app shell is public; it contains no data of its own. Everything that
// reads or writes actual data sits behind /api and requires a session.
app.use(express.static(PUBLIC_DIR));

const ok = (res, data) => res.json(data);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- Access control ----------

// Attach the signed-in user (if any) to every API request.
app.use('/api', async (req, res, next) => {
  const cookies = auth.parseCookies(req.headers.cookie);
  try {
    req.user = await auth.lookupSession(cookies[auth.SESSION_COOKIE]);
  } catch (err) {
    req.user = null;
  }
  next();
});

// Is this installation set up yet, and is this device signed in? This is the
// only endpoint the app can call before signing in.
app.get('/api/auth/status', async (req, res) => {
  const count = await auth.userCount();
  ok(res, {
    configured: count > 0,
    authenticated: !!req.user,
    user: req.user
      ? { id: req.user.id, username: req.user.username, display_name: req.user.display_name, role: req.user.role }
      : null,
  });
});

// First run only: creates the owner account. Refused once any account exists,
// so this can't be used later to mint a second owner.
app.post('/api/auth/setup', async (req, res) => {
  if ((await auth.userCount()) > 0) return bad(res, 'This app has already been set up. Sign in instead.', 409);
  const { username, display_name: displayName, password } = req.body || {};
  const uErr = auth.usernameProblem(username);
  if (uErr) return bad(res, uErr);
  const pErr = auth.passwordProblem(password);
  if (pErr) return bad(res, pErr);
  if (!displayName || !String(displayName).trim()) return bad(res, 'Your name is required.');

  const id = await auth.createUser({ username, displayName, password, role: 'owner' });
  const { cookie } = await auth.createSession(id, req.headers['user-agent']);
  res.setHeader('Set-Cookie', auth.sessionCookieHeader(cookie, { req }));
  await auth.logActivity({ id, username: String(username).trim() }, 'auth.setup', 'Created the owner account');
  ok(res, { id, username: String(username).trim(), display_name: String(displayName).trim(), role: 'owner' });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const waitMs = auth.lockoutRemainingMs(req, username);
  if (waitMs > 0) {
    return bad(res, `Too many failed attempts. Try again in ${Math.ceil(waitMs / 60000)} minute(s).`, 429);
  }
  const user = await auth.findUserByUsername(username);
  // Same message and roughly the same work either way, so this can't be used
  // to find out which usernames exist.
  if (!user || !user.active || !auth.verifyPassword(String(password || ''), user.password_hash)) {
    auth.recordFailedAttempt(req, username);
    return bad(res, 'Wrong username or password.', 401);
  }
  auth.clearAttempts(req, username);
  const { cookie } = await auth.createSession(Number(user.id), req.headers['user-agent']);
  await db.execute({ sql: "UPDATE users SET last_login_at = datetime('now') WHERE id = ?", args: [user.id] });
  res.setHeader('Set-Cookie', auth.sessionCookieHeader(cookie, { req }));
  await auth.logActivity({ id: Number(user.id), username: user.username }, 'auth.login', 'Signed in');
  ok(res, { id: Number(user.id), username: user.username, display_name: user.display_name, role: user.role });
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.user) await auth.destroySession(req.user.sessionId);
  res.setHeader('Set-Cookie', auth.sessionCookieHeader('', { clear: true, req }));
  ok(res, { ok: true });
});

// Everything past this point needs a signed-in user.
const requireAuth = (req, res, next) => {
  if (!req.user) return bad(res, 'Please sign in.', 401);
  next();
};
const requireOwner = (req, res, next) => {
  if (!req.user) return bad(res, 'Please sign in.', 401);
  if (req.user.role !== 'owner') return bad(res, 'Only the owner can do that.', 403);
  next();
};

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  const row = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.user.id] })).rows[0];
  if (!row || !auth.verifyPassword(String(current || ''), row.password_hash)) {
    return bad(res, 'Your current password is not right.', 401);
  }
  const pErr = auth.passwordProblem(next);
  if (pErr) return bad(res, pErr);
  await db.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
    args: [auth.hashPassword(next), req.user.id],
  });
  // Changing a password signs every other device out, which is the whole
  // point of changing it after a phone goes missing.
  await auth.destroyAllSessionsForUser(req.user.id);
  const { cookie } = await auth.createSession(req.user.id, req.headers['user-agent']);
  res.setHeader('Set-Cookie', auth.sessionCookieHeader(cookie, { req }));
  await auth.logActivity(req.user, 'auth.change_password', 'Changed their own password');
  ok(res, { ok: true });
});

// ---------- Staff accounts (owner only) ----------

app.get('/api/users', requireOwner, async (req, res) => {
  const rows = (
    await db.execute(
      `SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS active_devices
       FROM users u ORDER BY u.role = 'owner' DESC, u.display_name COLLATE NOCASE`
    )
  ).rows;
  ok(res, rows);
});

app.post('/api/users', requireOwner, async (req, res) => {
  const { username, display_name: displayName, password } = req.body || {};
  const uErr = auth.usernameProblem(username);
  if (uErr) return bad(res, uErr);
  const pErr = auth.passwordProblem(password);
  if (pErr) return bad(res, pErr);
  if (!displayName || !String(displayName).trim()) return bad(res, 'A name is required.');
  if (await auth.findUserByUsername(username)) return bad(res, 'That username is already taken.');
  const id = await auth.createUser({ username, displayName, password, role: 'staff' });
  await auth.logActivity(req.user, 'users.create', `Added staff account ${String(username).trim()}`);
  ok(res, { id, username: String(username).trim(), display_name: String(displayName).trim(), role: 'staff' });
});

app.put('/api/users/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const row = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] })).rows[0];
  if (!row) return bad(res, 'No such account.', 404);
  if (row.role === 'owner' && id !== req.user.id) return bad(res, 'You cannot change another owner account.', 403);

  const { display_name: displayName, active, password } = req.body || {};
  if (displayName !== undefined && String(displayName).trim()) {
    await db.execute({ sql: 'UPDATE users SET display_name = ? WHERE id = ?', args: [String(displayName).trim(), id] });
  }
  if (active !== undefined) {
    if (row.role === 'owner') return bad(res, 'The owner account cannot be switched off.', 400);
    await db.execute({ sql: 'UPDATE users SET active = ? WHERE id = ?', args: [active ? 1 : 0, id] });
    if (!active) await auth.destroyAllSessionsForUser(id);
    await auth.logActivity(req.user, 'users.update', `${active ? 'Re-enabled' : 'Suspended'} ${row.username}`);
  }
  if (password !== undefined) {
    const pErr = auth.passwordProblem(password);
    if (pErr) return bad(res, pErr);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [auth.hashPassword(password), id] });
    await auth.destroyAllSessionsForUser(id);
    await auth.logActivity(req.user, 'users.reset_password', `Reset the password for ${row.username}`);
  }
  ok(res, { ok: true });
});

app.delete('/api/users/:id', requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  const row = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] })).rows[0];
  if (!row) return bad(res, 'No such account.', 404);
  if (row.role === 'owner') return bad(res, 'The owner account cannot be removed.', 400);
  await auth.destroyAllSessionsForUser(id);
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
  await auth.logActivity(req.user, 'users.delete', `Removed the account ${row.username}`);
  res.status(204).end();
});

app.get('/api/activity', requireOwner, async (req, res) => {
  const rows = (
    await db.execute('SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT 200')
  ).rows;
  ok(res, rows);
});

// From here on, every API route requires a signed-in user.
app.use('/api', requireAuth);

// ---------- Duplicate-write protection ----------

// The app sends a unique X-Request-Id with every write. If the same id turns
// up twice — a retry, or the offline outbox replaying something the server
// had actually already accepted — the original response is replayed instead
// of doing the work again. This is what stops one flaky upload from becoming
// two identical progress photos.
app.use('/api', async (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const requestId = req.headers['x-request-id'];
  if (!requestId || typeof requestId !== 'string' || requestId.length > 100) return next();

  try {
    const seen = (
      await db.execute({ sql: 'SELECT status, response FROM request_log WHERE request_id = ?', args: [requestId] })
    ).rows[0];
    if (seen) {
      res.setHeader('X-Idempotent-Replay', '1');
      if (Number(seen.status) === 204) return res.status(204).end();
      return res.status(Number(seen.status)).send(seen.response || '{}');
    }
  } catch (err) {
    return next(); // never block a real write because bookkeeping failed
  }

  // Record the outcome once the response is on its way out.
  const originalJson = res.json.bind(res);
  const originalEnd = res.end.bind(res);
  let recorded = false;
  const record = async (bodyText) => {
    if (recorded) return;
    recorded = true;
    if (res.statusCode >= 400) return; // only successful writes are replayable
    try {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO request_log (request_id, status, response) VALUES (?, ?, ?)',
        args: [requestId, res.statusCode, bodyText === undefined ? null : bodyText],
      });
      await auth.logActivity(req.user, `${req.method} ${req.path}`, null);
    } catch (err) {
      /* bookkeeping only */
    }
  };
  res.json = (body) => {
    record(JSON.stringify(body));
    return originalJson(body);
  };
  res.end = (...args) => {
    record(undefined);
    return originalEnd(...args);
  };
  next();
});

// Best-effort phone normalization for WhatsApp links: strips formatting, and
// assumes a bare local-looking number (no + / country code) is Lebanese
// mobile (leading 0 dropped, country code 961 added) since that's where
// Fit Cube is based. A number already starting with + or a country code is
// left as-is.
function toWhatsAppNumber(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/[^\d+]/g, '');
  if (n.startsWith('+')) return n.slice(1);
  if (n.startsWith('00')) return n.slice(2);
  if (n.startsWith('961')) return n;
  if (n.startsWith('0')) n = n.slice(1);
  return '961' + n;
}

// ---------- Clients ----------

app.get('/api/clients', async (req, res) => {
  const includeArchived = req.query.archived === '1';
  const rows = (
    await db.execute(
      includeArchived
        ? 'SELECT * FROM clients ORDER BY name COLLATE NOCASE'
        : 'SELECT * FROM clients WHERE archived = 0 ORDER BY name COLLATE NOCASE'
    )
  ).rows;

  const balances = (
    await db.execute(`
      SELECT client_id,
        SUM(CASE WHEN payment_state='unpaid' THEN COALESCE(amount,0) ELSE 0 END) AS unpaid_amount,
        SUM(CASE WHEN payment_state='unpaid' AND amount IS NULL THEN 1 ELSE 0 END) AS unpaid_sessions_no_amount,
        SUM(CASE WHEN payment_state='prepaid' AND amount IS NULL THEN 1 ELSE 0 END) AS prepaid_session_credits,
        SUM(CASE WHEN payment_state='prepaid' AND amount IS NOT NULL THEN amount ELSE 0 END) AS prepaid_amount,
        COUNT(*) AS total_sessions,
        MAX(COALESCE(session_date, created_at)) AS last_activity
      FROM session_entries GROUP BY client_id
    `)
  ).rows;
  const byClient = Object.fromEntries(balances.map((b) => [Number(b.client_id), b]));

  ok(res, rows.map((c) => ({ ...c, balance: byClient[Number(c.id)] || null })));
});

app.get('/api/clients/:id', async (req, res) => {
  const client = (await db.execute({ sql: 'SELECT * FROM clients WHERE id=?', args: [req.params.id] })).rows[0];
  if (!client) return bad(res, 'Client not found', 404);
  const sessions = (
    await db.execute({
      sql: `SELECT se.*, s.name as service_name FROM session_entries se
            LEFT JOIN services s ON s.id = se.service_id
            WHERE se.client_id=? ORDER BY se.created_at DESC`,
      args: [req.params.id],
    })
  ).rows;
  const appointments = (
    await db.execute({
      sql: `SELECT a.*, s.name as service_name FROM appointments a
            LEFT JOIN services s ON s.id = a.service_id
            WHERE a.client_id=? ORDER BY a.starts_at DESC`,
      args: [req.params.id],
    })
  ).rows;
  const photos = (
    await db.execute({
      sql: `SELECT * FROM client_photos WHERE client_id=? ORDER BY taken_at DESC, created_at DESC`,
      args: [req.params.id],
    })
  ).rows;
  const metrics = (
    await db.execute({
      sql: `SELECT * FROM client_metrics WHERE client_id=? ORDER BY metric_date ASC, id ASC`,
      args: [req.params.id],
    })
  ).rows;
  ok(res, { ...client, sessions, appointments, photos, metrics });
});

app.post('/api/clients', async (req, res) => {
  const { name, phone, notes, music_link, goal } = req.body || {};
  if (!name || !name.trim()) return bad(res, 'name is required');
  const r = await db.execute({
    sql: 'INSERT INTO clients (name, phone, notes, music_link, goal) VALUES (?, ?, ?, ?, ?)',
    args: [name.trim(), phone || null, notes || null, music_link || null, goal || null],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, phone, notes, archived, music_link, goal } = req.body || {};
  await db.execute({
    sql: `UPDATE clients SET
            name = COALESCE(?, name),
            phone = COALESCE(?, phone),
            notes = COALESCE(?, notes),
            music_link = COALESCE(?, music_link),
            goal = COALESCE(?, goal),
            archived = COALESCE(?, archived),
            updated_at = datetime('now')
          WHERE id=?`,
    args: [name ?? null, phone ?? null, notes ?? null, music_link ?? null, goal ?? null, archived === undefined ? null : archived ? 1 : 0, req.params.id],
  });
  ok(res, { ok: true });
});

// ---------- Progress photos ----------

app.post('/api/clients/:id/photos', async (req, res) => {
  const { image_data, caption, taken_at } = req.body || {};
  if (!image_data) return bad(res, 'image_data is required');
  const r = await db.execute({
    sql: `INSERT INTO client_photos (client_id, image_data, caption, taken_at) VALUES (?, ?, ?, COALESCE(?, datetime('now')))`,
    args: [req.params.id, image_data, caption || null, taken_at || null],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.delete('/api/photos/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM client_photos WHERE id=?', args: [req.params.id] });
  ok(res, { ok: true });
});

// ---------- Progress metrics (weight, body fat, measurements) ----------

app.post('/api/clients/:id/metrics', async (req, res) => {
  const { metric_date, weight, body_fat_pct, chest, waist, hips, arm, thigh, note } = req.body || {};
  const r = await db.execute({
    sql: `INSERT INTO client_metrics (client_id, metric_date, weight, body_fat_pct, chest, waist, hips, arm, thigh, note)
          VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [req.params.id, metric_date || null, weight ?? null, body_fat_pct ?? null, chest ?? null, waist ?? null, hips ?? null, arm ?? null, thigh ?? null, note || null],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.delete('/api/metrics/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM client_metrics WHERE id=?', args: [req.params.id] });
  ok(res, { ok: true });
});

// ---------- Message templates ----------

app.get('/api/templates', async (req, res) => {
  ok(res, (await db.execute('SELECT * FROM message_templates ORDER BY id')).rows);
});

app.post('/api/templates', async (req, res) => {
  const { name, body } = req.body || {};
  if (!name || !name.trim() || !body || !body.trim()) return bad(res, 'name and body are required');
  const r = await db.execute({
    sql: 'INSERT INTO message_templates (name, body) VALUES (?, ?)',
    args: [name.trim(), body.trim()],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/templates/:id', async (req, res) => {
  const { name, body } = req.body || {};
  await db.execute({
    sql: `UPDATE message_templates SET name=COALESCE(?,name), body=COALESCE(?,body), updated_at=datetime('now') WHERE id=?`,
    args: [name ?? null, body ?? null, req.params.id],
  });
  ok(res, { ok: true });
});

app.delete('/api/templates/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM message_templates WHERE id=?', args: [req.params.id] });
  ok(res, { ok: true });
});

app.delete('/api/clients/:id', async (req, res) => {
  await db.execute({ sql: 'UPDATE clients SET archived=1 WHERE id=?', args: [req.params.id] });
  ok(res, { ok: true });
});

// ---------- Services ----------

app.get('/api/services', async (req, res) => {
  ok(res, (await db.execute('SELECT * FROM services WHERE active=1 ORDER BY category, name')).rows);
});

app.post('/api/services', async (req, res) => {
  const { name, category, default_price } = req.body || {};
  if (!name || !name.trim()) return bad(res, 'name is required');
  const r = await db.execute({
    sql: 'INSERT INTO services (name, category, default_price) VALUES (?, ?, ?)',
    args: [name.trim(), category || null, default_price ?? null],
  });
  ok(res, { id: Number(r.lastInsertRowid), name: name.trim(), category: category || null, default_price: default_price ?? null });
});

// ---------- Session entries (the paid/unpaid log) ----------

app.post('/api/clients/:id/sessions', async (req, res) => {
  const { service_id, session_date, payment_state, amount, tag, note } = req.body || {};
  if (!['prepaid', 'unpaid', 'paid_now'].includes(payment_state)) {
    return bad(res, 'payment_state must be prepaid, unpaid or paid_now');
  }
  const r = await db.execute({
    sql: `INSERT INTO session_entries (client_id, service_id, session_date, payment_state, amount, tag, note, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`,
    args: [req.params.id, service_id || null, session_date || null, payment_state, amount ?? null, tag || null, note || null],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/sessions/:id', async (req, res) => {
  const { payment_state, amount, tag, note, session_date, service_id } = req.body || {};
  await db.execute({
    sql: `UPDATE session_entries SET
            payment_state = COALESCE(?, payment_state),
            amount = COALESCE(?, amount),
            tag = COALESCE(?, tag),
            note = COALESCE(?, note),
            session_date = COALESCE(?, session_date),
            service_id = COALESCE(?, service_id)
          WHERE id=?`,
    args: [payment_state ?? null, amount ?? null, tag ?? null, note ?? null, session_date ?? null, service_id ?? null, req.params.id],
  });
  ok(res, { ok: true });
});

app.delete('/api/sessions/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM session_entries WHERE id=?', args: [req.params.id] });
  ok(res, { ok: true });
});

// ---------- Appointments / schedule ----------

app.get('/api/appointments', async (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT a.*, c.name as client_name, c.phone as client_phone, s.name as service_name
             FROM appointments a
             JOIN clients c ON c.id = a.client_id
             LEFT JOIN services s ON s.id = a.service_id`;
  const args = [];
  const clauses = [];
  if (from) { clauses.push('a.starts_at >= ?'); args.push(from); }
  if (to) { clauses.push('a.starts_at <= ?'); args.push(to); }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY a.starts_at ASC';
  ok(res, (await db.execute({ sql, args })).rows);
});

app.post('/api/appointments', async (req, res) => {
  const { client_id, service_id, starts_at, duration_minutes, note } = req.body || {};
  if (!client_id || !starts_at) return bad(res, 'client_id and starts_at are required');
  const r = await db.execute({
    sql: `INSERT INTO appointments (client_id, service_id, starts_at, duration_minutes, note)
          VALUES (?, ?, ?, ?, ?)`,
    args: [client_id, service_id || null, starts_at, duration_minutes || 60, note || null],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/appointments/:id', async (req, res) => {
  const { status, starts_at, duration_minutes, note, service_id } = req.body || {};
  await db.execute({
    sql: `UPDATE appointments SET
            status = COALESCE(?, status),
            starts_at = COALESCE(?, starts_at),
            duration_minutes = COALESCE(?, duration_minutes),
            note = COALESCE(?, note),
            service_id = COALESCE(?, service_id),
            updated_at = datetime('now')
          WHERE id=?`,
    args: [status ?? null, starts_at ?? null, duration_minutes ?? null, note ?? null, service_id ?? null, req.params.id],
  });
  ok(res, { ok: true });
});

app.delete('/api/appointments/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM appointments WHERE id=?', args: [req.params.id] });
  ok(res, { ok: true });
});

// ---------- Inventory / products ----------

app.get('/api/products', async (req, res) => {
  ok(res, (await db.execute('SELECT * FROM products ORDER BY name COLLATE NOCASE')).rows);
});

app.post('/api/products', async (req, res) => {
  const { name, sku, category, cost_price, sale_price, qty_on_hand, reorder_level } = req.body || {};
  if (!name) return bad(res, 'name is required');
  const r = await db.execute({
    sql: `INSERT INTO products (name, sku, category, cost_price, sale_price, qty_on_hand, reorder_level)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [name, sku || null, category || null, cost_price || 0, sale_price || 0, qty_on_hand || 0, reorder_level || 0],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/products/:id', async (req, res) => {
  const { name, sku, category, cost_price, sale_price, qty_on_hand, reorder_level } = req.body || {};
  await db.execute({
    sql: `UPDATE products SET
            name = COALESCE(?, name), sku = COALESCE(?, sku), category = COALESCE(?, category),
            cost_price = COALESCE(?, cost_price), sale_price = COALESCE(?, sale_price),
            qty_on_hand = COALESCE(?, qty_on_hand), reorder_level = COALESCE(?, reorder_level)
          WHERE id=?`,
    args: [name ?? null, sku ?? null, category ?? null, cost_price ?? null, sale_price ?? null, qty_on_hand ?? null, reorder_level ?? null, req.params.id],
  });
  ok(res, { ok: true });
});

// ---------- Sales ----------

app.get('/api/sales', async (req, res) => {
  const sales = (await db.execute('SELECT s.*, c.name as client_name FROM sales s LEFT JOIN clients c ON c.id=s.client_id ORDER BY sale_date DESC')).rows;
  ok(res, sales);
});

app.post('/api/sales', async (req, res) => {
  const { client_id, items, note } = req.body || {}; // items: [{product_id, qty, unit_price}]
  if (!Array.isArray(items) || !items.length) return bad(res, 'items array is required');
  const total = items.reduce((sum, it) => sum + Number(it.qty) * Number(it.unit_price), 0);
  const saleRes = await db.execute({
    sql: 'INSERT INTO sales (client_id, total, note) VALUES (?, ?, ?)',
    args: [client_id || null, total, note || null],
  });
  const saleId = Number(saleRes.lastInsertRowid);
  for (const it of items) {
    await db.execute({
      sql: 'INSERT INTO sale_items (sale_id, product_id, qty, unit_price) VALUES (?, ?, ?, ?)',
      args: [saleId, it.product_id, it.qty, it.unit_price],
    });
    await db.execute({
      sql: 'UPDATE products SET qty_on_hand = qty_on_hand - ? WHERE id=?',
      args: [it.qty, it.product_id],
    });
  }
  ok(res, { id: saleId, total });
});

// ---------- Purchases ----------

app.get('/api/purchases', async (req, res) => {
  ok(res, (await db.execute('SELECT * FROM purchases ORDER BY purchase_date DESC')).rows);
});

app.post('/api/purchases', async (req, res) => {
  const { supplier, items, note } = req.body || {}; // items: [{product_id, qty, unit_cost}]
  if (!Array.isArray(items) || !items.length) return bad(res, 'items array is required');
  const total = items.reduce((sum, it) => sum + Number(it.qty) * Number(it.unit_cost), 0);
  const pRes = await db.execute({
    sql: 'INSERT INTO purchases (supplier, total, note) VALUES (?, ?, ?)',
    args: [supplier || null, total, note || null],
  });
  const purchaseId = Number(pRes.lastInsertRowid);
  for (const it of items) {
    await db.execute({
      sql: 'INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost) VALUES (?, ?, ?, ?)',
      args: [purchaseId, it.product_id, it.qty, it.unit_cost],
    });
    await db.execute({
      sql: 'UPDATE products SET qty_on_hand = qty_on_hand + ? WHERE id=?',
      args: [it.qty, it.product_id],
    });
  }
  ok(res, { id: purchaseId, total });
});

// ---------- WhatsApp reminders ----------
// Default (always available, $0): the server just hands back a wa.me link
// built from the client's number; the app opens it and the WhatsApp app
// itself takes over — no browser tab, nothing to configure.
//
// Optional upgrade (only if WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID
// are set): sends automatically via Meta's WhatsApp Cloud API, no tap-to-send
// needed at all. This requires a Meta Business/WhatsApp Cloud API setup and
// an approved message template on Anthony's end (see README) — and, as of
// Oct 1 2026, Meta charges a small per-message fee for these (no more free
// tier), so it's opt-in only and never used unless those env vars are set.

app.post('/api/whatsapp/link', async (req, res) => {
  const { phone, message } = req.body || {};
  const number = toWhatsAppNumber(phone);
  if (!number) return bad(res, 'No phone number on file for this client.');
  const url = `https://wa.me/${number}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
  ok(res, { url });
});

app.post('/api/whatsapp/send', async (req, res) => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return ok(res, { configured: false }); // frontend falls back to the free wa.me link
  }
  const { phone, clientName, bodyParams } = req.body || {};
  const number = toWhatsAppNumber(phone);
  if (!number) return bad(res, 'No phone number on file for this client.');
  try {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: number,
        type: 'template',
        template: {
          name: process.env.WHATSAPP_TEMPLATE_NAME || 'session_reminder',
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en_US' },
          components: [{ type: 'body', parameters: (bodyParams || [clientName || '']).map((t) => ({ type: 'text', text: String(t) })) }],
        },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return ok(res, { configured: true, ok: false, error: data?.error?.message || 'WhatsApp API error' });
    ok(res, { configured: true, ok: true, data });
  } catch (err) {
    ok(res, { configured: true, ok: false, error: err.message });
  }
});

// ---------- Dashboard ----------

app.get('/api/dashboard/summary', async (req, res) => {
  const unpaid = (await db.execute(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as n FROM session_entries WHERE payment_state='unpaid'`)).rows[0];
  const prepaidCredits = (await db.execute(`SELECT COUNT(*) as n FROM session_entries WHERE payment_state='prepaid' AND amount IS NULL`)).rows[0];
  const lowStock = (await db.execute('SELECT COUNT(*) as n FROM products WHERE qty_on_hand <= reorder_level')).rows[0];
  const todayCount = (await db.execute(`SELECT COUNT(*) as n FROM appointments WHERE date(starts_at) = date('now') AND status='scheduled'`)).rows[0];
  const clientCount = (await db.execute('SELECT COUNT(*) as n FROM clients WHERE archived=0')).rows[0];
  const sessionRevenue = (await db.execute(`SELECT COALESCE(SUM(amount),0) as total FROM session_entries WHERE payment_state IN ('paid_now','prepaid') AND amount IS NOT NULL`)).rows[0];
  const productRevenue = (await db.execute('SELECT COALESCE(SUM(total),0) as total FROM sales')).rows[0];
  // Cost of goods sold: what the products actually sold cost you, valued at
  // each product's current cost price (this app doesn't snapshot historical
  // cost per sale, so if you change a cost price, past COGS re-values too —
  // close enough for a small studio's books, not audit-grade accounting).
  const cogs = (
    await db.execute(`
      SELECT COALESCE(SUM(si.qty * p.cost_price), 0) as total
      FROM sale_items si JOIN products p ON p.id = si.product_id
    `)
  ).rows[0];
  const purchasesTotal = (await db.execute('SELECT COALESCE(SUM(total),0) as total FROM purchases')).rows[0];
  const inventoryValue = (await db.execute('SELECT COALESCE(SUM(qty_on_hand * cost_price),0) as total FROM products')).rows[0];
  const revenueTotal = Number(sessionRevenue.total) + Number(productRevenue.total);
  const summary = {
    unpaid_total: Number(unpaid.total),
    unpaid_entries: Number(unpaid.n),
    prepaid_credit_sessions: Number(prepaidCredits.n),
    low_stock_products: Number(lowStock.n),
    appointments_today: Number(todayCount.n),
    active_clients: Number(clientCount.n),
  };
  // The money side is the owner's business. Staff accounts get the
  // operational numbers they need and nothing about takings or margin —
  // withheld here on the server, not merely hidden in the app.
  if (req.user.role === 'owner') {
    Object.assign(summary, {
      revenue_total: revenueTotal,
      session_revenue_total: Number(sessionRevenue.total),
      product_revenue_total: Number(productRevenue.total),
      cogs_total: Number(cogs.total),
      gross_profit: revenueTotal - Number(cogs.total),
      purchases_total: Number(purchasesTotal.total),
      inventory_value: Number(inventoryValue.total),
    });
  }
  ok(res, summary);
});

// ---------- Reports ----------

app.get('/api/reports/revenue', requireOwner, async (req, res) => {
  const byService = (
    await db.execute(`
      SELECT COALESCE(s.name, 'Unassigned / general') as service_name,
        SUM(CASE WHEN se.payment_state IN ('paid_now','prepaid') AND se.amount IS NOT NULL THEN se.amount ELSE 0 END) as revenue,
        COUNT(CASE WHEN se.payment_state='unpaid' THEN 1 END) as unpaid_sessions,
        COALESCE(SUM(CASE WHEN se.payment_state='unpaid' THEN se.amount ELSE 0 END),0) as unpaid_amount
      FROM session_entries se
      LEFT JOIN services s ON s.id = se.service_id
      GROUP BY COALESCE(s.name, 'Unassigned / general')
      HAVING revenue > 0 OR unpaid_sessions > 0
      ORDER BY revenue DESC
    `)
  ).rows;
  const sessionRevenue = (await db.execute(`SELECT COALESCE(SUM(amount),0) as total FROM session_entries WHERE payment_state IN ('paid_now','prepaid') AND amount IS NOT NULL`)).rows[0];
  const productRevenue = (await db.execute('SELECT COALESCE(SUM(total),0) as total FROM sales')).rows[0];
  const topProducts = (
    await db.execute(`
      SELECT p.name, SUM(si.qty) as qty_sold, SUM(si.qty * si.unit_price) as revenue
      FROM sale_items si JOIN products p ON p.id = si.product_id
      GROUP BY p.name ORDER BY revenue DESC LIMIT 10
    `)
  ).rows;
  ok(res, {
    by_service: byService,
    session_revenue_total: Number(sessionRevenue.total),
    product_sales_total: Number(productRevenue.total),
    grand_total: Number(sessionRevenue.total) + Number(productRevenue.total),
    top_products: topProducts,
  });
});

// ---------- Backup / restore ----------
// The single most important safety net in this app: everything else (server
// filesystem, hosting free tier, even Turso) is a "should be fine" — this is
// a "definitely fine" that lives wherever Anthony puts the downloaded file.

const BACKUP_TABLES = ['clients', 'client_photos', 'client_metrics', 'message_templates', 'services', 'session_entries', 'appointments', 'products', 'sales', 'sale_items', 'purchases', 'purchase_items'];
const BACKUP_INSERT_ORDER = ['clients', 'client_photos', 'client_metrics', 'message_templates', 'services', 'session_entries', 'appointments', 'products', 'sales', 'sale_items', 'purchases', 'purchase_items'];
const BACKUP_DELETE_ORDER = [...BACKUP_INSERT_ORDER].reverse(); // children before parents

app.get('/api/backup/export', requireOwner, async (req, res) => {
  const dump = { version: 1, exported_at: new Date().toISOString() };
  for (const t of BACKUP_TABLES) {
    dump[t] = (await db.execute(`SELECT * FROM ${t}`)).rows;
  }
  const filename = `fitcube-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(dump, null, 2));
});

app.post('/api/backup/import', requireOwner, async (req, res) => {
  const dump = req.body;
  if (!dump || dump.version !== 1) return bad(res, 'This does not look like a Fit Cube backup file.');
  try {
    for (const t of BACKUP_DELETE_ORDER) {
      await db.execute(`DELETE FROM ${t}`);
    }
    const restored = [];
    for (const t of BACKUP_INSERT_ORDER) {
      const rows = dump[t] || [];
      for (const row of rows) {
        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(',');
        await db.execute({ sql: `INSERT INTO ${t} (${cols.join(',')}) VALUES (${placeholders})`, args: cols.map((c) => row[c]) });
      }
      restored.push({ table: t, count: rows.length });
    }
    ok(res, { ok: true, restored });
  } catch (err) {
    bad(res, 'Restore failed: ' + err.message, 500);
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// SPA fallback (last, after API routes)
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => {
    app.listen(PORT, () => console.log(`Fit Cube ERP running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
