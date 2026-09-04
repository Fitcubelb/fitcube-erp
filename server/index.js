require('dotenv').config();
const path = require('path');
const express = require('express');
const { db, init } = require('./db/client');
const auth = require('./auth');
const waWeb = require('./whatsapp-web-client');

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
        SUM(CASE WHEN payment_state='prepaid' AND amount IS NULL AND redeemed_at IS NULL THEN 1 ELSE 0 END) AS prepaid_session_credits,
        SUM(CASE WHEN payment_state='prepaid' AND amount IS NOT NULL THEN amount ELSE 0 END) AS prepaid_amount,
        COUNT(*) AS total_sessions,
        MAX(COALESCE(session_date, created_at)) AS last_activity
      FROM session_entries GROUP BY client_id
    `)
  ).rows;
  const byClient = Object.fromEntries(balances.map((b) => [Number(b.client_id), b]));

  // Unpaid package/credit sales (see "Give credits") owe money the same way
  // an unpaid session does — folded into the same unpaid_amount so the
  // client list badge matches the "Owed" figure on the client's own page.
  const unpaidPackages = (
    await db.execute(`SELECT client_id, SUM(price) AS total FROM package_sales WHERE payment_state='unpaid' GROUP BY client_id`)
  ).rows;
  for (const p of unpaidPackages) {
    const cid = Number(p.client_id);
    if (!byClient[cid]) byClient[cid] = { client_id: cid, unpaid_amount: 0, unpaid_sessions_no_amount: 0, prepaid_session_credits: 0, prepaid_amount: 0, total_sessions: 0, last_activity: null };
    byClient[cid].unpaid_amount = (Number(byClient[cid].unpaid_amount) || 0) + Number(p.total);
  }

  ok(res, rows.map((c) => ({ ...c, balance: byClient[Number(c.id)] || null })));
});

// Scans the whole (non-archived) client list for likely duplicates — not
// just right after an import, any time. Two signals, both reported for a
// human to review rather than acted on automatically:
//   - the exact same name (after trimming/collapsing spaces, case-insensitive)
//     appearing on more than one client record — almost always a real dupe.
//   - the same phone number on more than one client record with DIFFERENT
//     names — could be a genuine duplicate (typo, nickname) or a household
//     sharing one phone, so this is flagged, never merged automatically.
app.get('/api/clients/duplicate-check', requireOwner, async (req, res) => {
  const rows = (await db.execute('SELECT id, name, phone FROM clients WHERE archived = 0')).rows;
  const clients = rows.map((c) => ({ id: Number(c.id), name: c.name, phone: c.phone }));

  const byName = new Map();
  for (const c of clients) {
    const key = c.name.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }
  const same_name = [...byName.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ name: group[0].name, clients: group.map((c) => ({ id: c.id, phone: c.phone })) }));

  const byPhone = new Map();
  for (const c of clients) {
    const key = phoneMatchKey(c.phone);
    if (!key) continue;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push(c);
  }
  const same_phone_different_name = [...byPhone.values()]
    .filter((group) => group.length > 1 && new Set(group.map((c) => c.name.trim().toLowerCase())).size > 1)
    .map((group) => ({ phone: group[0].phone, clients: group.map((c) => ({ id: c.id, name: c.name })) }));

  ok(res, { total_clients: clients.length, same_name, same_phone_different_name });
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
  const packages = (
    await db.execute({
      sql: `SELECT * FROM package_sales WHERE client_id=? ORDER BY sold_at DESC, id DESC`,
      args: [req.params.id],
    })
  ).rows;
  ok(res, { ...client, sessions, appointments, photos, metrics, packages });
});

const CLIENT_TIERS = ['Bronze', 'VIP', 'Regular'];

app.post('/api/clients', async (req, res) => {
  const { name, phone, notes, music_link, goal, tier } = req.body || {};
  if (!name || !name.trim()) return bad(res, 'name is required');
  if (tier !== undefined && tier !== null && tier !== '' && !CLIENT_TIERS.includes(tier)) {
    return bad(res, 'tier must be Bronze, VIP or Regular');
  }
  const r = await db.execute({
    sql: 'INSERT INTO clients (name, phone, notes, music_link, goal, tier) VALUES (?, ?, ?, ?, ?, ?)',
    args: [name.trim(), phone || null, notes || null, music_link || null, goal || null, tier || 'Regular'],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, phone, notes, archived, music_link, goal, tier } = req.body || {};
  if (tier !== undefined && tier !== null && tier !== '' && !CLIENT_TIERS.includes(tier)) {
    return bad(res, 'tier must be Bronze, VIP or Regular');
  }
  await db.execute({
    sql: `UPDATE clients SET
            name = COALESCE(?, name),
            phone = COALESCE(?, phone),
            notes = COALESCE(?, notes),
            music_link = COALESCE(?, music_link),
            goal = COALESCE(?, goal),
            tier = COALESCE(?, tier),
            archived = COALESCE(?, archived),
            updated_at = datetime('now')
          WHERE id=?`,
    args: [name ?? null, phone ?? null, notes ?? null, music_link ?? null, goal ?? null, tier || null, archived === undefined ? null : archived ? 1 : 0, req.params.id],
  });
  ok(res, { ok: true });
});

// Bulk-import clients from a contacts spreadsheet (owner only). Matching is
// by NAME, not phone — a phone number can be shared by a whole household, so
// two different names on the same number must stay two different clients,
// never get merged into one. An exact (case-insensitive) name match against
// the existing list fills in that client's phone if it's missing, and is
// left alone if it already has one; a name that matches no one is created as
// a brand-new client. The phone number is only used afterwards to flag
// "different names, same number" for a human to glance at — never to decide
// who's who. Runs the whole batch against one in-memory snapshot of clients
// (updated as rows are created) so later rows in the same file can match
// earlier ones just added.
function phoneMatchKey(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('961')) digits = digits.slice(3);
  digits = digits.replace(/^0+/, '');
  return digits || null;
}

app.post('/api/clients/import', requireOwner, async (req, res) => {
  const contacts = Array.isArray(req.body && req.body.contacts) ? req.body.contacts : null;
  if (!contacts) return bad(res, 'contacts must be an array of {name, phone}');
  if (contacts.length > 2000) return bad(res, 'That is too many contacts for one import — split the file.');

  const existingRows = (await db.execute('SELECT id, name, phone FROM clients WHERE archived = 0')).rows;
  const clients = existingRows.map((c) => ({ id: Number(c.id), name: c.name, phone: c.phone }));

  const results = { created: 0, filled_phone: 0, unchanged: 0, skipped_invalid: 0, details: [] };
  const sharedPhoneGroups = new Map(); // phone key -> set of distinct names seen in this file, for the summary only

  for (const raw of contacts) {
    const name = raw && raw.name ? String(raw.name).trim().replace(/\s+/g, ' ') : '';
    const phone = raw && raw.phone ? String(raw.phone).trim() : '';
    if (!name) { results.skipped_invalid++; continue; }

    const pkey = phoneMatchKey(phone);
    if (pkey) {
      if (!sharedPhoneGroups.has(pkey)) sharedPhoneGroups.set(pkey, new Map());
      sharedPhoneGroups.get(pkey).set(name.toLowerCase(), name);
    }

    const nameMatch = clients.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (nameMatch) {
      if (!nameMatch.phone && phone) {
        await db.execute({ sql: `UPDATE clients SET phone = ?, updated_at = datetime('now') WHERE id = ?`, args: [phone, nameMatch.id] });
        nameMatch.phone = phone;
        results.filled_phone++;
        results.details.push({ name, phone, action: 'filled_phone', matched: nameMatch.name });
      } else {
        results.unchanged++;
        results.details.push({ name, phone, action: 'unchanged', matched: nameMatch.name });
      }
      continue;
    }

    const r = await db.execute({
      sql: 'INSERT INTO clients (name, phone) VALUES (?, ?)',
      args: [name, phone || null],
    });
    const newClient = { id: Number(r.lastInsertRowid), name, phone: phone || null };
    clients.push(newClient);
    results.created++;
    results.details.push({ name, phone, action: 'created' });
  }

  // Different names sharing one phone number in the uploaded file — not
  // necessarily an error (a household can share a landline), but worth a
  // human glance rather than silently importing them as-is.
  results.shared_phone_groups = [...sharedPhoneGroups.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([key, names]) => ({ phone_key: key, names: [...names.values()] }));

  await auth.logActivity(req.user, 'clients.import', `Imported a contacts file: ${results.created} created, ${results.filled_phone} phone numbers filled in, ${results.unchanged} already complete`);
  ok(res, results);
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

// Session amounts are whole dollars only (no cents). Returns { ok: true, value }
// or { ok: false } if the amount isn't a non-negative whole number.
function normalizeSessionAmount(amount) {
  if (amount === undefined || amount === null || amount === '') return { ok: true, value: null };
  const n = Math.round(Number(amount));
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

// Assigned only to rows that represent an actual checkin (see GET
// /api/checkins) — a fresh paid/unpaid entry, or a redeemed credit — never
// to an unredeemed credit-grant row. Starts at 100000 to look like a real
// receipt number rather than a small internal id; existing rows before this
// feature shipped are left NULL rather than backfilled.
async function nextReceiptNumber() {
  const row = (await db.execute(`SELECT COALESCE(MAX(receipt_number), 100000) + 1 as n FROM session_entries`)).rows[0];
  return Number(row.n);
}

app.post('/api/clients/:id/sessions', async (req, res) => {
  const { service_id, session_date, payment_state, amount, tag, note } = req.body || {};
  if (!['prepaid', 'unpaid', 'paid_now'].includes(payment_state)) {
    return bad(res, 'payment_state must be prepaid, unpaid or paid_now');
  }
  const amt = normalizeSessionAmount(amount);
  if (!amt.ok) return bad(res, 'amount must be a whole number, 0 or more');
  // A plain prepaid entry from here (rather than "Give credits") is a manual
  // ad-hoc credit grant, not a checkin someone actually made — no receipt.
  const receiptNumber = payment_state === 'prepaid' ? null : await nextReceiptNumber();
  const r = await db.execute({
    sql: `INSERT INTO session_entries (client_id, service_id, session_date, payment_state, amount, tag, note, source, receipt_number)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
    args: [req.params.id, service_id || null, session_date || null, payment_state, amt.value, tag || null, note || null, receiptNumber],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/sessions/:id', async (req, res) => {
  const { payment_state, amount, tag, note, session_date, service_id } = req.body || {};
  const amt = normalizeSessionAmount(amount);
  if (!amt.ok) return bad(res, 'amount must be a whole number, 0 or more');
  await db.execute({
    sql: `UPDATE session_entries SET
            payment_state = COALESCE(?, payment_state),
            amount = COALESCE(?, amount),
            tag = COALESCE(?, tag),
            note = COALESCE(?, note),
            session_date = COALESCE(?, session_date),
            service_id = COALESCE(?, service_id)
          WHERE id=?`,
    args: [payment_state ?? null, amt.value, tag ?? null, note ?? null, session_date ?? null, service_id ?? null, req.params.id],
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

// ---------- Session packages (bundles) ----------
// Anthony's own pricing for bulk session credits — "1 session" for $30,
// "10-pack" for $450, "12-pack" for $500, however he wants to price them.
// Selling one (below) books the price as revenue and adds that many prepaid
// session credits to the client in one step.

app.get('/api/packages', async (req, res) => {
  const rows = (await db.execute('SELECT * FROM session_packages ORDER BY session_count ASC, id ASC')).rows;
  ok(res, rows);
});

app.post('/api/packages', async (req, res) => {
  const { name, session_count, price } = req.body || {};
  if (!name || !String(name).trim()) return bad(res, 'name is required');
  const count = Number(session_count);
  if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) return bad(res, 'session_count must be a whole number of 1 or more');
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) return bad(res, 'price must be 0 or more');
  const r = await db.execute({
    sql: 'INSERT INTO session_packages (name, session_count, price) VALUES (?, ?, ?)',
    args: [String(name).trim(), count, priceNum],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/packages/:id', async (req, res) => {
  const { name, session_count, price } = req.body || {};
  if (session_count !== undefined && session_count !== null) {
    const count = Number(session_count);
    if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) return bad(res, 'session_count must be a whole number of 1 or more');
  }
  if (price !== undefined && price !== null) {
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) return bad(res, 'price must be 0 or more');
  }
  await db.execute({
    sql: `UPDATE session_packages SET
            name = COALESCE(?, name), session_count = COALESCE(?, session_count), price = COALESCE(?, price)
          WHERE id=?`,
    args: [name ?? null, session_count ?? null, price ?? null, req.params.id],
  });
  ok(res, { ok: true });
});

app.delete('/api/packages/:id', async (req, res) => {
  // Deleting a preset never touches past sales made from it — package_sales
  // snapshots name/session_count/price at sale time, and its package_id
  // reference just goes to NULL (see schema.sql).
  await db.execute({ sql: 'DELETE FROM session_packages WHERE id=?', args: [req.params.id] });
  ok(res, { ok: true });
});

// Selling a package to a client: records the sale (for revenue reporting)
// and grants session_count prepaid credits — the same session_entries shape
// as logging a plain prepaid session (payment_state='prepaid', amount NULL)
// one at a time, just done in bulk. name/session_count/price come from the
// client already resolved (either copied from a chosen preset or entered as
// a one-off), so this route trusts them rather than re-deriving from
// package_id — the same way /api/sales trusts the unit_price it's given.
app.post('/api/clients/:id/packages', async (req, res) => {
  const { package_id, name, session_count, price, note, payment_state } = req.body || {};
  if (!name || !String(name).trim()) return bad(res, 'name is required');
  const count = Number(session_count);
  if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) return bad(res, 'session_count must be a whole number of 1 or more');
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) return bad(res, 'price must be 0 or more');
  const state = payment_state || 'paid_now';
  if (!['paid_now', 'unpaid'].includes(state)) return bad(res, "payment_state must be 'paid_now' or 'unpaid'");

  const client = (await db.execute({ sql: 'SELECT id FROM clients WHERE id=?', args: [req.params.id] })).rows[0];
  if (!client) return bad(res, 'Client not found', 404);

  const trimmedName = String(name).trim();
  const saleRes = await db.execute({
    sql: 'INSERT INTO package_sales (client_id, package_id, name, session_count, price, payment_state, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [req.params.id, package_id || null, trimmedName, count, priceNum, state, note || null],
  });
  // Credits are handed over right away regardless of whether the client has
  // paid yet — payment is tracked separately on the package_sales row above,
  // the same way an unpaid session still counts as a session that happened.
  for (let i = 0; i < count; i++) {
    await db.execute({
      sql: `INSERT INTO session_entries (client_id, payment_state, amount, note, source) VALUES (?, 'prepaid', NULL, ?, 'manual')`,
      args: [req.params.id, `Package: ${trimmedName}`],
    });
  }
  ok(res, { id: Number(saleRes.lastInsertRowid), credits_added: count });
});

// Flip a package sale from unpaid to paid — the same idea as "Mark paid" on
// a session entry, just for a batch-of-credits sale instead of a single one.
app.put('/api/package-sales/:id', async (req, res) => {
  const { payment_state } = req.body || {};
  if (!['paid_now', 'unpaid'].includes(payment_state)) return bad(res, "payment_state must be 'paid_now' or 'unpaid'");
  await db.execute({ sql: 'UPDATE package_sales SET payment_state=? WHERE id=?', args: [payment_state, req.params.id] });
  ok(res, { ok: true });
});

// Redeems the client's oldest available prepaid credit for an actual visit:
// turns a still-unused credit row (payment_state='prepaid', amount NULL,
// redeemed_at NULL) into the record of that visit by stamping it with today's
// date, the service given, and redeemed_at — so it stops counting toward
// "credits left" without losing the fact that a credit was used. Picks the
// oldest one (FIFO) rather than requiring the caller to pick a specific
// package sale, since credits from different packages are fungible here.
app.post('/api/clients/:id/redeem-credit', async (req, res) => {
  const { service_id, note } = req.body || {};
  const client = (await db.execute({ sql: 'SELECT id FROM clients WHERE id=?', args: [req.params.id] })).rows[0];
  if (!client) return bad(res, 'Client not found', 404);
  const credit = (
    await db.execute({
      sql: `SELECT id FROM session_entries
            WHERE client_id=? AND payment_state='prepaid' AND amount IS NULL AND redeemed_at IS NULL
            ORDER BY created_at ASC LIMIT 1`,
      args: [req.params.id],
    })
  ).rows[0];
  if (!credit) return bad(res, 'No prepaid credits available for this client');
  const receiptNumber = await nextReceiptNumber();
  await db.execute({
    sql: `UPDATE session_entries SET
            session_date = datetime('now'),
            service_id = COALESCE(?, service_id),
            note = COALESCE(?, note),
            redeemed_at = datetime('now'),
            receipt_number = ?
          WHERE id=?`,
    args: [service_id || null, note || null, receiptNumber, credit.id],
  });
  ok(res, { id: credit.id, receipt_number: receiptNumber });
});

// ---------- Checkins ----------

// Everything that counts as an actual visit — a paid or unpaid session, or a
// redeemed prepaid credit — across every client, for the Checkins tab.
// source='manual' only: legacy_import rows are outstanding balances migrated
// from the old paper ledger (no real visit date, never actually "checked
// in" through the app), not real checkins — they still count toward the
// "Owed" figures elsewhere, just not this log. Not owner-gated: staff
// already see individual session amounts on a client's own page (only
// aggregate revenue/profit reporting is owner-only), so this follows suit.
app.get('/api/checkins', async (req, res) => {
  const rows = (
    await db.execute(`
      SELECT se.id, se.client_id, c.name as client_name, c.tier as client_tier, se.service_id, sv.name as service_name,
             se.session_date, se.created_at, se.payment_state, se.amount, se.receipt_number, se.note
      FROM session_entries se
      JOIN clients c ON c.id = se.client_id
      LEFT JOIN services sv ON sv.id = se.service_id
      WHERE se.source = 'manual'
        AND (se.payment_state IN ('paid_now','unpaid')
             OR (se.payment_state='prepaid' AND se.redeemed_at IS NOT NULL))
      ORDER BY COALESCE(se.session_date, se.created_at) DESC
    `)
  ).rows;
  ok(res, rows);
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
  const { phone, clientName, bodyParams, message } = req.body || {};
  const number = toWhatsAppNumber(phone);
  if (!number) return bad(res, 'No phone number on file for this client.');

  // Try the free, unofficial WhatsApp Web automation first, if it's enabled
  // and actually paired — sends the same free-text message the wa.me
  // fallback would have used (no Meta template restriction on this path).
  const webResult = await waWeb.sendMessage(number, message || (bodyParams || []).join(' '));
  if (webResult) return ok(res, { configured: true, via: 'web', ...webResult });

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return ok(res, { configured: false }); // frontend falls back to the free wa.me link
  }
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

// Owner-only: pairing status/QR for the optional, unofficial WhatsApp Web
// automation (see server/whatsapp-web-client.js and README) — lets Anthony
// scan the QR with his own phone from Settings, without anyone else seeing it.
app.get('/api/whatsapp-web/status', requireOwner, async (req, res) => {
  ok(res, waWeb.getStatus());
});
app.get('/api/whatsapp-web/qr', requireOwner, async (req, res) => {
  const dataUrl = await waWeb.getQrDataUrl();
  if (!dataUrl) return bad(res, 'No QR code available right now.', 404);
  ok(res, { dataUrl });
});
app.post('/api/whatsapp-web/logout', requireOwner, async (req, res) => {
  await waWeb.logout();
  ok(res, { ok: true });
});

// ---------- Dashboard ----------

app.get('/api/dashboard/summary', async (req, res) => {
  // Overview is the screen everyone hits every time they open the app, so
  // it's the natural place to piggyback the automatic-snapshot check (see
  // maybeCreateSnapshot below) — deliberately not awaited so a slow snapshot
  // never delays this response.
  maybeCreateSnapshot();
  const unpaidSessions = (await db.execute(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as n FROM session_entries WHERE payment_state='unpaid'`)).rows[0];
  const unpaidPackages = (await db.execute(`SELECT COALESCE(SUM(price),0) as total, COUNT(*) as n FROM package_sales WHERE payment_state='unpaid'`)).rows[0];
  const unpaid = { total: Number(unpaidSessions.total) + Number(unpaidPackages.total), n: Number(unpaidSessions.n) + Number(unpaidPackages.n) };
  // Only credits nobody has redeemed yet count as "left" — a redeemed one is
  // now the record of an actual visit, not an outstanding credit.
  const prepaidCredits = (await db.execute(`SELECT COUNT(*) as n FROM session_entries WHERE payment_state='prepaid' AND amount IS NULL AND redeemed_at IS NULL`)).rows[0];
  const lowStock = (await db.execute('SELECT COUNT(*) as n FROM products WHERE qty_on_hand <= reorder_level')).rows[0];
  const todayCount = (await db.execute(`SELECT COUNT(*) as n FROM appointments WHERE date(starts_at) = date('now') AND status='scheduled'`)).rows[0];
  const clientCount = (await db.execute('SELECT COUNT(*) as n FROM clients WHERE archived=0')).rows[0];
  const sessionRevenue = (await db.execute(`SELECT COALESCE(SUM(amount),0) as total FROM session_entries WHERE payment_state IN ('paid_now','prepaid') AND amount IS NOT NULL`)).rows[0];
  const productRevenue = (await db.execute('SELECT COALESCE(SUM(total),0) as total FROM sales')).rows[0];
  const packageRevenue = (await db.execute(`SELECT COALESCE(SUM(price),0) as total FROM package_sales WHERE payment_state='paid_now'`)).rows[0];
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
  const revenueTotal = Number(sessionRevenue.total) + Number(productRevenue.total) + Number(packageRevenue.total);
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
    const money = await moneyByPeriod();
    Object.assign(summary, {
      revenue_total: revenueTotal,
      session_revenue_total: Number(sessionRevenue.total),
      product_revenue_total: Number(productRevenue.total),
      package_revenue_total: Number(packageRevenue.total),
      cogs_total: Number(cogs.total),
      gross_profit: revenueTotal - Number(cogs.total),
      purchases_total: Number(purchasesTotal.total),
      inventory_value: Number(inventoryValue.total),
      revenue_periods: money.revenue,
      profit_periods: money.profit,
    });
  }
  ok(res, summary);
});

// Same profit definition as the Accounting page's headline number (revenue
// minus cost of goods sold), broken into how much of it landed today, this
// week, this month, this year, and all time — one query per money source, each
// bucketing all five periods at once with conditional SUMs rather than
// running the same query five times over.
const MONEY_PERIODS = ['all_time', 'today', 'this_week', 'this_month', 'this_year'];

// One CASE-per-period bucketing per money source (rather than one query per
// period) so this stays cheap regardless of how many periods the UI wants.
function periodCase(dateExpr, valueExpr) {
  return `
        COALESCE(SUM(${valueExpr}), 0) as all_time,
        COALESCE(SUM(CASE WHEN date(${dateExpr}) = date('now') THEN ${valueExpr} ELSE 0 END), 0) as today,
        COALESCE(SUM(CASE WHEN strftime('%Y-%W', ${dateExpr}) = strftime('%Y-%W', 'now') THEN ${valueExpr} ELSE 0 END), 0) as this_week,
        COALESCE(SUM(CASE WHEN strftime('%Y-%m', ${dateExpr}) = strftime('%Y-%m', 'now') THEN ${valueExpr} ELSE 0 END), 0) as this_month,
        COALESCE(SUM(CASE WHEN strftime('%Y', ${dateExpr}) = strftime('%Y', 'now') THEN ${valueExpr} ELSE 0 END), 0) as this_year`;
}

async function moneyByPeriod() {
  const sessionRevenue = (
    await db.execute(`
      SELECT ${periodCase('COALESCE(session_date, created_at)', 'amount')}
      FROM session_entries WHERE payment_state IN ('paid_now','prepaid') AND amount IS NOT NULL
    `)
  ).rows[0];
  const salesRevenue = (
    await db.execute(`SELECT ${periodCase('sale_date', 'total')} FROM sales`)
  ).rows[0];
  const packageRevenue = (
    await db.execute(`SELECT ${periodCase('sold_at', 'price')} FROM package_sales WHERE payment_state='paid_now'`)
  ).rows[0];
  const cogsByPeriod = (
    await db.execute(`
      SELECT ${periodCase('s.sale_date', 'si.qty * p.cost_price')}
      FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
    `)
  ).rows[0];
  const revenue = {};
  const profit = {};
  for (const p of MONEY_PERIODS) {
    const rev = Number(sessionRevenue[p]) + Number(salesRevenue[p]) + Number(packageRevenue[p]);
    revenue[p] = rev;
    profit[p] = rev - Number(cogsByPeriod[p]);
  }
  return { revenue, profit };
}

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

const BACKUP_TABLES = ['clients', 'client_photos', 'client_metrics', 'message_templates', 'services', 'session_packages', 'session_entries', 'appointments', 'products', 'sales', 'sale_items', 'purchases', 'purchase_items', 'package_sales'];
const BACKUP_INSERT_ORDER = ['clients', 'client_photos', 'client_metrics', 'message_templates', 'services', 'session_packages', 'session_entries', 'appointments', 'products', 'sales', 'sale_items', 'purchases', 'purchase_items', 'package_sales'];
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

async function restoreFromDump(dump) {
  if (!dump || dump.version !== 1) throw new Error('This does not look like a Fit Cube backup file.');
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
  return restored;
}

app.post('/api/backup/import', requireOwner, async (req, res) => {
  try {
    const restored = await restoreFromDump(req.body);
    ok(res, { ok: true, restored });
  } catch (err) {
    bad(res, 'Restore failed: ' + err.message, 500);
  }
});

// ---------- Automatic snapshots ----------
// A second, independent safety net that doesn't depend on anyone
// remembering to tap "Save backup": the server itself keeps a rolling
// window of full database snapshots inside Turso (a separate service from
// the app host, so a Render outage or redeploy can't take both out at
// once). Render's free tier has no built-in scheduler, so instead of a
// real cron job this piggybacks on ordinary traffic — see the call in
// GET /api/dashboard/summary — and is cheap on every request but one: an
// in-memory timestamp skips the DB check entirely unless at least an hour
// has passed, and even then it only does the expensive export/insert work
// when the newest snapshot has gone stale.
const SNAPSHOT_INTERVAL_HOURS = 20;
const SNAPSHOT_RETENTION = 14;
const SNAPSHOT_CHECK_THROTTLE_MS = 60 * 60 * 1000;
let lastSnapshotCheckAt = 0;

async function maybeCreateSnapshot() {
  const now = Date.now();
  if (now - lastSnapshotCheckAt < SNAPSHOT_CHECK_THROTTLE_MS) return;
  lastSnapshotCheckAt = now;
  try {
    const latest = (await db.execute('SELECT created_at FROM backup_snapshots ORDER BY id DESC LIMIT 1')).rows[0];
    if (latest) {
      const ageHours = (now - new Date(latest.created_at.replace(' ', 'T') + 'Z').getTime()) / 3600000;
      if (!isNaN(ageHours) && ageHours < SNAPSHOT_INTERVAL_HOURS) return;
    }
    const dump = { version: 1, exported_at: new Date().toISOString() };
    for (const t of BACKUP_TABLES) {
      dump[t] = (await db.execute(`SELECT * FROM ${t}`)).rows;
    }
    const json = JSON.stringify(dump);
    await db.execute({
      sql: 'INSERT INTO backup_snapshots (data, client_count, size_bytes) VALUES (?, ?, ?)',
      args: [json, (dump.clients || []).length, Buffer.byteLength(json)],
    });
    // Keep only the most recent SNAPSHOT_RETENTION snapshots so this
    // doesn't grow forever.
    await db.execute({
      sql: 'DELETE FROM backup_snapshots WHERE id NOT IN (SELECT id FROM backup_snapshots ORDER BY id DESC LIMIT ?)',
      args: [SNAPSHOT_RETENTION],
    });
  } catch (err) {
    // A missed snapshot isn't worth failing a request over — the manual
    // backup flow and the next scheduled attempt are still there.
    console.error('Automatic snapshot failed:', err.message);
  }
}

app.get('/api/backup/snapshots', requireOwner, async (req, res) => {
  const rows = (
    await db.execute('SELECT id, created_at, client_count, size_bytes FROM backup_snapshots ORDER BY id DESC')
  ).rows;
  ok(res, rows);
});

app.get('/api/backup/snapshots/:id', requireOwner, async (req, res) => {
  const row = (
    await db.execute({ sql: 'SELECT data, created_at FROM backup_snapshots WHERE id = ?', args: [req.params.id] })
  ).rows[0];
  if (!row) return bad(res, 'Snapshot not found.', 404);
  const filename = `fitcube-snapshot-${String(row.created_at).slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(row.data);
});

app.post('/api/backup/snapshots/:id/restore', requireOwner, async (req, res) => {
  const row = (
    await db.execute({ sql: 'SELECT data FROM backup_snapshots WHERE id = ?', args: [req.params.id] })
  ).rows[0];
  if (!row) return bad(res, 'Snapshot not found.', 404);
  try {
    const restored = await restoreFromDump(JSON.parse(row.data));
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
    // Also try right at startup, not just on the next dashboard load — a
    // fresh deploy or a long-asleep free-tier instance should still end up
    // with a recent snapshot without waiting on someone opening the app.
    maybeCreateSnapshot();
    // Optional, opt-in WhatsApp automation (see server/whatsapp-web-client.js)
    // — a no-op unless WHATSAPP_WEB_AUTOMATION=true, and never allowed to
    // take the server down if it fails to start.
    waWeb.init(db).catch((err) => console.error('WhatsApp Web automation init error:', err.message));
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
