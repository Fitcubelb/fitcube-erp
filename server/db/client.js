// Single DB client shared across the app.
// Local dev: writes to a file (server/db/fitcube.db).
// Production (Render): point TURSO_DATABASE_URL / TURSO_AUTH_TOKEN at a free
// Turso database so data survives redeploys and the free-tier sleep/wake
// cycle (Render's free web service filesystem is ephemeral).
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const dbUrl = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'fitcube.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const db = createClient({ url: dbUrl, authToken });

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = schema
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await db.execute(stmt);
  }
  // Migrations for columns added after a database already existed (both
  // Anthony's local file and the live Turso DB). ALTER TABLE ... ADD COLUMN
  // isn't idempotent in SQLite, so we just try each one and swallow the
  // "duplicate column" error when it's already there.
  const migrations = ["ALTER TABLE clients ADD COLUMN music_link TEXT"];
  for (const m of migrations) {
    try {
      await db.execute(m);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
}

module.exports = { db, init };
