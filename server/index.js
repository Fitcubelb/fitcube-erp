require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { db, init } = require('./db/client');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); // generous limit so a full backup restore upload never gets rejected

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

const ok = (res, data) => res.json(data);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

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
  ok(res, { ...client, sessions, appointments });
});

app.post('/api/clients', async (req, res) => {
  const { name, phone, notes } = req.body || {};
  if (!name || !name.trim()) return bad(res, 'name is required');
  const r = await db.execute({
    sql: 'INSERT INTO clients (name, phone, notes) VALUES (?, ?, ?)',
    args: [name.trim(), phone || null, notes || null],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, phone, notes, archived } = req.body || {};
  await db.execute({
    sql: `UPDATE clients SET
            name = COALESCE(?, name),
            phone = COALESCE(?, phone),
            notes = COALESCE(?, notes),
            archived = COALESCE(?, archived),
            updated_at = datetime('now')
          WHERE id=?`,
    args: [name ?? null, phone ?? null, notes ?? null, archived === undefined ? null : archived ? 1 : 0, req.params.id],
  });
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
  if (!name) return bad(res, 'name is required');
  const r = await db.execute({
    sql: 'INSERT INTO services (name, category, default_price) VALUES (?, ?, ?)',
    args: [name, category || null, default_price ?? null],
  });
  ok(res, { id: Number(r.lastInsertRowid) });
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
  ok(res, {
    unpaid_total: Number(unpaid.total),
    unpaid_entries: Number(unpaid.n),
    prepaid_credit_sessions: Number(prepaidCredits.n),
    low_stock_products: Number(lowStock.n),
    appointments_today: Number(todayCount.n),
    active_clients: Number(clientCount.n),
    revenue_total: Number(sessionRevenue.total) + Number(productRevenue.total),
  });
});

// ---------- Reports ----------

app.get('/api/reports/revenue', async (req, res) => {
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

const BACKUP_TABLES = ['clients', 'services', 'session_entries', 'appointments', 'products', 'sales', 'sale_items', 'purchases', 'purchase_items'];
const BACKUP_INSERT_ORDER = ['clients', 'services', 'session_entries', 'appointments', 'products', 'sales', 'sale_items', 'purchases', 'purchase_items'];
const BACKUP_DELETE_ORDER = [...BACKUP_INSERT_ORDER].reverse(); // children before parents

app.get('/api/backup/export', async (req, res) => {
  const dump = { version: 1, exported_at: new Date().toISOString() };
  for (const t of BACKUP_TABLES) {
    dump[t] = (await db.execute(`SELECT * FROM ${t}`)).rows;
  }
  const filename = `fitcube-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(dump, null, 2));
});

app.post('/api/backup/import', async (req, res) => {
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
