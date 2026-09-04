// Optional, free WhatsApp automation — NOT Meta's official Cloud API.
//
// This drives a real WhatsApp account the same way WhatsApp Web does (via a
// headless, automated browser), instead of using Meta's sanctioned Business
// API. That means: $0 per message (no Meta fee), but it is against
// WhatsApp's Terms of Service and carries a real risk of the paired number
// getting banned or suspended. See README.md ("WhatsApp reminders") for the
// full trade-off — this file only exists because that risk was explicitly
// accepted.
//
// Entirely opt-in: nothing in this file runs unless
// WHATSAPP_WEB_AUTOMATION=true is set. If it fails to load or to launch its
// browser for any reason, the rest of the app must keep working — every
// call here is wrapped so a failure just falls back to the existing
// wa.me / Meta Cloud API paths, never crashes the server.
//
// Session persistence: Render's free web service has no persistent disk, so
// the paired login (normally saved to local files by whatsapp-web.js) is
// backed up into Turso instead via a custom RemoteAuth store below — so a
// restart, redeploy, or free-tier sleep/wake cycle doesn't force Anthony to
// re-scan the QR code every time. The very first pairing still needs a real
// scan with his phone (Settings → WhatsApp automation in the app) — that
// step can only be done by him, on his own device.

const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const DATA_PATH = path.join(__dirname, '..', '.wwebjs_auth');
const SESSION_NAME = 'RemoteAuth-fitcube';

let db = null;
let client = null;
let status = 'disabled'; // disabled | starting | qr | authenticated | ready | auth_failure | disconnected | error
let lastQr = null;
let lastError = null;

class TursoSessionStore {
  async sessionExists({ session }) {
    const row = (await db.execute({ sql: 'SELECT 1 FROM whatsapp_sessions WHERE session=?', args: [session] })).rows[0];
    return !!row;
  }
  async save({ session }) {
    const filePath = path.join(DATA_PATH, `${session}.zip`);
    const buf = await fs.promises.readFile(filePath);
    await db.execute({
      sql: `INSERT INTO whatsapp_sessions (session, data, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(session) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
      args: [session, buf],
    });
  }
  async extract({ session, path: outPath }) {
    const row = (await db.execute({ sql: 'SELECT data FROM whatsapp_sessions WHERE session=?', args: [session] })).rows[0];
    if (!row) throw new Error(`No stored WhatsApp session found for "${session}"`);
    const bytes = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
    await fs.promises.writeFile(outPath, Buffer.from(bytes));
  }
  async delete({ session }) {
    await db.execute({ sql: 'DELETE FROM whatsapp_sessions WHERE session=?', args: [session] });
  }
}

async function init(dbClient) {
  if (process.env.WHATSAPP_WEB_AUTOMATION !== 'true') return; // stays fully inert otherwise
  db = dbClient;
  status = 'starting';
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    // eslint-disable-next-line global-require
    const { Client, RemoteAuth } = require('whatsapp-web.js');
    // eslint-disable-next-line global-require
    const chromium = require('@sparticuz/chromium');
    const executablePath = await chromium.executablePath();

    client = new Client({
      authStrategy: new RemoteAuth({
        clientId: 'fitcube',
        store: new TursoSessionStore(),
        dataPath: DATA_PATH,
        backupSyncIntervalMs: 5 * 60 * 1000,
      }),
      puppeteer: {
        executablePath,
        headless: true,
        args: chromium.args,
      },
    });

    client.on('qr', (qr) => { lastQr = qr; status = 'qr'; });
    client.on('authenticated', () => { status = 'authenticated'; lastQr = null; });
    client.on('ready', () => { status = 'ready'; lastQr = null; lastError = null; });
    client.on('auth_failure', (msg) => { status = 'auth_failure'; lastError = String(msg); });
    client.on('disconnected', (reason) => { status = 'disconnected'; lastError = String(reason); client = null; });

    await client.initialize();
  } catch (err) {
    status = 'error';
    lastError = err.message;
    client = null;
    console.error('WhatsApp Web automation failed to start (falling back to Meta API / manual send):', err.message);
  }
}

function getStatus() {
  return { enabled: process.env.WHATSAPP_WEB_AUTOMATION === 'true', status, hasQr: !!lastQr, error: lastError || null };
}

async function getQrDataUrl() {
  if (!lastQr) return null;
  return QRCode.toDataURL(lastQr);
}

async function logout() {
  if (!client) return;
  try { await client.logout(); } catch { /* ignore — state resets below regardless */ }
  status = 'disconnected';
  lastQr = null;
  client = null;
}

// `number` is expected pre-normalized (country code, digits only — the same
// shape server/index.js's toWhatsAppNumber() already produces for the free
// wa.me link, reused here so both paths treat a local number the same way).
// Returns null if this path isn't ready to send (caller falls back to Meta
// API / the free wa.me link), or { ok, error? } once it's actually tried.
async function sendMessage(number, text) {
  if (!client || status !== 'ready') return null;
  if (!number) return { ok: false, error: 'No phone number on file for this client.' };
  const chatId = `${number}@c.us`;
  try {
    await client.sendMessage(chatId, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { init, getStatus, getQrDataUrl, logout, sendMessage };
