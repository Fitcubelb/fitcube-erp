-- Fit Cube ERP schema
-- Works identically on local SQLite file and on Turso (libSQL), same client library.

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  music_link TEXT,                   -- pasted Spotify/Anghami/SoundCloud/YouTube playlist link
  goal TEXT,                         -- free-text training goal, e.g. "Lose 5kg by December"
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Progress photos pasted/uploaded per client. Images are resized and
-- JPEG-compressed in the browser before upload (see app.js
-- compressImageFile), so this stays light even on the free DB tier.
CREATE TABLE IF NOT EXISTS client_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  image_data TEXT NOT NULL,          -- base64 data URL
  caption TEXT,
  taken_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  default_price REAL,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- One row per logged session (paid or unpaid), matching the legend Anthony
-- already uses on paper: paid-in-advance / unpaid / partial balances, plus
-- tags for EMS, Presso Therapy and kids training.
CREATE TABLE IF NOT EXISTS session_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id),
  session_date TEXT,                 -- nullable: legacy/imported entries may not have an exact date
  payment_state TEXT NOT NULL CHECK (payment_state IN ('prepaid','unpaid','paid_now')),
  amount REAL,                       -- amount owed (unpaid) or charged (paid_now); NULL when unknown/prepaid credit
  tag TEXT,                          -- 'ems' | 'presso' | 'kids' | NULL (legacy — no longer set from the app)
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'legacy_import'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set when a prepaid credit row (payment_state='prepaid', amount NULL) is
  -- redeemed for an actual visit — see POST /api/clients/:id/redeem-credit.
  -- NULL means the credit is still available to use.
  redeemed_at TEXT
);

-- Simple scheduled appointments (separate from the session log above, which
-- records what was actually paid/done).
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id),
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | completed | cancelled | no_show
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sku TEXT,
  category TEXT,
  cost_price REAL DEFAULT 0,
  sale_price REAL DEFAULT 0,
  qty_on_hand REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id),
  sale_date TEXT NOT NULL DEFAULT (datetime('now')),
  total REAL NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier TEXT,
  purchase_date TEXT NOT NULL DEFAULT (datetime('now')),
  total REAL NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL
);

-- Progress metrics — a dated log entry per weigh-in/measurement, however
-- often Anthony wants to track a given client (daily, weekly, monthly —
-- there's no fixed cadence, just log whenever he measures them).
CREATE TABLE IF NOT EXISTS client_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  metric_date TEXT NOT NULL DEFAULT (datetime('now')),
  weight REAL,
  body_fat_pct REAL,
  chest REAL,
  waist REAL,
  hips REAL,
  arm REAL,
  thigh REAL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reusable WhatsApp message templates (payment reminders, session reminders,
-- etc.) with {name}/{service}/{when}/{amount} placeholders filled in per
-- client when sending. Editable/addable from the app — seeded with three
-- sensible defaults the first time this table is empty (see client.js).
CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_entries_client ON session_entries(client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_starts_at ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_client_photos_client ON client_photos(client_id);
CREATE INDEX IF NOT EXISTS idx_client_metrics_client ON client_metrics(client_id);

-- ---------------------------------------------------------------------------
-- Access control. Everything above this line is business data; everything
-- below is about who is allowed to touch it.
-- ---------------------------------------------------------------------------

-- One row per person who can sign in. The first account is created through
-- the app's first-run setup screen (see /api/auth/setup) and is always the
-- 'owner'; the owner can then add 'staff' accounts, which can run the day to
-- day but can't see the money side, take backups, or manage other accounts.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,        -- scrypt: salt:hash, both hex
  role TEXT NOT NULL DEFAULT 'staff', -- 'owner' | 'staff'
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Server-side settings that must survive a redeploy but don't belong in the
-- repo — currently just the secret used to sign session cookies, generated
-- once on first start.
CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Signed-in devices. Kept server-side (rather than trusting a self-contained
-- token) so that removing a person, or signing a lost phone out, takes effect
-- immediately instead of whenever the cookie happens to expire.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,                -- random token id, stored hashed
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

-- Who changed what. Written for every successful write, so the owner can see
-- what happened on an account other than their own.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,                      -- denormalised so history survives deletion
  action TEXT NOT NULL,               -- e.g. 'POST /api/clients/12/photos'
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Idempotency. The app sends a unique id with every write; if the same id
-- arrives twice (a retry, or the offline outbox replaying something the
-- server had in fact already accepted) the stored response is returned
-- instead of doing the work a second time. This is what stops a flaky upload
-- from producing two copies of the same progress photo.
CREATE TABLE IF NOT EXISTS request_log (
  request_id TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bundle pricing Anthony sets himself — e.g. "1 session" for $30, "10-pack"
-- for $450, "12-pack" for $500 — offered when selling a package to a client.
CREATE TABLE IF NOT EXISTS session_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  session_count INTEGER NOT NULL,
  price REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per package sold to a client: books the price as revenue and is
-- the record of how many prepaid session credits (see session_entries) that
-- purchase granted. Name/session_count/price are snapshotted at sale time so
-- editing or deleting a session_packages preset later never rewrites history.
CREATE TABLE IF NOT EXISTS package_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES session_packages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  session_count INTEGER NOT NULL,
  price REAL NOT NULL,
  -- Whether the client has actually paid for this batch of credits yet.
  -- Credits are granted immediately either way; only 'paid_now' sales count
  -- as revenue, and 'unpaid' ones show up in the client's owed balance.
  payment_state TEXT NOT NULL DEFAULT 'paid_now' CHECK (payment_state IN ('paid_now','unpaid')),
  sold_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT
);

-- A second, automatic safety net alongside the manual "Save backup" flow in
-- Settings. The server takes a full snapshot of the database roughly once a
-- day (see maybeCreateSnapshot in server/index.js) and keeps a rolling window
-- of them here, in Turso — a different place than the app server itself —
-- so data survives even if nobody remembers to export a file by hand.
CREATE TABLE IF NOT EXISTS backup_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  data TEXT NOT NULL,
  client_count INTEGER,
  size_bytes INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);
CREATE INDEX IF NOT EXISTS idx_backup_snapshots_created ON backup_snapshots(created_at);
CREATE INDEX IF NOT EXISTS idx_package_sales_client ON package_sales(client_id);
