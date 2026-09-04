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
  tag TEXT,                          -- 'ems' | 'presso' | 'kids' | NULL
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'legacy_import'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
