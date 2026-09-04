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
  const migrations = [
    "ALTER TABLE clients ADD COLUMN music_link TEXT",
    "ALTER TABLE clients ADD COLUMN goal TEXT",
  ];
  for (const m of migrations) {
    try {
      await db.execute(m);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }

  // Seed three starter message templates the first time this table is
  // empty — Anthony can edit or delete them, and add more, from the app.
  const templateCount = Number((await db.execute('SELECT COUNT(*) as n FROM message_templates')).rows[0].n);
  if (templateCount === 0) {
    const defaults = [
      ['Session reminder', 'Hi {name}, reminder from Fit Cube: your {service} session is on {when}. See you then!'],
      ['Payment reminder', "Hi {name}, just a friendly reminder that your balance at Fit Cube is {amount}. Whenever it's convenient to settle it works — thank you!"],
      ['General check-in', "Hi {name}, this is Fit Cube checking in — hope training's going well! Let us know if you'd like to book your next session."],
    ];
    for (const [name, body] of defaults) {
      await db.execute({ sql: 'INSERT INTO message_templates (name, body) VALUES (?, ?)', args: [name, body] });
    }
  }
}

module.exports = { db, init };
