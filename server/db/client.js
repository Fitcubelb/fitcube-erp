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
}

module.exports = { db, init };
