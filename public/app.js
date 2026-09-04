// Fit Cube ERP — app shell / router / views. Vanilla JS, no build step.

// ---------- theme (light/dark) ----------
// Per-device UI preference only (not synced data) — plain localStorage is
// the right tool here, separate from the IndexedDB business-data mirror.
(function initTheme() {
  try {
    const saved = localStorage.getItem('fitcube-theme'); // 'light' | 'dark' | absent (follow system)
    if (saved) document.documentElement.dataset.theme = saved;
  } catch {}
})();
function currentEffectiveTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function toggleTheme() {
  const next = currentEffectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('fitcube-theme', next); } catch {}
  updateThemeToggleIcon();
}
function updateThemeToggleIcon() {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = currentEffectiveTheme() === 'dark' ? '☀' : '☾';
}

const viewEl = document.getElementById('view');
const modalRoot = document.getElementById('modal-root');
const statusPill = document.getElementById('status-pill');

// ---------- helpers ----------

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function money(n) {
  if (n === null || n === undefined) return '$0';
  const v = Number(n);
  return '$' + (Number.isInteger(v) ? v : v.toFixed(2));
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d.includes('T') || d.includes(' ') ? d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z') : d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function todayLocalISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset();
  return new Date(d.getTime() - tz * 60000).toISOString().slice(0, 16);
}

async function refreshStatusPill() {
  const count = await idb.outboxCount();
  if (!navigator.onLine) {
    statusPill.textContent = count ? `Offline · ${count} pending` : 'Offline';
    statusPill.className = 'status-pill offline';
  } else if (count) {
    statusPill.textContent = `Syncing ${count}…`;
    statusPill.className = 'status-pill offline';
  } else {
    statusPill.textContent = 'Online';
    statusPill.className = 'status-pill';
  }
}
window.addEventListener('online', refreshStatusPill);
window.addEventListener('offline', refreshStatusPill);
window.addEventListener('fitcube:synced', () => { refreshStatusPill(); render(); });

async function sendWhatsAppReminder(client, message, bodyParams) {
  if (!client.phone) { alert('No phone number on file for this client.'); return; }
  // Try the optional automatic Cloud API send first (only "configured" if
  // Anthony has set up WhatsApp Business API credentials on the server).
  const sendResult = await api.whatsappSend(client.phone, client.name, bodyParams);
  if (sendResult.configured) {
    if (sendResult.ok) alert(`Reminder sent to ${client.name} automatically via WhatsApp.`);
    else alert(`Couldn't send automatically (${sendResult.error || 'unknown error'}) — falling back to opening WhatsApp.`);
    if (sendResult.ok) return;
  }
  // Default $0 path: build a wa.me link and open it — this opens the
  // WhatsApp app directly on a phone (not a browser tab); one tap to send.
  try {
    const { url } = await api.whatsappLink(client.phone, message);
    window.open(url, '_blank');
  } catch (err) {
    alert("Couldn't open WhatsApp: " + err.message);
  }
}

// While a modal is open the page behind it must not scroll. iOS Safari
// ignores `overflow: hidden` on the body, so the reliable fix is to pin the
// body in place at its current scroll offset and restore that offset when the
// modal closes.
let scrollLockY = 0;
let scrollLocked = false;
function lockPageScroll() {
  if (scrollLocked) return;
  scrollLockY = window.scrollY || window.pageYOffset || 0;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${scrollLockY}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
  scrollLocked = true;
}
function unlockPageScroll() {
  if (!scrollLocked) return;
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  scrollLocked = false;
  window.scrollTo(0, scrollLockY);
}

function closeModal() {
  modalRoot.innerHTML = '';
  unlockPageScroll();
}
function openModal(innerHtml) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-sheet">
        <div class="modal-wrap">
          <button class="close-x" id="modal-close">✕</button>
          ${innerHtml}
        </div>
      </div>
    </div>`;
  lockPageScroll();
  document.getElementById('modal-close').onclick = closeModal;
  const backdrop = document.getElementById('modal-backdrop');
  backdrop.addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  // Dragging the dimmed area outside the sheet shouldn't move anything.
  backdrop.addEventListener('touchmove', (e) => {
    if (e.target === backdrop) e.preventDefault();
  }, { passive: false });
}

// Wires a save/submit button so its handler can never run twice at once.
// Every "Save" button in the app used to fire its async handler again on a
// second tap or Enter-key-repeat while the first request was still in
// flight — on a slow connection (or Render's free tier waking up) that's
// easy to do without meaning to, and it was the actual cause behind reports
// like "the session got logged twice" or "the photo uploaded twice": each
// tap made its own real request, so idempotency keys couldn't catch it —
// only not sending the second request in the first place can. The button is
// disabled and shows "Saving…" for the duration of the handler; a thrown
// error is shown to the user and re-enables the button, and a handler that
// simply returns (a validation check that isn't ready to submit yet) also
// re-enables it, silently.
function guardedClick(btnId, handler) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const originalText = btn.textContent;
  let running = false;
  btn.addEventListener('click', async (e) => {
    if (running || btn.disabled) return;
    running = true;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await handler(e);
    } catch (err) {
      alert('Could not save: ' + (err && err.message ? err.message : err));
    } finally {
      running = false;
      // The handler may have already closed the modal (removing the
      // button from the DOM) or navigated away — only touch it if it's
      // still there.
      if (document.body.contains(btn)) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  });
}

// ---------- router ----------

function currentRoute() {
  const raw = location.hash.replace(/^#\//, '') || 'dashboard';
  const [path, queryStr] = raw.split('?');
  const [route, param] = path.split('/');
  return { route, param, query: new URLSearchParams(queryStr || '') };
}

async function render() {
  const { route, param, query } = currentRoute();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.route === route));
  refreshStatusPill();

  if (route === 'dashboard') return renderDashboard();
  if (route === 'accounting') return renderAccounting();
  // #/clients/new?name=…&phone=… — lets an iOS Shortcut (or any link) hand a
  // contact straight into the New client form, which is the closest thing
  // iPhone allows to picking from the address book inside a web app.
  if (route === 'clients' && param === 'new') {
    await renderClientsList();
    openAddClientModal({ name: query.get('name') || '', phone: query.get('phone') || '' });
    // Clean the URL without triggering another render.
    history.replaceState(null, '', '#/clients');
    return;
  }
  if (route === 'clients' && !param) return renderClientsList();
  if (route === 'clients' && param) return renderClientDetail(param);
  if (route === 'schedule') return renderSchedule();
  if (route === 'inventory') return renderInventory();
  if (route === 'sales') return renderSales();
  if (route === 'settings') return renderSettings();
  return renderDashboard();
}
// Leaving the current screen should dismiss whatever sheet is open (and
// release the background scroll lock with it). Background sync also calls
// render(), so this deliberately hangs off hashchange rather than render.
window.addEventListener('hashchange', () => { closeModal(); render(); });
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => { location.hash = '#/' + btn.dataset.route; });
});

// ---------- dashboard ----------

// Kept deliberately short: four numbers that call for action today (who's
// coming in, who owes money, how big the client base is, what's prepaid) —
// everything money-detailed (revenue, margin, cost of goods) lives on the
// Accounting page instead, one tap away, so this screen doesn't turn into a
// wall of figures every time it opens.
async function renderDashboard() {
  viewEl.innerHTML = `<h1>Overview</h1><div class="empty">Loading…</div>`;
  const { data, fromCache } = await api.dashboardSummary();
  if (!data) { viewEl.innerHTML = `<h1>Overview</h1><div class="empty">No data yet — connect once online to load your dashboard.</div>`; return; }
  viewEl.innerHTML = `
    <h1>Overview</h1>
    ${fromCache ? `<div class="sync-banner">Showing last saved data — you're offline.</div>` : ''}
    <div class="grid-2">
      <div class="card"><div class="stat">${data.appointments_today}</div><div class="stat-label">Appointments today</div></div>
      <div class="card" style="cursor:pointer" onclick="location.hash='#/clients'"><div class="stat">${data.active_clients}</div><div class="stat-label">Active clients</div></div>
      <div class="card"><div class="stat" style="color:var(--unpaid)">${money(data.unpaid_total)}</div><div class="stat-label">Unpaid balance (${data.unpaid_entries} entries)</div></div>
      <div class="card"><div class="stat" style="color:var(--credit)">${data.prepaid_credit_sessions}</div><div class="stat-label">Prepaid session credits</div></div>
    </div>
    ${data.low_stock_products > 0 ? `<div class="card" style="border-color:var(--unpaid)">⚠ ${data.low_stock_products} product(s) at or below reorder level — check Stock.</div>` : ''}

    <h2>Quick actions</h2>
    <div class="action-grid">
      <button class="action-tile primary" onclick="location.hash='#/clients'"><span class="ic">👥</span>View clients</button>
      <button class="action-tile" onclick="location.hash='#/schedule'"><span class="ic">📅</span>Schedule</button>
      ${isOwner() ? `<button class="action-tile" onclick="location.hash='#/accounting'"><span class="ic">💰</span>Accounting</button>` : ''}
      <button class="action-tile" id="manage-templates-btn"><span class="ic">✉️</span>Message templates</button>
    </div>

  `;
  document.getElementById('manage-templates-btn').addEventListener('click', () => openTemplateManagerModal());
}

// Revenue, margin, and everything money-detailed — moved off Overview so
// that screen stays to the handful of numbers worth checking every day.
// Owner only: the server itself withholds these fields from a staff account,
// so this also bounces straight back if one somehow lands here.
async function renderAccounting() {
  if (!isOwner()) { location.hash = '#/dashboard'; return; }
  viewEl.innerHTML = `<button class="btn secondary" onclick="location.hash='#/dashboard'" style="margin-bottom:10px">← Overview</button><h1>Accounting</h1><div class="empty">Loading…</div>`;
  const { data, fromCache } = await api.dashboardSummary();
  if (!data || data.revenue_total === undefined) {
    viewEl.innerHTML = `<button class="btn secondary" onclick="location.hash='#/dashboard'" style="margin-bottom:10px">← Overview</button><h1>Accounting</h1><div class="empty">No data yet — connect once online to load this page.</div>`;
    return;
  }
  viewEl.innerHTML = `
    <button class="btn secondary" onclick="location.hash='#/dashboard'" style="margin-bottom:10px">← Overview</button>
    <h1>Accounting</h1>
    ${fromCache ? `<div class="sync-banner">Showing last saved data — you're offline.</div>` : ''}

    <div class="grid-2">
      <div class="card"><div class="stat" style="color:var(--accent)">${money(data.revenue_total)}</div><div class="stat-label">Total revenue collected</div></div>
      <div class="card"><div class="stat" style="color:var(--accent)">${money(data.gross_profit)}</div><div class="stat-label">Gross profit</div></div>
    </div>

    <h2>Profit &amp; loss</h2>
    <div class="card">
      <div class="session-row"><div>Session revenue</div><div>${money(data.session_revenue_total)}</div></div>
      <div class="session-row"><div>Product sales revenue</div><div>${money(data.product_revenue_total)}</div></div>
      <div class="session-row"><div>Cost of goods sold</div><div>${money(data.cogs_total)}</div></div>
      <div class="session-row"><div>Money spent restocking</div><div>${money(data.purchases_total)}</div></div>
      <div class="session-row"><div>Current inventory value (at cost)</div><div>${money(data.inventory_value)}</div></div>
    </div>

    <h2>Revenue by service</h2>
    <div id="acct-revenue-report"><div class="empty">Loading…</div></div>
  `;
  try {
    const { data: revenue, fromCache: revenueFromCache } = await api.revenueReport();
    document.getElementById('acct-revenue-report').innerHTML = revenue
      ? revenueSectionHtml(revenue, revenueFromCache)
      : '<div class="empty">No revenue data yet.</div>';
  } catch (err) {
    document.getElementById('acct-revenue-report').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

// ---------- backups ----------

// A backup is only useful if it actually leaves the server, so the app keeps
// track of when one was last saved and nags when it's been too long.
const BACKUP_STALE_DAYS = 7;
const LAST_BACKUP_KEY = 'fitcube:lastBackup';

function lastBackupAt() {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    return raw ? new Date(raw) : null;
  } catch (err) {
    return null;
  }
}
function markBackupSaved() {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  } catch (err) {
    // private mode / storage disabled — the backup still saved, just untracked
  }
  // Refresh the screen showing "Last backup: …" so it reflects what just
  // happened instead of waiting for the next visit.
  if (currentRoute().route === 'settings') renderSettings();
}
function daysSinceBackup() {
  const at = lastBackupAt();
  if (!at || isNaN(at.getTime())) return null;
  return Math.floor((Date.now() - at.getTime()) / 86400000);
}
function backupStatusLine() {
  const days = daysSinceBackup();
  if (days === null) return 'No backup saved from this phone yet — save one now so you have your own copy.';
  if (days === 0) return 'Last backup: today.';
  if (days === 1) return 'Last backup: yesterday.';
  return `Last backup: ${days} days ago.`;
}
// Used only in Settings now (Overview used to show this nudge itself; moved
// here so a slow or unpaid-balance-heavy Overview screen doesn't also carry
// a permanent warning card at the top).
function backupIsStale() {
  const days = daysSinceBackup();
  return days === null || days >= BACKUP_STALE_DAYS;
}

let pendingBackup = null;

async function prepareBackup(btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  // Building the snapshot takes several seconds on the free tier, so say so
  // rather than leaving a dead button.
  openModal(`
    <h3>Preparing your backup…</h3>
    <div class="sub" style="line-height:1.45">Collecting every client, session, photo and sale. This takes a few seconds — the save options appear as soon as it's ready.</div>
  `);
  try {
    const res = await fetch('/api/backup/export', { cache: 'no-store' });
    if (!res.ok) throw new Error('the server returned ' + res.status);
    const text = await res.text();
    const dump = JSON.parse(text);
    const summary = Object.keys(dump)
      .filter((k) => Array.isArray(dump[k]) && dump[k].length)
      .map((k) => `${dump[k].length} ${k.replace(/_/g, ' ')}`)
      .join(' · ');
    const filename = `fitcube-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const blob = new Blob([text], { type: 'application/json' });
    pendingBackup = { blob, filename };
    openBackupSaveModal(summary, Math.max(1, Math.round(blob.size / 1024)));
  } catch (err) {
    closeModal();
    alert('Couldn\'t prepare the backup: ' + err.message + '\n\nYou need to be online to make a backup.');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// The share sheet has to be opened by its own tap — iOS refuses it if the tap
// that started things has already been spent waiting on a network request.
// Hence the two steps: prepare the file, then offer it in this sheet.
function openBackupSaveModal(summary, sizeKb) {
  const canShareFiles = !!(navigator.canShare && pendingBackup &&
    navigator.canShare({ files: [new File([pendingBackup.blob], pendingBackup.filename, { type: 'application/json' })] }));
  openModal(`
    <h3>Backup ready</h3>
    <div class="sub" style="margin-bottom:4px">${esc(pendingBackup.filename)} · ${sizeKb} KB</div>
    ${summary ? `<div class="sub" style="margin-bottom:12px;line-height:1.45">${esc(summary)}</div>` : ''}
    ${canShareFiles ? `
      <button class="btn block" id="backup-share-btn">Save to Files or Google Drive</button>
      <div class="sub" style="margin:8px 0 14px;line-height:1.45">Pick <b>Save to Files</b> for a copy on this phone, or <b>Drive</b> to upload it. You can tap this button twice to do both.</div>
    ` : ''}
    <button class="btn ${canShareFiles ? 'secondary ' : ''}block" id="backup-download-btn">Download the file</button>
  `);
  const shareBtn = document.getElementById('backup-share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      if (!pendingBackup) return;
      const file = new File([pendingBackup.blob], pendingBackup.filename, { type: 'application/json' });
      try {
        await navigator.share({ files: [file], title: 'Fit Cube backup' });
        markBackupSaved();
      } catch (err) {
        // AbortError just means the share sheet was dismissed — not a failure.
        if (err && err.name !== 'AbortError') {
          alert('Sharing failed: ' + err.message + '\n\nUse "Download the file" instead.');
        }
      }
    });
  }
  document.getElementById('backup-download-btn').addEventListener('click', () => {
    if (!pendingBackup) return;
    const url = URL.createObjectURL(pendingBackup.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = pendingBackup.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    markBackupSaved();
    closeModal();
  });
}

// The server-side automatic snapshots (see maybeCreateSnapshot in
// server/index.js) shown and managed from Settings → Automatic backups.
async function openSnapshotsModal() {
  openModal(`<h3>Automatic backups</h3><div class="empty">Loading…</div>`);
  let rows;
  try {
    rows = await api.listSnapshots();
  } catch (err) {
    openModal(`<h3>Automatic backups</h3><div class="empty">${esc(err.message)}</div>`);
    return;
  }
  openModal(`
    <h3>Automatic backups</h3>
    <div class="sub" style="margin-bottom:12px;line-height:1.45">Taken automatically, roughly once a day, and stored separately from anything saved by hand — up to the last 14 are kept.</div>
    ${rows.length ? rows.map((r) => `
      <div class="session-row">
        <div>
          <div>${fmtDate(r.created_at)}</div>
          <div class="sub">${r.client_count ?? 0} client${r.client_count === 1 ? '' : 's'} · ${Math.max(1, Math.round((r.size_bytes || 0) / 1024))} KB</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn secondary" data-save-snap="${r.id}" style="padding:6px 10px;font-size:0.78rem">Save a copy</button>
          <button class="btn danger" data-restore-snap="${r.id}" style="padding:6px 10px;font-size:0.78rem">Restore</button>
        </div>
      </div>
    `).join('') : '<div class="empty">No automatic backup yet — the first one is taken shortly after the app is next opened.</div>'}
  `);
  document.querySelectorAll('[data-save-snap]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = rows.find((r) => String(r.id) === btn.dataset.saveSnap);
      if (row) saveSnapshotCopy(row);
    });
  });
  document.querySelectorAll('[data-restore-snap]').forEach((btn) => {
    btn.addEventListener('click', () => restoreSnapshotConfirmed(btn.dataset.restoreSnap));
  });
}

async function saveSnapshotCopy(row) {
  try {
    const text = await api.fetchSnapshotDump(row.id);
    const filename = `fitcube-snapshot-${String(row.created_at).slice(0, 10)}.json`;
    const blob = new Blob([text], { type: 'application/json' });
    pendingBackup = { blob, filename };
    openBackupSaveModal(`${row.client_count ?? 0} clients`, Math.max(1, Math.round(blob.size / 1024)));
  } catch (err) {
    alert('Could not load that backup: ' + err.message);
  }
}

async function restoreSnapshotConfirmed(id) {
  if (!confirm('This replaces ALL current data on the server with this automatic backup. This cannot be undone. Continue?')) return;
  try {
    const result = await api.restoreSnapshot(id);
    for (const store of ['clients', 'services', 'products', 'appointments', 'meta']) {
      await idb.clear(store);
    }
    alert('Restore complete: ' + result.restored.map((r) => `${r.table} (${r.count})`).join(', '));
    location.reload();
  } catch (err) {
    alert('Restore failed: ' + err.message);
  }
}

// ---------- clients ----------

const INACTIVE_DAYS = 30;

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function lastVisitLabel(c) {
  const days = daysSince(c.balance && c.balance.last_activity);
  if (days === null) return 'No sessions logged yet';
  if (days <= 0) return 'Last session: today';
  if (days === 1) return 'Last session: yesterday';
  return `Last session: ${days}d ago`;
}

function clientBadges(c) {
  const b = c.balance;
  if (!b) return '';
  const parts = [];
  const unpaidTotal = (Number(b.unpaid_amount) || 0);
  const unpaidNoAmt = Number(b.unpaid_sessions_no_amount) || 0;
  const credits = Number(b.prepaid_session_credits) || 0;
  const days = daysSince(b.last_activity);
  if (unpaidTotal > 0) parts.push(`<span class="badge unpaid">owes ${money(unpaidTotal)}</span>`);
  if (unpaidNoAmt > 0) parts.push(`<span class="badge unpaid">${unpaidNoAmt} unpaid session${unpaidNoAmt > 1 ? 's' : ''}</span>`);
  if (credits > 0) parts.push(`<span class="badge credit">${credits} credit${credits > 1 ? 's' : ''}</span>`);
  if (days !== null && days > INACTIVE_DAYS) parts.push(`<span class="badge neutral">at risk</span>`);
  return parts.join(' ');
}

function sortClients(list, mode) {
  const arr = [...list];
  if (mode === 'active') {
    arr.sort((a, b) => (Number(b.balance?.total_sessions) || 0) - (Number(a.balance?.total_sessions) || 0));
  } else if (mode === 'inactive') {
    arr.sort((a, b) => {
      const da = daysSince(a.balance?.last_activity);
      const db = daysSince(b.balance?.last_activity);
      if (da === null && db === null) return 0;
      if (da === null) return -1; // never-seen clients surface first as most "at risk"
      if (db === null) return 1;
      return db - da;
    });
  } else {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  return arr;
}

let _clientsCache = [];
let _clientSort = 'name';

async function renderClientsList() {
  viewEl.innerHTML = `<h1>Clients</h1><div class="empty">Loading…</div>`;
  const { data, fromCache } = await api.listClients();
  _clientsCache = data;
  paintClientsList(data, fromCache);
}

function paintClientsList(data, fromCache) {
  const rows = data.filter((c) => !c.archived);
  viewEl.innerHTML = `
    <h1>Clients</h1>
    <div class="sub" style="margin-bottom:10px">${rows.length} client${rows.length === 1 ? '' : 's'}${data.length !== rows.length ? ` (${data.length - rows.length} archived)` : ''}</div>
    ${fromCache ? `<div class="sync-banner">Showing saved data — you're offline.</div>` : ''}
    <input class="search" id="client-search" placeholder="Search clients…" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <div class="segmented" id="client-sort">
      <button data-mode="name" class="${_clientSort === 'name' ? 'active' : ''}">A–Z</button>
      <button data-mode="active" class="${_clientSort === 'active' ? 'active' : ''}">Most active</button>
      <button data-mode="inactive" class="${_clientSort === 'inactive' ? 'active' : ''}">Not coming anymore</button>
    </div>
    <div id="client-rows"></div>
    <button class="fab" id="add-client-fab" title="Add client">+</button>
  `;
  document.querySelectorAll('#client-sort button').forEach((btn) => {
    btn.addEventListener('click', () => {
      _clientSort = btn.dataset.mode;
      paintClientsList(_clientsCache, fromCache);
    });
  });
  const paintRows = (list) => {
    const el = document.getElementById('client-rows');
    const sorted = sortClients(list, _clientSort);
    if (!sorted.length) { el.innerHTML = `<div class="empty">No clients found.</div>`; return; }
    el.innerHTML = sorted.map((c) => `
      <div class="list-row" data-id="${c.id}">
        <div>
          <div class="name">${esc(c.name)}${c._pending ? ' <span class="pending-note">(pending sync)</span>' : ''}</div>
          <div class="sub">${esc(c.phone || 'No phone on file')} · ${lastVisitLabel(c)}</div>
        </div>
        <div>${clientBadges(c)}</div>
      </div>`).join('');
    el.querySelectorAll('.list-row').forEach((row) => {
      row.addEventListener('click', () => { location.hash = '#/clients/' + row.dataset.id; });
    });
  };
  paintRows(rows);
  document.getElementById('client-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    paintRows(rows.filter((c) => c.name.toLowerCase().includes(q) || (c.phone || '').includes(q)));
  });
  document.getElementById('add-client-fab').addEventListener('click', () => openAddClientModal());
}

// Android Chrome implements the Contact Picker API, which opens the real
// address book. iOS Safari does not (Apple only allows native apps to browse
// Contacts), so there we fall back to reading the clipboard — the user copies
// the number in the Contacts app and taps one button here.
const CONTACT_PICKER_SUPPORTED = 'contacts' in navigator && 'ContactsManager' in window;
const CLIPBOARD_READ_SUPPORTED = !!(navigator.clipboard && navigator.clipboard.readText);

// Renders the button that fills a phone field from the address book. Call
// contactPickerButtonHtml() where the button should render, then
// wireContactPicker() once the modal's HTML is in the DOM.
function contactPickerButtonHtml(btnId) {
  if (CONTACT_PICKER_SUPPORTED) {
    return `<button type="button" class="btn secondary block" id="${btnId}" style="margin-bottom:6px">Choose from Contacts</button>`;
  }
  if (CLIPBOARD_READ_SUPPORTED) {
    return `<button type="button" class="btn secondary block" id="${btnId}" style="margin-bottom:6px">Paste number from Contacts</button>`;
  }
  return '';
}
function wireContactPicker(btnId, phoneInputId, nameInputId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (CONTACT_PICKER_SUPPORTED) {
      try {
        const [contact] = await navigator.contacts.select(['name', 'tel'], { multiple: false });
        if (contact) {
          if (nameInputId && contact.name && contact.name[0]) document.getElementById(nameInputId).value = contact.name[0];
          if (contact.tel && contact.tel[0]) document.getElementById(phoneInputId).value = contact.tel[0];
        }
      } catch (err) {
        // user cancelled the picker, or permission denied — nothing to do
      }
      return;
    }
    // iPhone path: pull whatever number was copied in the Contacts app.
    try {
      const text = await navigator.clipboard.readText();
      const number = (text || '').replace(/[^\d+]/g, '');
      if (!number) {
        alert('Nothing copied yet.\n\nOpen Contacts, press and hold the phone number, tap Copy — then come back here and tap this button again.');
        return;
      }
      document.getElementById(phoneInputId).value = number;
    } catch (err) {
      alert('Couldn\'t read what you copied.\n\nPress and hold the Phone box below and tap Paste instead.');
    }
  });
}

function openAddClientModal(prefill = {}) {
  openModal(`
    <h3>New client</h3>
    ${contactPickerButtonHtml('pick-contact-btn')}
    <form id="f-contact-form" autocomplete="on" onsubmit="event.preventDefault()">
      <label>Name</label>
      <input id="f-name" name="name" placeholder="Full name" autocomplete="name" value="${esc(prefill.name || '')}" />
      <label>Phone</label>
      <input id="f-phone" name="tel" placeholder="70 123 456" autocomplete="tel" type="tel" value="${esc(prefill.phone || '')}" />
    </form>
    <label>Notes</label><textarea id="f-notes" placeholder="Optional"></textarea>
    <label>Goal (optional)</label>
    <input id="f-goal" placeholder="e.g. Lose 5kg by December, fix squat form" autocomplete="off" />
    <label>Preferred music (optional)</label>
    <input id="f-music" placeholder="Paste a Spotify / Anghami / SoundCloud / YouTube link" autocomplete="off" />
    <div class="btn-row"><button class="btn block" id="f-save">Save client</button></div>
  `);
  wireContactPicker('pick-contact-btn', 'f-phone', 'f-name');
  guardedClick('f-save', async () => {
    const name = document.getElementById('f-name').value.trim();
    if (!name) return;
    const phone = document.getElementById('f-phone').value.trim();
    const notes = document.getElementById('f-notes').value.trim();
    const musicLink = document.getElementById('f-music').value.trim();
    const goal = document.getElementById('f-goal').value.trim();
    await api.createClient({ name, phone: phone || null, notes: notes || null, music_link: musicLink || null, goal: goal || null });
    closeModal();
    renderClientsList();
  });
}

async function renderClientDetail(id) {
  viewEl.innerHTML = `<div class="empty">Loading…</div>`;
  const { data: c, fromCache } = await api.getClient(id);
  if (!c) { viewEl.innerHTML = `<div class="empty">Client not found (and not cached offline).</div>`; return; }
  const sessions = c.sessions || [];
  const appts = c.appointments || [];
  const photos = c.photos || [];
  const metrics = c.metrics || [];
  const unpaidTotal = sessions.filter((s) => s.payment_state === 'unpaid').reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const unpaidNoAmt = sessions.filter((s) => s.payment_state === 'unpaid' && s.amount === null).length;
  const credits = sessions.filter((s) => s.payment_state === 'prepaid' && s.amount === null).length;

  viewEl.innerHTML = `
    <button class="btn secondary" onclick="location.hash='#/clients'" style="margin-bottom:10px">← Clients</button>
    ${fromCache ? `<div class="sync-banner">Showing saved data — you're offline.</div>` : ''}
    <h1>${esc(c.name)}</h1>
    <div class="card">
      <div class="sub" style="margin-bottom:6px">${esc(c.phone || 'No phone on file')}</div>
      ${c.notes ? `<div class="sub">${esc(c.notes)}</div>` : ''}
      <div class="btn-row">
        <button class="btn secondary" id="edit-client-btn">Edit contact info</button>
        ${c.phone ? `<button class="btn secondary" id="remind-btn">Remind</button>` : ''}
      </div>
    </div>

    <div class="grid-2">
      <div class="card"><div class="stat" style="color:var(--unpaid)">${money(unpaidTotal)}</div><div class="stat-label">Owed${unpaidNoAmt ? ` + ${unpaidNoAmt} unpaid session(s)` : ''}</div></div>
      <div class="card"><div class="stat" style="color:var(--credit)">${credits}</div><div class="stat-label">Prepaid credits left</div></div>
    </div>

    <div class="btn-row">
      <button class="btn block" id="log-session-btn">Log session</button>
      <button class="btn secondary block" id="add-appt-btn">Schedule</button>
    </div>

    <h2>Progress photos</h2>
    <div class="photo-strip" id="photo-strip">
      ${photos.map((p) => `<div class="photo-thumb" data-id="${p.id}"><img src="${p.image_data}" loading="lazy" /></div>`).join('')}
      <button class="photo-add-btn" id="add-photo-btn" title="Add progress photo">+</button>
    </div>
    ${!photos.length ? '<div class="empty">No progress photos yet — tap + to add one.</div>' : ''}

    <h2>Progress metrics</h2>
    <div class="card">
      ${c.goal ? `<div class="sub" style="margin-bottom:10px;color:var(--accent);font-weight:600">🎯 Goal: ${esc(c.goal)}</div>` : ''}
      ${weightSparklineSvg(metrics)}
      ${metrics.length ? [...metrics].reverse().map((m) => metricRowHtml(m)).join('') : '<div class="empty">No progress metrics logged yet.</div>'}
    </div>
    <button class="btn secondary block" id="add-metric-btn" style="margin-bottom:14px">+ Log weight / measurements</button>

    ${c.music_link ? `
    <h2>Preferred music</h2>
    <div class="card">
      <button class="btn secondary block" id="music-btn">${musicPlatformInfo(c.music_link).icon} Play on ${musicPlatformInfo(c.music_link).label}</button>
    </div>
    ` : ''}

    <h2>Session history</h2>
    <div class="card">
      ${sessions.length ? sessions.map((s) => sessionRowHtml(s)).join('') : '<div class="empty">No sessions logged yet.</div>'}
    </div>

    <h2>Appointments</h2>
    <div class="card">
      ${appts.length ? appts.map((a) => `
        <div class="session-row">
          <div><div>${esc(a.service_name || 'Session')}</div><div class="sub">${fmtDate(a.starts_at)} · ${a.status}</div></div>
          ${a.status === 'scheduled' && c.phone ? `<button class="btn secondary" style="padding:6px 10px;font-size:0.75rem" data-remind="${a.id}" data-service="${esc(a.service_name || 'training')}" data-when="${a.starts_at}">Remind</button>` : ''}
        </div>`).join('') : '<div class="empty">No appointments scheduled.</div>'}
    </div>
  `;

  document.getElementById('edit-client-btn').addEventListener('click', () => openEditClientModal(c));
  document.getElementById('log-session-btn').addEventListener('click', () => openLogSessionModal(c.id));
  document.getElementById('add-appt-btn').addEventListener('click', () => openAddAppointmentModal(c.id));
  const remindBtn = document.getElementById('remind-btn');
  if (remindBtn) remindBtn.addEventListener('click', () => {
    const nextAppt = appts
      .filter((a) => a.status === 'scheduled' && new Date(a.starts_at) >= new Date())
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0] || null;
    openSendReminderModal(c, unpaidTotal, nextAppt);
  });
  const musicBtn = document.getElementById('music-btn');
  if (musicBtn) musicBtn.addEventListener('click', () => window.open(c.music_link, '_blank'));
  document.getElementById('add-photo-btn').addEventListener('click', () => openAddPhotoModal(c.id));
  document.querySelectorAll('#photo-strip .photo-thumb').forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const p = photos.find((x) => String(x.id) === thumb.dataset.id);
      if (p) openPhotoLightbox(p, c.id);
    });
  });
  document.getElementById('add-metric-btn').addEventListener('click', () => openAddMetricModal(c.id));
  viewEl.querySelectorAll('[data-remove-metric]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this metric entry?')) return;
      await api.deleteMetric(btn.dataset.removeMetric, id);
      renderClientDetail(id);
    });
  });
  viewEl.querySelectorAll('[data-remind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = `Hi ${c.name}, reminder from Fit Cube: your ${btn.dataset.service} session is on ${fmtDate(btn.dataset.when)}. See you then!`;
      sendWhatsAppReminder(c, msg, [c.name, btn.dataset.service, fmtDate(btn.dataset.when)]);
    });
  });

  viewEl.querySelectorAll('[data-mark-paid]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.updateSession(btn.dataset.markPaid, { payment_state: 'paid_now' }, id);
      renderClientDetail(id);
    });
  });
  viewEl.querySelectorAll('[data-remove-session]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Remove this session entry?')) return;
      await api.deleteSession(btn.dataset.removeSession, id);
      renderClientDetail(id);
    });
  });
}

function sessionRowHtml(s) {
  const stateBadge = s.payment_state === 'unpaid'
    ? `<span class="badge unpaid">unpaid${s.amount ? ' · ' + money(s.amount) : ''}</span>`
    : s.payment_state === 'prepaid'
      ? `<span class="badge credit">credit${s.amount ? ' · ' + money(s.amount) : ''}</span>`
      : `<span class="badge neutral">paid ${money(s.amount)}</span>`;
  const tag = s.tag ? `<span class="tag-chip">${esc(s.tag)}</span>` : '';
  return `
    <div class="session-row">
      <div>
        <div>${esc(s.service_name || 'Session')} ${tag}</div>
        <div class="sub">${s.session_date ? fmtDate(s.session_date) : (s.created_at ? fmtDate(s.created_at) : '')}${s.note ? ' · ' + esc(s.note) : ''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        ${stateBadge}
        ${s.payment_state === 'unpaid' ? `<button class="btn secondary" style="padding:6px 10px;font-size:0.75rem" data-mark-paid="${s.id}">Mark paid</button>` : ''}
        <button class="btn danger" style="padding:6px 8px;font-size:0.75rem" data-remove-session="${s.id}">×</button>
      </div>
    </div>`;
}

function openEditClientModal(c) {
  openModal(`
    <h3>Edit ${esc(c.name)}</h3>
    <form id="f-contact-form" autocomplete="on" onsubmit="event.preventDefault()">
      <label>Name</label>
      <input id="f-name" name="name" value="${esc(c.name)}" autocomplete="name" />
      <label>Phone</label>
      <input id="f-phone" name="tel" value="${esc(c.phone || '')}" type="tel" autocomplete="tel" placeholder="70 123 456" />
    </form>
    <label>Notes</label><textarea id="f-notes">${esc(c.notes || '')}</textarea>
    <label>Goal</label>
    <input id="f-goal" value="${esc(c.goal || '')}" placeholder="e.g. Lose 5kg by December, fix squat form" autocomplete="off" />
    <label>Preferred music</label>
    <input id="f-music" value="${esc(c.music_link || '')}" placeholder="Paste a Spotify / Anghami / SoundCloud / YouTube link" autocomplete="off" />
    <div class="btn-row">
      <button class="btn block" id="f-save">Save</button>
      <button class="btn danger" id="f-archive">Archive client</button>
    </div>
  `);
  guardedClick('f-save', async () => {
    const name = document.getElementById('f-name').value.trim();
    if (!name) { alert('Name is required.'); return; }
    // Sent as '' rather than null when cleared: the server's UPDATE uses
    // COALESCE(?, column), which treats null as "leave unchanged" — so an
    // empty string is what actually lets you clear a field here.
    await api.updateClient(c.id, {
      name,
      phone: document.getElementById('f-phone').value.trim(),
      notes: document.getElementById('f-notes').value.trim(),
      goal: document.getElementById('f-goal').value.trim(),
      music_link: document.getElementById('f-music').value.trim(),
    });
    closeModal();
    renderClientDetail(c.id);
  });
  document.getElementById('f-archive').addEventListener('click', async () => {
    if (!confirm('Archive this client? They will be hidden from the active list.')) return;
    await api.updateClient(c.id, { archived: true });
    closeModal();
    location.hash = '#/clients';
  });
}

// ---------- music link ----------

function musicPlatformInfo(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('spotify')) return { label: 'Spotify', icon: '🎧' };
  if (u.includes('anghami')) return { label: 'Anghami', icon: '🎵' };
  if (u.includes('soundcloud')) return { label: 'SoundCloud', icon: '☁️' };
  if (u.includes('youtube') || u.includes('youtu.be')) return { label: 'YouTube', icon: '▶️' };
  return { label: 'Music', icon: '🎵' };
}

// ---------- progress photos ----------

// Resizes + JPEG-compresses a picked photo in the browser before it's ever
// sent anywhere, so a full-resolution phone photo (several MB) becomes a
// couple hundred KB — keeps the app fast and keeps the free database tier
// from filling up.
function compressImageFile(file, maxDim = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) { reject(new Error('That file is not an image.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not open that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function openAddPhotoModal(clientId) {
  openModal(`
    <h3>Add progress photo</h3>
    <label>Photo</label>
    <input id="f-photo-file" type="file" accept="image/*" capture="environment" />
    <div id="f-photo-preview" style="margin-top:10px"></div>
    <label>Caption</label><input id="f-photo-caption" placeholder="Optional — e.g. Week 4" />
    <div class="btn-row"><button class="btn block" id="f-save" disabled>Save photo</button></div>
  `);
  let dataUrl = null;
  const fileInput = document.getElementById('f-photo-file');
  const preview = document.getElementById('f-photo-preview');
  const saveBtn = document.getElementById('f-save');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    saveBtn.disabled = true;
    preview.innerHTML = `<div class="sub">Preparing photo…</div>`;
    try {
      dataUrl = await compressImageFile(file);
      preview.innerHTML = `<img src="${dataUrl}" style="max-width:100%;border-radius:10px;display:block" />`;
      saveBtn.disabled = false;
    } catch (err) {
      dataUrl = null;
      preview.innerHTML = `<div class="sub" style="color:var(--danger)">${esc(err.message)}</div>`;
    }
  });
  guardedClick('f-save', async () => {
    // Photos are large and slow to upload, which makes an impatient second
    // tap very easy — guardedClick is what stops that becoming two photos.
    if (!dataUrl) return;
    await api.addClientPhoto(clientId, {
      image_data: dataUrl,
      caption: document.getElementById('f-photo-caption').value.trim() || null,
    });
    closeModal();
    renderClientDetail(clientId);
  });
}

function openPhotoLightbox(photo, clientId) {
  openModal(`
    <img src="${photo.image_data}" style="max-width:100%;border-radius:10px;display:block" />
    ${photo.caption ? `<div class="sub" style="margin-top:8px">${esc(photo.caption)}</div>` : ''}
    <div class="sub" style="margin-top:4px">${fmtDate(photo.taken_at || photo.created_at)}</div>
    <div class="btn-row"><button class="btn danger block" id="f-delete-photo">Delete photo</button></div>
  `);
  document.getElementById('f-delete-photo').addEventListener('click', async () => {
    if (!confirm('Delete this photo? This cannot be undone.')) return;
    await api.deletePhoto(photo.id, clientId);
    closeModal();
    renderClientDetail(clientId);
  });
}

// ---------- progress metrics (weight, body fat, measurements) ----------

function metricRowHtml(m) {
  const parts = [];
  if (m.weight !== null && m.weight !== undefined) parts.push(`${m.weight}kg`);
  if (m.body_fat_pct !== null && m.body_fat_pct !== undefined) parts.push(`${m.body_fat_pct}% BF`);
  const measurements = ['chest', 'waist', 'hips', 'arm', 'thigh']
    .filter((k) => m[k] !== null && m[k] !== undefined)
    .map((k) => `${k}: ${m[k]}cm`);
  return `
    <div class="session-row">
      <div>
        <div>${parts.join(' · ') || 'Measurement logged'}</div>
        <div class="sub">${fmtDate(m.metric_date)}${measurements.length ? ' · ' + measurements.join(', ') : ''}${m.note ? ' · ' + esc(m.note) : ''}</div>
      </div>
      <button class="btn danger" style="padding:6px 8px;font-size:0.75rem" data-remove-metric="${m.id}">×</button>
    </div>`;
}

function weightSparklineSvg(metrics) {
  const pts = metrics.filter((m) => m.weight !== null && m.weight !== undefined && m.weight !== '');
  if (pts.length < 2) return '';
  const weights = pts.map((m) => Number(m.weight));
  const min = Math.min(...weights), max = Math.max(...weights);
  const range = max - min || 1;
  const w = 300, h = 60, pad = 6;
  const stepX = (w - pad * 2) / (pts.length - 1);
  const coords = weights.map((wt, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((wt - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `
    <div style="margin-bottom:12px">
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:60px;display:block" preserveAspectRatio="none">
        <polyline points="${coords.join(' ')}" fill="none" style="stroke:var(--accent);stroke-width:2" />
      </svg>
      <div class="sub" style="display:flex;justify-content:space-between;margin-top:2px">
        <span>${weights[0]}kg</span><span>Latest: ${weights[weights.length - 1]}kg</span>
      </div>
    </div>`;
}

function openAddMetricModal(clientId) {
  openModal(`
    <h3>Log weight / measurements</h3>
    <label>Date</label>
    <input id="f-date" type="date" value="${new Date().toISOString().slice(0, 10)}" />
    <label>Weight (kg)</label><input id="f-weight" type="number" step="0.1" placeholder="e.g. 78.5" />
    <label>Body fat %</label><input id="f-bodyfat" type="number" step="0.1" placeholder="Optional" />
    <div class="grid-2">
      <div><label>Chest (cm)</label><input id="f-chest" type="number" step="0.1" placeholder="Optional" /></div>
      <div><label>Waist (cm)</label><input id="f-waist" type="number" step="0.1" placeholder="Optional" /></div>
    </div>
    <div class="grid-2">
      <div><label>Hips (cm)</label><input id="f-hips" type="number" step="0.1" placeholder="Optional" /></div>
      <div><label>Arm (cm)</label><input id="f-arm" type="number" step="0.1" placeholder="Optional" /></div>
    </div>
    <label>Thigh (cm)</label><input id="f-thigh" type="number" step="0.1" placeholder="Optional" />
    <label>Note</label><input id="f-note" placeholder="Optional — how they're feeling, a PR hit, etc." />
    <div class="btn-row"><button class="btn block" id="f-save">Save</button></div>
  `);
  guardedClick('f-save', async () => {
    const val = (id) => { const v = document.getElementById(id).value; return v === '' ? null : Number(v); };
    const weight = val('f-weight'), bodyFat = val('f-bodyfat'), chest = val('f-chest'),
      waist = val('f-waist'), hips = val('f-hips'), arm = val('f-arm'), thigh = val('f-thigh');
    if ([weight, bodyFat, chest, waist, hips, arm, thigh].every((v) => v === null)) {
      alert('Enter at least one measurement.');
      return;
    }
    const dateVal = document.getElementById('f-date').value;
    await api.addClientMetric(clientId, {
      metric_date: dateVal ? dateVal + 'T12:00' : null,
      weight, body_fat_pct: bodyFat, chest, waist, hips, arm, thigh,
      note: document.getElementById('f-note').value.trim() || null,
    });
    closeModal();
    renderClientDetail(clientId);
  });
}

// ---------- reminders / message templates ----------

function fillTemplate(body, vars) {
  return body.replace(/\{(\w+)\}/g, (m, key) => (vars[key] !== undefined && vars[key] !== null ? vars[key] : m));
}

function buildReminderVars(c, unpaidTotal, nextAppt) {
  // {service} sits inside "your {service} session is on {when}" in the
  // default template, so the fallback needs to be a plain word (not
  // "session" itself, which would read as "your session session is on…").
  return {
    name: c.name,
    amount: money(unpaidTotal),
    service: nextAppt ? (nextAppt.service_name || 'training') : 'next',
    when: nextAppt ? fmtDate(nextAppt.starts_at) : 'your next visit',
  };
}

async function openSendReminderModal(c, unpaidTotal, nextAppt) {
  if (!c.phone) { alert('Add a phone number for this client first.'); return; }
  const { data: templates } = await api.listTemplates();
  if (!templates.length) {
    alert('No message templates yet — add one first.');
    openTemplateManagerModal();
    return;
  }
  const vars = buildReminderVars(c, unpaidTotal, nextAppt);
  const preferred = (unpaidTotal > 0 && templates.find((t) => /payment/i.test(t.name)))
    || (nextAppt && templates.find((t) => /session/i.test(t.name)))
    || templates[0];

  openModal(`
    <h3>Send reminder to ${esc(c.name)}</h3>
    <label>Template</label>
    <select id="f-template">${templates.map((t) => `<option value="${t.id}" ${t.id === preferred.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <label>Message (edit freely before sending)</label>
    <textarea id="f-message" rows="4">${esc(fillTemplate(preferred.body, vars))}</textarea>
    <div class="btn-row"><button class="btn block" id="f-send">Send via WhatsApp</button></div>
    <button type="button" class="btn secondary block" id="f-manage-templates" style="margin-top:8px">Manage message templates</button>
  `);

  document.getElementById('f-template').addEventListener('change', (e) => {
    const t = templates.find((x) => String(x.id) === e.target.value);
    document.getElementById('f-message').value = t ? fillTemplate(t.body, vars) : '';
  });
  document.getElementById('f-send').addEventListener('click', () => {
    const msg = document.getElementById('f-message').value.trim();
    if (!msg) return;
    sendWhatsAppReminder(c, msg, [vars.name, vars.service, vars.when]);
    closeModal();
  });
  document.getElementById('f-manage-templates').addEventListener('click', () => openTemplateManagerModal());
}

async function openTemplateManagerModal() {
  const { data: templates } = await api.listTemplates();
  openModal(`
    <h3>Message templates</h3>
    <div class="sub" style="margin-bottom:10px">Placeholders you can use in any template: {name}, {service}, {when}, {amount}.</div>
    <div id="tmpl-rows">${templates.length ? templates.map((t) => templateRowHtml(t)).join('') : '<div class="empty">No templates yet.</div>'}</div>
    <button type="button" class="btn secondary block" id="tmpl-new-btn" style="margin-top:10px">+ New template</button>
  `);
  document.querySelectorAll('[data-edit-tmpl]').forEach((btn) => btn.addEventListener('click', () => {
    const t = templates.find((x) => String(x.id) === btn.dataset.editTmpl);
    openEditTemplateModal(t);
  }));
  document.querySelectorAll('[data-del-tmpl]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Delete this template?')) return;
    await api.deleteTemplate(btn.dataset.delTmpl);
    openTemplateManagerModal();
  }));
  document.getElementById('tmpl-new-btn').addEventListener('click', () => openEditTemplateModal(null));
}

function templateRowHtml(t) {
  return `
    <div class="card" data-id="${t.id}">
      <div style="font-weight:600;margin-bottom:4px">${esc(t.name)}</div>
      <div class="sub" style="white-space:pre-wrap">${esc(t.body)}</div>
      <div class="btn-row">
        <button class="btn secondary" data-edit-tmpl="${t.id}" style="padding:6px 10px;font-size:0.78rem">Edit</button>
        <button class="btn danger" data-del-tmpl="${t.id}" style="padding:6px 10px;font-size:0.78rem">Delete</button>
      </div>
    </div>`;
}

function openEditTemplateModal(t) {
  openModal(`
    <h3>${t ? 'Edit template' : 'New template'}</h3>
    <label>Name</label><input id="f-name" value="${t ? esc(t.name) : ''}" placeholder="e.g. Payment reminder" />
    <label>Message</label><textarea id="f-body" rows="4" placeholder="Hi {name}, ...">${t ? esc(t.body) : ''}</textarea>
    <div class="sub" style="margin-top:4px">Placeholders: {name}, {service}, {when}, {amount}</div>
    <div class="btn-row"><button class="btn block" id="f-save">Save</button></div>
  `);
  guardedClick('f-save', async () => {
    const name = document.getElementById('f-name').value.trim();
    const body = document.getElementById('f-body').value.trim();
    if (!name || !body) return;
    if (t) await api.updateTemplate(t.id, { name, body });
    else await api.createTemplate({ name, body });
    openTemplateManagerModal();
  });
}

async function openLogSessionModal(clientId) {
  const { data: services } = await api.listServices();
  openModal(`
    <h3>Log session</h3>
    <label>Service</label>
    <select id="f-service"><option value="">— none / general —</option>${services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <label>Payment</label>
    <select id="f-state">
      <option value="prepaid">Prepaid credit (session paid in advance)</option>
      <option value="unpaid">Unpaid (owes money)</option>
      <option value="paid_now">Paid now (settle immediately)</option>
    </select>
    <label>Amount (optional for a plain credit/session)</label>
    <input id="f-amount" type="number" step="0.01" placeholder="e.g. 30" />
    <label>Tag</label>
    <select id="f-tag"><option value="">none</option><option value="ems">EMS</option><option value="presso">Presso Therapy</option><option value="kids">Kids training</option></select>
    <label>Note</label><input id="f-note" placeholder="Optional" />
    <div class="btn-row"><button class="btn block" id="f-save">Save</button></div>
  `);
  guardedClick('f-save', async () => {
    const amount = document.getElementById('f-amount').value;
    await api.logSession(clientId, {
      service_id: document.getElementById('f-service').value || null,
      payment_state: document.getElementById('f-state').value,
      amount: amount ? Number(amount) : null,
      tag: document.getElementById('f-tag').value || null,
      note: document.getElementById('f-note').value.trim() || null,
    });
    closeModal();
    renderClientDetail(clientId);
  });
}

async function openAddAppointmentModal(clientId) {
  const { data: services } = await api.listServices();
  openModal(`
    <h3>Schedule appointment</h3>
    <label>Service</label>
    <select id="f-service"><option value="">— general —</option>${services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <label>Date &amp; time</label>
    <input id="f-when" type="datetime-local" value="${todayLocalISO()}" />
    <label>Duration (minutes)</label>
    <input id="f-duration" type="number" value="60" />
    <label>Note</label><input id="f-note" placeholder="Optional" />
    <div class="btn-row"><button class="btn block" id="f-save">Save</button></div>
  `);
  guardedClick('f-save', async () => {
    await api.createAppointment({
      client_id: clientId,
      service_id: document.getElementById('f-service').value || null,
      starts_at: document.getElementById('f-when').value,
      duration_minutes: Number(document.getElementById('f-duration').value) || 60,
      note: document.getElementById('f-note').value.trim() || null,
    });
    closeModal();
    renderClientDetail(clientId);
  });
}

// ---------- schedule ----------

async function renderSchedule() {
  viewEl.innerHTML = `<h1>Schedule</h1><div class="empty">Loading…</div>`;
  const { data, fromCache } = await api.listAppointments();
  paintSchedule(data, fromCache);
}

function paintSchedule(data, fromCache) {
  const upcomingAll = data.filter((a) => a.status === 'scheduled').sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  viewEl.innerHTML = `
    <h1>Schedule</h1>
    ${fromCache ? `<div class="sync-banner">Showing saved data — you're offline.</div>` : ''}
    <input class="search" id="sched-search" placeholder="Search by client or service…" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <div id="sched-body"></div>
    <button class="fab" id="add-appt-fab" title="Add appointment">+</button>
  `;

  const paintBody = (list) => {
    const groups = {};
    list.forEach((a) => {
      const day = (a.starts_at || '').slice(0, 10);
      (groups[day] = groups[day] || []).push(a);
    });
    const dayKeys = Object.keys(groups).sort();
    document.getElementById('sched-body').innerHTML = dayKeys.length ? dayKeys.map((day) => `
        <h2>${new Date(day + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</h2>
        <div class="card">
          ${groups[day].map((a) => `
            <div class="session-row" data-appt="${a.id}">
              <div>
                <div>${esc(a.client_name)} — ${esc(a.service_name || 'Session')}</div>
                <div class="sub">${fmtDate(a.starts_at)} · ${a.duration_minutes}min ${a.note ? '· ' + esc(a.note) : ''}</div>
              </div>
              <div style="display:flex;gap:6px">
                ${a.client_phone ? `<button class="btn secondary" style="padding:6px 10px;font-size:0.75rem" data-remind="${a.id}">Remind</button>` : ''}
                <button class="btn secondary" style="padding:6px 10px;font-size:0.75rem" data-done="${a.id}">Done</button>
                <button class="btn danger" style="padding:6px 8px;font-size:0.75rem" data-cancel="${a.id}">✕</button>
              </div>
            </div>`).join('')}
        </div>`).join('') : `<div class="empty">${upcomingAll.length ? 'No appointments match your search.' : 'No upcoming appointments.'}</div>`;

    viewEl.querySelectorAll('[data-remind]').forEach((btn) => btn.addEventListener('click', () => {
      const a = list.find((x) => String(x.id) === btn.dataset.remind);
      if (!a) return;
      const msg = `Hi ${a.client_name}, reminder from Fit Cube: your ${a.service_name || 'session'} is on ${fmtDate(a.starts_at)}. See you then!`;
      sendWhatsAppReminder({ name: a.client_name, phone: a.client_phone }, msg, [a.client_name, a.service_name || 'session', fmtDate(a.starts_at)]);
    }));
    viewEl.querySelectorAll('[data-done]').forEach((btn) => btn.addEventListener('click', async () => {
      await api.updateAppointment(btn.dataset.done, { status: 'completed' });
      renderSchedule();
    }));
    viewEl.querySelectorAll('[data-cancel]').forEach((btn) => btn.addEventListener('click', async () => {
      await api.updateAppointment(btn.dataset.cancel, { status: 'cancelled' });
      renderSchedule();
    }));
  };

  paintBody(upcomingAll);
  document.getElementById('sched-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    paintBody(upcomingAll.filter((a) =>
      (a.client_name || '').toLowerCase().includes(q) || (a.service_name || '').toLowerCase().includes(q)
    ));
  });

  document.getElementById('add-appt-fab').addEventListener('click', async () => {
    const { data: clients } = await api.listClients();
    const { data: services } = await api.listServices();
    openNewAppointmentModal(clients.filter((c) => !c.archived), services, () => renderSchedule());
  });
}

// Searchable client field + inline "add new client" / "add new service" —
// used from the Schedule tab so a booking never has to be interrupted by a
// trip to the Clients tab just because someone's new or a service is missing.
function openNewAppointmentModal(clientsIn, servicesIn, onSaved) {
  let clients = [...clientsIn];
  let services = [...servicesIn];
  let selectedClientId = null;
  let selectedClientName = '';

  openModal(`
    <h3>New appointment</h3>

    <label>Client</label>
    <div class="combo-wrap">
      <input id="f-client-search" class="search" style="margin-bottom:0" placeholder="Search clients by name…" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <div id="f-client-suggestions" class="combo-suggestions" hidden></div>
    </div>
    <div id="f-client-picked" class="sub" style="margin-top:6px"></div>
    <button type="button" class="btn secondary" id="f-client-new-toggle" style="margin-top:8px;padding:6px 10px;font-size:0.78rem">+ Add new client</button>
    <div id="f-client-new-fields" hidden style="margin-top:6px">
      ${contactPickerButtonHtml('f-newclient-pick-contact')}
      <form id="f-newclient-form" autocomplete="on" onsubmit="event.preventDefault()">
        <label>Name</label>
        <input id="f-newclient-name" name="name" placeholder="Full name" autocomplete="name" />
        <label>Phone</label>
        <input id="f-newclient-phone" name="tel" placeholder="70 123 456" type="tel" autocomplete="tel" />
      </form>
    </div>

    <label style="margin-top:16px">Service</label>
    <select id="f-service"><option value="">— general —</option>${services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <button type="button" class="btn secondary" id="f-service-new-toggle" style="margin-top:8px;padding:6px 10px;font-size:0.78rem">+ Add new service</button>
    <div id="f-service-new-fields" hidden style="margin-top:6px">
      <label>Service name</label><input id="f-newservice-name" placeholder="e.g. Deep tissue massage" />
      <label>Default price (optional)</label><input id="f-newservice-price" type="number" step="0.01" placeholder="e.g. 30" />
    </div>

    <label>Date &amp; time</label>
    <input id="f-when" type="datetime-local" value="${todayLocalISO()}" />
    <label>Duration (minutes)</label>
    <input id="f-duration" type="number" value="60" />
    <label>Note</label><input id="f-note" placeholder="Optional" />
    <div class="btn-row"><button class="btn block" id="f-save">Save</button></div>
  `);

  wireContactPicker('f-newclient-pick-contact', 'f-newclient-phone', 'f-newclient-name');

  const searchInput = document.getElementById('f-client-search');
  const suggestBox = document.getElementById('f-client-suggestions');
  const pickedLabel = document.getElementById('f-client-picked');

  function pickClient(c) {
    selectedClientId = c.id;
    selectedClientName = c.name;
    searchInput.value = c.name;
    pickedLabel.textContent = `Selected: ${c.name}${c.phone ? ' · ' + c.phone : ''}`;
    suggestBox.hidden = true;
  }

  function renderSuggestions(q) {
    const query = q.trim().toLowerCase();
    const matches = (query ? clients.filter((c) => c.name.toLowerCase().includes(query) || (c.phone || '').includes(query)) : clients).slice(0, 25);
    if (!matches.length) {
      suggestBox.innerHTML = `<div class="combo-empty">No matching clients — tap "+ Add new client" below.</div>`;
    } else {
      suggestBox.innerHTML = matches.map((c) => `<div class="combo-item" data-id="${c.id}">${esc(c.name)}${c.phone ? `<span class="sub" style="margin-left:6px">${esc(c.phone)}</span>` : ''}</div>`).join('');
      suggestBox.querySelectorAll('.combo-item').forEach((row) => {
        row.addEventListener('mousedown', (e) => { // mousedown fires before the input's blur
          e.preventDefault();
          const c = clients.find((x) => String(x.id) === row.dataset.id);
          if (c) pickClient(c);
        });
      });
    }
    suggestBox.hidden = false;
  }

  searchInput.addEventListener('input', () => {
    selectedClientId = null;
    pickedLabel.textContent = '';
    renderSuggestions(searchInput.value);
  });
  searchInput.addEventListener('focus', () => renderSuggestions(searchInput.value));
  searchInput.addEventListener('blur', () => setTimeout(() => { suggestBox.hidden = true; }, 150));

  const clientNewToggle = document.getElementById('f-client-new-toggle');
  const clientNewFields = document.getElementById('f-client-new-fields');
  clientNewToggle.addEventListener('click', () => {
    const showing = !clientNewFields.hidden;
    clientNewFields.hidden = showing;
    clientNewToggle.textContent = showing ? '+ Add new client' : '– Cancel new client';
    if (!showing) document.getElementById('f-newclient-name').focus();
  });

  const serviceNewToggle = document.getElementById('f-service-new-toggle');
  const serviceNewFields = document.getElementById('f-service-new-fields');
  serviceNewToggle.addEventListener('click', () => {
    const showing = !serviceNewFields.hidden;
    serviceNewFields.hidden = showing;
    serviceNewToggle.textContent = showing ? '+ Add new service' : '– Cancel new service';
    if (!showing) document.getElementById('f-newservice-name').focus();
  });

  guardedClick('f-save', async () => {
    let clientId = selectedClientId;
    if (!clientNewFields.hidden) {
      const name = document.getElementById('f-newclient-name').value.trim();
      if (!name) { alert('Enter a name for the new client.'); return; }
      const phone = document.getElementById('f-newclient-phone').value.trim();
      const result = await api.createClient({ name, phone: phone || null });
      clientId = result.id;
    }
    if (!clientId) { alert('Search for a client and pick one, or tap "+ Add new client".'); return; }

    let serviceId = document.getElementById('f-service').value || null;
    if (!serviceNewFields.hidden) {
      const sname = document.getElementById('f-newservice-name').value.trim();
      if (sname) {
        const price = document.getElementById('f-newservice-price').value;
        const result = await api.createService({ name: sname, default_price: price ? Number(price) : null });
        serviceId = result.id;
      }
    }

    await api.createAppointment({
      client_id: clientId,
      service_id: serviceId,
      starts_at: document.getElementById('f-when').value,
      duration_minutes: Number(document.getElementById('f-duration').value) || 60,
      note: document.getElementById('f-note').value.trim() || null,
    });
    closeModal();
    onSaved();
  });
}

// ---------- inventory ----------

let _productsCache = [];

async function renderInventory() {
  viewEl.innerHTML = `<h1>Stock</h1><div class="empty">Loading…</div>`;
  const { data, fromCache } = await api.listProducts();
  _productsCache = data;
  paintInventory(data, fromCache);
}

function paintInventory(data, fromCache) {
  viewEl.innerHTML = `
    <h1>Stock</h1>
    ${fromCache ? `<div class="sync-banner">Showing saved data — you're offline.</div>` : ''}
    <input class="search" id="prod-search" placeholder="Search products…" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <div id="prod-rows"></div>
    <button class="fab" id="add-prod-fab" title="Add product">+</button>
  `;
  const paintRows = (list) => {
    const el = document.getElementById('prod-rows');
    if (!list.length) { el.innerHTML = `<div class="empty">${data.length ? 'No products found.' : 'No products yet.'}</div>`; return; }
    el.innerHTML = list.map((p) => `
      <div class="list-row" data-id="${p.id}">
        <div><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.category || '')}${p.sku ? ' · ' + esc(p.sku) : ''}</div></div>
        <div>
          <span class="badge ${Number(p.qty_on_hand) <= Number(p.reorder_level) ? 'unpaid' : 'neutral'}">${p.qty_on_hand} in stock</span>
        </div>
      </div>`).join('');
    el.querySelectorAll('.list-row').forEach((row) => {
      row.addEventListener('click', () => {
        const p = data.find((x) => String(x.id) === row.dataset.id);
        openEditProductModal(p);
      });
    });
  };
  paintRows(data);
  document.getElementById('prod-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    paintRows(data.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q)
    ));
  });
  document.getElementById('add-prod-fab').addEventListener('click', openAddProductModal);
}

function openAddProductModal() {
  openModal(`
    <h3>New product</h3>
    <label>Name</label><input id="f-name" placeholder="e.g. Resistance band" />
    <label>Category</label><input id="f-category" placeholder="Optional" />
    <label>Sale price</label><input id="f-sale" type="number" step="0.01" value="0" />
    <label>Cost price</label><input id="f-cost" type="number" step="0.01" value="0" />
    <label>Quantity on hand</label><input id="f-qty" type="number" step="1" value="0" />
    <label>Reorder level (low-stock alert)</label><input id="f-reorder" type="number" step="1" value="0" />
    <div class="btn-row"><button class="btn block" id="f-save">Save</button></div>
  `);
  guardedClick('f-save', async () => {
    const name = document.getElementById('f-name').value.trim();
    if (!name) return;
    await api.createProduct({
      name,
      category: document.getElementById('f-category').value.trim() || null,
      sale_price: Number(document.getElementById('f-sale').value) || 0,
      cost_price: Number(document.getElementById('f-cost').value) || 0,
      qty_on_hand: Number(document.getElementById('f-qty').value) || 0,
      reorder_level: Number(document.getElementById('f-reorder').value) || 0,
    });
    closeModal();
    renderInventory();
  });
}

function openEditProductModal(p) {
  openModal(`
    <h3>Edit ${esc(p.name)}</h3>
    <label>Name</label><input id="f-name" value="${esc(p.name)}" />
    <label>Category</label><input id="f-category" value="${esc(p.category || '')}" />
    <label>Sale price</label><input id="f-sale" type="number" step="0.01" value="${p.sale_price}" />
    <label>Cost price</label><input id="f-cost" type="number" step="0.01" value="${p.cost_price}" />
    <label>Quantity on hand</label><input id="f-qty" type="number" step="1" value="${p.qty_on_hand}" />
    <label>Reorder level</label><input id="f-reorder" type="number" step="1" value="${p.reorder_level}" />
    <div class="btn-row"><button class="btn block" id="f-save">Save</button></div>
  `);
  guardedClick('f-save', async () => {
    await api.updateProduct(p.id, {
      name: document.getElementById('f-name').value.trim(),
      category: document.getElementById('f-category').value.trim() || null,
      sale_price: Number(document.getElementById('f-sale').value) || 0,
      cost_price: Number(document.getElementById('f-cost').value) || 0,
      qty_on_hand: Number(document.getElementById('f-qty').value) || 0,
      reorder_level: Number(document.getElementById('f-reorder').value) || 0,
    });
    closeModal();
    renderInventory();
  });
}

// ---------- sales ----------

function revenueSectionHtml(r, fromCache) {
  const max = Math.max(1, ...r.by_service.map((s) => Number(s.revenue)));
  const rows = r.by_service.filter((s) => Number(s.revenue) > 0 || Number(s.unpaid_sessions) > 0);
  return `
    ${fromCache ? `<div class="sync-banner">Showing saved data — you're offline.</div>` : ''}
    <div class="grid-2">
      <div class="card"><div class="stat" style="color:var(--accent)">${money(r.grand_total)}</div><div class="stat-label">Total revenue (sessions + products)</div></div>
      <div class="card"><div class="stat" style="color:var(--credit)">${money(r.product_sales_total)}</div><div class="stat-label">Product sales revenue</div></div>
    </div>
    <div class="card">
      ${rows.length ? rows.map((s) => `
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:4px">
            <span>${esc(s.service_name)}</span>
            <span style="font-weight:700">${money(s.revenue)}${Number(s.unpaid_amount) > 0 ? ` <span style="color:var(--unpaid);font-weight:400">(+${money(s.unpaid_amount)} owed)</span>` : ''}</span>
          </div>
          <div style="background:var(--surface-2);border-radius:6px;height:8px;overflow:hidden">
            <div style="background:var(--accent);height:100%;width:${Math.max(4, (Number(s.revenue) / max) * 100)}%"></div>
          </div>
        </div>
      `).join('') : '<div class="empty">Log paid sessions with a service selected to see revenue per service here.</div>'}
      ${r.top_products.length ? `
        <h2 style="margin-top:4px">Top-selling products</h2>
        ${r.top_products.map((p) => `
          <div class="session-row"><div>${esc(p.name)} <span class="sub">× ${p.qty_sold}</span></div><div>${money(p.revenue)}</div></div>
        `).join('')}
      ` : ''}
    </div>
  `;
}

async function renderSales() {
  viewEl.innerHTML = `<h1>Sales &amp; Purchases</h1><div class="empty">Loading…</div>`;
  // Revenue is owner-only, so staff accounts don't even request it.
  const [{ data: sales }, { data: purchases }, revenueResult] = await Promise.all([
    api.listSales(), api.listPurchases(), isOwner() ? api.revenueReport() : Promise.resolve({ data: null }),
  ]);
  const revenue = revenueResult.data;
  const revenueFromCache = revenueResult.fromCache;
  viewEl.innerHTML = `
    <h1>Sales &amp; Purchases</h1>

    ${isOwner() ? `
    <h2>Revenue by service (all time)</h2>
    ${revenue ? revenueSectionHtml(revenue, revenueFromCache) : '<div class="empty">No revenue data yet.</div>'}
    ` : ''}

    <div class="btn-row">
      <button class="btn block" id="new-sale-btn">Record sale</button>
      <button class="btn secondary block" id="new-purchase-btn">Record purchase</button>
    </div>
    <h2>Recent sales</h2>
    <div class="card">
      ${sales.length ? sales.slice(0, 20).map((s) => `
        <div class="session-row"><div><div>${esc(s.client_name || 'Walk-in')}</div><div class="sub">${fmtDate(s.sale_date)}</div></div><div>${money(s.total)}</div></div>
      `).join('') : '<div class="empty">No sales recorded yet.</div>'}
    </div>
    <h2>Recent purchases</h2>
    <div class="card">
      ${purchases.length ? purchases.slice(0, 20).map((p) => `
        <div class="session-row"><div><div>${esc(p.supplier || 'Supplier')}</div><div class="sub">${fmtDate(p.purchase_date)}</div></div><div>${money(p.total)}</div></div>
      `).join('') : '<div class="empty">No purchases recorded yet.</div>'}
    </div>
  `;
  document.getElementById('new-sale-btn').addEventListener('click', openSaleModal);
  document.getElementById('new-purchase-btn').addEventListener('click', openPurchaseModal);
}

async function openSaleModal() {
  const [{ data: products }, { data: clients }] = await Promise.all([api.listProducts(), api.listClients()]);
  if (!products.length) { alert('Add a product in Stock first.'); return; }
  openModal(`
    <h3>Record sale</h3>
    <label>Client (optional)</label>
    <select id="f-client"><option value="">Walk-in</option>${clients.filter((c) => !c.archived).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
    <label>Product</label>
    <select id="f-product">${products.map((p) => `<option value="${p.id}" data-price="${p.sale_price}">${esc(p.name)} (${p.qty_on_hand} in stock)</option>`).join('')}</select>
    <label>Quantity</label><input id="f-qty" type="number" step="1" value="1" />
    <label>Unit price</label><input id="f-price" type="number" step="0.01" value="${products[0].sale_price || 0}" />
    <label>Note</label><input id="f-note" placeholder="Optional" />
    <div class="btn-row"><button class="btn block" id="f-save">Save sale</button></div>
  `);
  document.getElementById('f-product').addEventListener('change', (e) => {
    document.getElementById('f-price').value = e.target.selectedOptions[0].dataset.price || 0;
  });
  guardedClick('f-save', async () => {
    await api.recordSale({
      client_id: document.getElementById('f-client').value || null,
      items: [{ product_id: document.getElementById('f-product').value, qty: Number(document.getElementById('f-qty').value), unit_price: Number(document.getElementById('f-price').value) }],
      note: document.getElementById('f-note').value.trim() || null,
    });
    closeModal();
    renderSales();
  });
}

async function openPurchaseModal() {
  const { data: products } = await api.listProducts();
  if (!products.length) { alert('Add a product in Stock first.'); return; }
  openModal(`
    <h3>Record purchase (restock)</h3>
    <label>Supplier</label><input id="f-supplier" placeholder="Optional" />
    <label>Product</label>
    <select id="f-product">${products.map((p) => `<option value="${p.id}" data-cost="${p.cost_price}">${esc(p.name)}</option>`).join('')}</select>
    <label>Quantity</label><input id="f-qty" type="number" step="1" value="1" />
    <label>Unit cost</label><input id="f-cost" type="number" step="0.01" value="${products[0].cost_price || 0}" />
    <label>Note</label><input id="f-note" placeholder="Optional" />
    <div class="btn-row"><button class="btn block" id="f-save">Save purchase</button></div>
  `);
  document.getElementById('f-product').addEventListener('change', (e) => {
    document.getElementById('f-cost').value = e.target.selectedOptions[0].dataset.cost || 0;
  });
  guardedClick('f-save', async () => {
    await api.recordPurchase({
      supplier: document.getElementById('f-supplier').value.trim() || null,
      items: [{ product_id: document.getElementById('f-product').value, qty: Number(document.getElementById('f-qty').value), unit_cost: Number(document.getElementById('f-cost').value) }],
      note: document.getElementById('f-note').value.trim() || null,
    });
    closeModal();
    renderSales();
  });
}

// ---------- sign in ----------

// Who's using the app right now. Kept in memory; the actual proof of identity
// is an HttpOnly cookie the page can't read, which is the point — a script
// that somehow got onto the page still can't lift the session out of it.
let currentUser = null;

const LOCAL_SIGNED_IN_KEY = 'fitcube:signedIn';

function isOwner() {
  return !currentUser || currentUser.role === 'owner';
}

function rememberSignedIn(user) {
  currentUser = user;
  try {
    if (user) localStorage.setItem(LOCAL_SIGNED_IN_KEY, JSON.stringify(user));
    else localStorage.removeItem(LOCAL_SIGNED_IN_KEY);
  } catch {}
}
function lastKnownUser() {
  try {
    const raw = localStorage.getItem(LOCAL_SIGNED_IN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function showAppChrome(show) {
  document.querySelector('.tabbar').style.display = show ? '' : 'none';
  document.querySelector('.topbar-right').style.display = show ? '' : 'none';
}

function authScreen(inner) {
  closeModal();
  showAppChrome(false);
  viewEl.innerHTML = `<div class="auth-screen">${inner}</div>`;
}

// First run: there are no accounts yet, so whoever is here creates the owner.
function renderSetupScreen() {
  authScreen(`
    <h1>Set up Fit Cube</h1>
    <div class="sub" style="margin-bottom:16px;line-height:1.5">This is the first time this app has been opened, so nothing is protecting your data yet. Create your owner account now — until you do, anyone who finds this address can open it.</div>
    <div class="card">
      <form id="setup-form" autocomplete="on" onsubmit="event.preventDefault()">
        <label>Your name</label>
        <input id="s-name" name="name" autocomplete="name" placeholder="Anthony Zakka" />
        <label>Username</label>
        <input id="s-username" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="anthony" />
        <label>Password</label>
        <input id="s-password" name="new-password" type="password" autocomplete="new-password" placeholder="At least 8 characters, with a number" />
        <label>Repeat password</label>
        <input id="s-password2" name="new-password" type="password" autocomplete="new-password" />
      </form>
      <div class="sub" id="s-error" style="color:var(--unpaid);margin-top:10px"></div>
      <div class="btn-row"><button class="btn block" id="s-save">Create my account</button></div>
    </div>
    <div class="sub" style="margin-top:14px;line-height:1.5">Use a password you don't use anywhere else. There's no "forgot password" email to fall back on — if you lose it, the account can't be recovered.</div>
  `);
  const err = document.getElementById('s-error');
  document.getElementById('s-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const password = document.getElementById('s-password').value;
    if (password !== document.getElementById('s-password2').value) {
      err.textContent = 'The two passwords are not the same.';
      return;
    }
    btn.disabled = true;
    err.textContent = '';
    try {
      const user = await api.authSetup({
        username: document.getElementById('s-username').value.trim(),
        display_name: document.getElementById('s-name').value.trim(),
        password,
      });
      rememberSignedIn(user);
      showAppChrome(true);
      location.hash = '#/dashboard';
      render();
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function renderLoginScreen(message) {
  const known = lastKnownUser();
  authScreen(`
    <h1>Fit Cube</h1>
    <div class="sub" style="margin-bottom:16px">${message ? esc(message) : 'Sign in to continue.'}</div>
    <div class="card">
      <form id="login-form" autocomplete="on" onsubmit="event.preventDefault()">
        <label>Username</label>
        <input id="l-username" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(known ? known.username : '')}" />
        <label>Password</label>
        <input id="l-password" name="password" type="password" autocomplete="current-password" />
      </form>
      <div class="sub" id="l-error" style="color:var(--unpaid);margin-top:10px"></div>
      <div class="btn-row"><button class="btn block" id="l-save">Sign in</button></div>
    </div>
  `);
  const err = document.getElementById('l-error');
  const submit = async () => {
    const btn = document.getElementById('l-save');
    btn.disabled = true;
    err.textContent = '';
    try {
      const user = await api.authLogin(
        document.getElementById('l-username').value.trim(),
        document.getElementById('l-password').value
      );
      rememberSignedIn(user);
      showAppChrome(true);
      render();
      if (window.fitcubeSync) window.fitcubeSync.flushOutbox();
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
    }
  };
  document.getElementById('l-save').addEventListener('click', submit);
  document.getElementById('l-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

async function signOut() {
  try {
    await api.authLogout();
  } catch {}
  rememberSignedIn(null);
  renderLoginScreen('Signed out.');
}

// A 401 from anywhere in the app means the session is gone — expired, signed
// out on another device, or the account was removed.
window.addEventListener('fitcube:unauthorized', () => {
  if (currentUser === null) return; // already on the login screen
  rememberSignedIn(null);
  renderLoginScreen('Your session ended. Please sign in again.');
});

// ---------- settings ----------

async function renderSettings() {
  const owner = isOwner();
  viewEl.innerHTML = `<h1>Settings</h1><div class="empty">Loading…</div>`;

  let users = null;
  let usersError = null;
  if (owner) {
    try {
      users = await api.listUsers();
    } catch (err) {
      usersError = err.message;
    }
  }

  viewEl.innerHTML = `
    <h1>Settings</h1>

    <h2>Your account</h2>
    <div class="card">
      <div style="margin-bottom:2px">${esc(currentUser ? currentUser.display_name : '')}</div>
      <div class="sub" style="margin-bottom:12px">${esc(currentUser ? currentUser.username : '')} · ${owner ? 'Owner' : 'Staff'}</div>
      <button class="btn secondary block" id="set-password" style="margin-bottom:8px">Change my password</button>
      <button class="btn danger block" id="set-signout">Sign out</button>
    </div>

    ${owner ? `
    <h2>Accounting</h2>
    <div class="card">
      <div class="sub" style="margin-bottom:12px">Revenue, profit, and the full financial breakdown — kept off the main Overview.</div>
      <button class="btn secondary block" id="set-accounting">Open accounting</button>
    </div>

    <h2>Staff &amp; access</h2>
    <div class="card">
      <div class="sub" style="margin-bottom:12px;line-height:1.45">Staff can run clients, sessions, schedule, stock and sales. They can't see revenue or profit, take backups, or manage accounts.</div>
      ${usersError ? `<div class="empty">${esc(usersError)}</div>` : (users || []).map((u) => `
        <div class="session-row">
          <div>
            <div>${esc(u.display_name)}${u.active ? '' : ' <span class="tag-chip">suspended</span>'}</div>
            <div class="sub">${esc(u.username)} · ${u.role === 'owner' ? 'Owner' : 'Staff'}${u.last_login_at ? ` · last in ${fmtDate(u.last_login_at)}` : ' · never signed in'}</div>
          </div>
          ${u.role === 'owner' ? '' : `<button class="btn secondary" data-manage="${u.id}" style="padding:6px 10px;font-size:0.78rem">Manage</button>`}
        </div>
      `).join('')}
      <button class="btn block" id="set-add-staff" style="margin-top:12px">Add a staff account</button>
    </div>

    <h2>Data &amp; backup</h2>
    ${backupIsStale() ? `<div class="card" style="border-color:var(--unpaid);margin-bottom:8px">⚠ ${esc(backupStatusLine())}</div>` : ''}
    <div class="card">
      <div class="sub" style="margin-bottom:10px">${backupIsStale() ? 'Save a copy now, to your phone and to Google Drive.' : esc(backupStatusLine())}</div>
      <div class="btn-row">
        <button class="btn block" id="save-backup-btn">Save backup</button>
        <button class="btn secondary block" id="restore-backup-btn">Restore from backup</button>
      </div>
      <div class="sub" style="margin-top:10px;line-height:1.45">"Save backup" opens your phone's share sheet — choose <b>Save to Files</b> to keep a copy on the phone itself, or <b>Google Drive</b> to put it in your Drive. Doing both takes about ten seconds.</div>
      <input type="file" id="restore-file-input" accept="application/json" style="display:none" />
    </div>

    <h2>Automatic backups</h2>
    <div class="card">
      <div class="sub" style="margin-bottom:12px;line-height:1.45">Besides the backups you save yourself, Fit Cube also keeps its own copy of everything automatically, roughly once a day, stored separately from the app itself — so your data isn't only as safe as the last time someone remembered to tap "Save backup".</div>
      <button class="btn secondary block" id="set-view-snapshots">View automatic backups</button>
    </div>

    <h2>Import clients</h2>
    <div class="card">
      <div class="sub" style="margin-bottom:12px;line-height:1.45">Bring in a CSV of contacts — fills in phone numbers for clients already here and adds anyone new.</div>
      <button class="btn secondary block" id="set-import-clients" style="margin-bottom:8px">Import from a file</button>
      <button class="btn secondary block" id="set-check-duplicates">Check for duplicate clients</button>
    </div>

    <h2>Activity</h2>
    <div class="card">
      <div class="sub" style="margin-bottom:12px">The last 200 changes made from any account, and who made each one.</div>
      <button class="btn secondary block" id="set-activity">See recent activity</button>
    </div>
    ` : ''}

    <h2>Message templates</h2>
    <div class="card">
      <div class="sub" style="margin-bottom:12px">The wording used for payment and session reminders.</div>
      <button class="btn secondary block" id="set-templates">Manage message templates</button>
    </div>
  `;

  document.getElementById('set-password').addEventListener('click', openChangePasswordModal);
  document.getElementById('set-signout').addEventListener('click', signOut);
  document.getElementById('set-templates').addEventListener('click', () => openTemplateManagerModal());
  if (!owner) return;

  document.getElementById('set-accounting').addEventListener('click', () => { location.hash = '#/accounting'; });
  document.getElementById('set-import-clients').addEventListener('click', openImportClientsModal);
  document.getElementById('set-check-duplicates').addEventListener('click', openDuplicateCheckModal);
  document.getElementById('set-activity').addEventListener('click', openActivityModal);
  document.getElementById('set-add-staff').addEventListener('click', openAddStaffModal);
  document.querySelectorAll('[data-manage]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const u = (users || []).find((x) => String(x.id) === btn.dataset.manage);
      if (u) openManageStaffModal(u);
    });
  });

  document.getElementById('set-view-snapshots').addEventListener('click', openSnapshotsModal);
  document.getElementById('save-backup-btn').addEventListener('click', (e) => prepareBackup(e.currentTarget));
  document.getElementById('restore-backup-btn').addEventListener('click', () => {
    document.getElementById('restore-file-input').click();
  });
  document.getElementById('restore-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('This replaces ALL current data on the server with the contents of this backup file. This cannot be undone. Continue?')) {
      e.target.value = '';
      return;
    }
    try {
      const text = await file.text();
      const dump = JSON.parse(text);
      const result = await api.restoreBackup(dump);
      for (const store of ['clients', 'services', 'products', 'appointments', 'meta']) {
        await idb.clear(store);
      }
      alert('Restore complete: ' + result.restored.map((r) => `${r.table} (${r.count})`).join(', '));
      location.reload();
    } catch (err) {
      alert('Restore failed: ' + err.message + '\n\nMake sure you selected a Fit Cube backup .json file, and that you have an internet connection (restore only works online).');
    }
  });
}

function openChangePasswordModal() {
  openModal(`
    <h3>Change my password</h3>
    <form autocomplete="on" onsubmit="event.preventDefault()">
      <label>Current password</label>
      <input id="p-current" type="password" autocomplete="current-password" />
      <label>New password</label>
      <input id="p-new" type="password" autocomplete="new-password" placeholder="At least 8 characters, with a number" />
      <label>Repeat new password</label>
      <input id="p-new2" type="password" autocomplete="new-password" />
    </form>
    <div class="sub" style="margin-top:10px;line-height:1.45">This signs you out everywhere else — use it if a phone with the app on it goes missing.</div>
    <div class="sub" id="p-error" style="color:var(--unpaid);margin-top:8px"></div>
    <div class="btn-row"><button class="btn block" id="p-save">Change password</button></div>
  `);
  const err = document.getElementById('p-error');
  document.getElementById('p-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const next = document.getElementById('p-new').value;
    if (next !== document.getElementById('p-new2').value) {
      err.textContent = 'The two new passwords are not the same.';
      return;
    }
    btn.disabled = true;
    err.textContent = '';
    try {
      await api.changePassword(document.getElementById('p-current').value, next);
      closeModal();
      alert('Password changed. Any other device signed in as you has been signed out.');
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
    }
  });
}

function openAddStaffModal() {
  openModal(`
    <h3>Add a staff account</h3>
    <form autocomplete="off" onsubmit="event.preventDefault()">
      <label>Their name</label><input id="u-name" />
      <label>Username</label><input id="u-username" autocapitalize="off" spellcheck="false" />
      <label>Password</label><input id="u-password" type="password" placeholder="At least 8 characters, with a number" />
    </form>
    <div class="sub" style="margin-top:10px;line-height:1.45">Give them this password in person and ask them to change it from their own account once they're in.</div>
    <div class="sub" id="u-error" style="color:var(--unpaid);margin-top:8px"></div>
    <div class="btn-row"><button class="btn block" id="u-save">Create account</button></div>
  `);
  const err = document.getElementById('u-error');
  document.getElementById('u-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    err.textContent = '';
    try {
      await api.createUser({
        display_name: document.getElementById('u-name').value.trim(),
        username: document.getElementById('u-username').value.trim(),
        password: document.getElementById('u-password').value,
      });
      closeModal();
      renderSettings();
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
    }
  });
}

// ---------- Contacts import ----------

// Reads a small CSV export of contacts (name, phone) — from a phone's
// address book export, a spreadsheet saved as CSV, or anywhere else — and
// turns it into a list of {name, phone} objects for the import endpoint to
// match against the existing client list. Column order is sniffed from the
// header row so "Name,Phone" and "First Name,Last Name,Phone Number" (and
// similar) both work without the user having to reformat anything; a file
// with no recognizable header just falls back to 2 or 3 plain columns.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // skip — \r\n line endings are handled by the \n branch above
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) pushRow();
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function parseContactsCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const headerCandidates = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_]+/g, ' '));
  const findCol = (names) => headerCandidates.findIndex((h) => names.includes(h));
  const nameCol = findCol(['name', 'full name', 'client', 'client name']);
  const firstCol = findCol(['first name', 'firstname', 'first']);
  const lastCol = findCol(['last name', 'lastname', 'last']);
  const phoneCol = findCol(['phone', 'phone number', 'mobile', 'mobile number', 'tel', 'telephone']);
  const hasHeader = nameCol >= 0 || firstCol >= 0 || lastCol >= 0 || phoneCol >= 0;

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const contacts = [];
  for (const r of dataRows) {
    let name, phone;
    if (hasHeader) {
      const first = firstCol >= 0 ? (r[firstCol] || '').trim() : '';
      const last = lastCol >= 0 ? (r[lastCol] || '').trim() : '';
      name = nameCol >= 0 ? (r[nameCol] || '').trim() : `${first} ${last}`.trim();
      phone = phoneCol >= 0 ? (r[phoneCol] || '').trim() : '';
    } else if (r.length >= 3) {
      name = `${(r[0] || '').trim()} ${(r[1] || '').trim()}`.trim();
      phone = (r[2] || '').trim();
    } else {
      name = (r[0] || '').trim();
      phone = (r[1] || '').trim();
    }
    name = name.replace(/\s+/g, ' ');
    if (!name) continue;
    contacts.push({ name, phone: phone || null });
  }
  return contacts;
}

function openImportClientsModal() {
  openModal(`
    <h3>Import clients</h3>
    <div class="sub" style="margin-bottom:12px;line-height:1.45">Upload a CSV of contacts (name and phone). Anyone already in the system gets their phone number filled in if it's missing — nothing already on file is overwritten. Anyone new is added as a client.</div>
    <input id="ic-file" type="file" accept=".csv,text/csv" />
    <div class="sub" id="ic-preview" style="margin-top:8px"></div>
    <div class="sub" id="ic-error" style="color:var(--unpaid);margin-top:8px"></div>
    <div class="btn-row" style="margin-top:10px"><button class="btn block" id="ic-import" disabled>Import</button></div>
  `);
  const preview = document.getElementById('ic-preview');
  const err = document.getElementById('ic-error');
  const importBtn = document.getElementById('ic-import');
  let contacts = null;
  document.getElementById('ic-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    contacts = null;
    importBtn.disabled = true;
    err.textContent = '';
    preview.textContent = '';
    if (!file) return;
    try {
      const text = await file.text();
      contacts = parseContactsCsv(text);
      if (!contacts.length) {
        err.textContent = 'No contacts found in that file.';
        return;
      }
      preview.textContent = `${contacts.length} contact(s) found — ready to import.`;
      importBtn.disabled = false;
    } catch (e2) {
      err.textContent = 'Could not read that file.';
    }
  });
  guardedClick('ic-import', async () => {
    if (!contacts || !contacts.length) return;
    err.textContent = '';
    const result = await api.importClients(contacts);
    const groups = (result.shared_phone_groups || [])
      .map((g) => `<div class="session-row"><div>${esc(g.names.join(' / '))}</div></div>`).join('');
    openModal(`
      <h3>Import complete</h3>
      <div class="card">
        <div class="session-row"><div>New clients added</div><div>${result.created}</div></div>
        <div class="session-row"><div>Phone numbers filled in</div><div>${result.filled_phone}</div></div>
        <div class="session-row"><div>Already complete, left alone</div><div>${result.unchanged}</div></div>
        ${result.skipped_invalid ? `<div class="session-row"><div>Skipped (no name)</div><div>${result.skipped_invalid}</div></div>` : ''}
      </div>
      ${groups ? `<h2>Same phone number, different names</h2><div class="sub" style="margin-bottom:8px;line-height:1.45">Worth a quick look — could be a household sharing one phone, or the same person entered twice.</div><div class="card">${groups}</div>` : ''}
      <div class="btn-row" style="margin-top:10px"><button class="btn block" id="ic-done">Done</button></div>
    `);
    document.getElementById('ic-done').addEventListener('click', () => { closeModal(); renderSettings(); });
  });
}

function openDuplicateCheckModal() {
  openModal(`<h3>Duplicate check</h3><div class="empty">Checking…</div>`);
  api.duplicateCheck().then((result) => {
    const clientLink = (id, label) =>
      `<button class="btn secondary" style="padding:6px 10px;font-size:0.78rem" onclick="closeModal();location.hash='#/clients/${id}'">${esc(label)}</button>`;

    const nameGroups = (result.same_name || []).map((g) => `
      <div class="session-row" style="align-items:flex-start">
        <div>
          <div>${esc(g.name)}</div>
          <div class="sub">${g.clients.length} client records with this exact name</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
          ${g.clients.map((c) => clientLink(c.id, c.phone || 'no phone')).join('')}
        </div>
      </div>`).join('');

    const phoneGroups = (result.same_phone_different_name || []).map((g) => `
      <div class="session-row" style="align-items:flex-start">
        <div>
          <div>${esc(g.phone)}</div>
          <div class="sub">Same phone number, different names</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
          ${g.clients.map((c) => clientLink(c.id, c.name)).join('')}
        </div>
      </div>`).join('');

    const nothingFound = !nameGroups && !phoneGroups;

    openModal(`
      <h3>Duplicate check</h3>
      <div class="sub" style="margin-bottom:12px">${result.total_clients} client${result.total_clients === 1 ? '' : 's'} total.</div>
      ${nothingFound ? `<div class="empty">No likely duplicates found.</div>` : ''}
      ${nameGroups ? `<h2>Same name, more than once</h2><div class="sub" style="margin-bottom:8px;line-height:1.45">Almost always the same person entered twice — open each one and delete or merge the extra.</div><div class="card">${nameGroups}</div>` : ''}
      ${phoneGroups ? `<h2>Same phone, different names</h2><div class="sub" style="margin-bottom:8px;line-height:1.45">Could be a real duplicate (typo or nickname), or a household sharing one phone — worth a quick look.</div><div class="card">${phoneGroups}</div>` : ''}
      <div class="btn-row" style="margin-top:10px"><button class="btn block" id="dc-close">Close</button></div>
    `);
    document.getElementById('dc-close').addEventListener('click', closeModal);
  }).catch((err) => {
    openModal(`<h3>Duplicate check</h3><div class="empty">${esc(err.message)}</div><div class="btn-row" style="margin-top:10px"><button class="btn block" id="dc-close">Close</button></div>`);
    document.getElementById('dc-close').addEventListener('click', closeModal);
  });
}

function openManageStaffModal(u) {
  openModal(`
    <h3>${esc(u.display_name)}</h3>
    <div class="sub" style="margin-bottom:12px">${esc(u.username)} · ${u.active ? 'active' : 'suspended'} · ${u.active_devices || 0} signed-in device(s)</div>
    <button class="btn secondary block" id="m-reset" style="margin-bottom:8px">Set a new password for them</button>
    <button class="btn secondary block" id="m-toggle" style="margin-bottom:8px">${u.active ? 'Suspend this account' : 'Re-enable this account'}</button>
    <button class="btn danger block" id="m-delete">Remove this account</button>
    <div class="sub" style="margin-top:10px;line-height:1.45">Suspending signs them out of every device immediately and blocks them from signing back in — the quickest thing to do if someone leaves.</div>
  `);
  document.getElementById('m-reset').addEventListener('click', () => {
    const pw = prompt('New password for ' + u.display_name + ' (at least 8 characters, with a number):');
    if (!pw) return;
    api.updateUser(u.id, { password: pw })
      .then(() => { alert('Password set. They have been signed out everywhere.'); closeModal(); renderSettings(); })
      .catch((e) => alert(e.message));
  });
  document.getElementById('m-toggle').addEventListener('click', () => {
    api.updateUser(u.id, { active: !u.active })
      .then(() => { closeModal(); renderSettings(); })
      .catch((e) => alert(e.message));
  });
  document.getElementById('m-delete').addEventListener('click', () => {
    if (!confirm(`Remove ${u.display_name}'s account? They'll be signed out and won't be able to get back in.`)) return;
    api.deleteUser(u.id).then(() => { closeModal(); renderSettings(); }).catch((e) => alert(e.message));
  });
}

async function openActivityModal() {
  openModal(`<h3>Recent activity</h3><div class="empty">Loading…</div>`);
  try {
    const rows = await api.listActivity();
    openModal(`
      <h3>Recent activity</h3>
      <div class="sub" style="margin-bottom:12px">The last 200 changes made from any account.</div>
      ${rows.length ? rows.map((r) => `
        <div class="session-row">
          <div>
            <div>${esc(r.summary || describeAction(r.action))}</div>
            <div class="sub">${esc(r.username || 'unknown')} · ${fmtDate(r.created_at)}</div>
          </div>
        </div>
      `).join('') : '<div class="empty">Nothing recorded yet.</div>'}
    `);
  } catch (err) {
    openModal(`<h3>Recent activity</h3><div class="empty">${esc(err.message)}</div>`);
  }
}

// Turns 'POST /api/clients/12/photos' into something readable.
function describeAction(action) {
  if (!action) return 'Change';
  const [method, url] = String(action).split(' ');
  const path = (url || '').replace(/^\/api\//, '');
  const verb = { POST: 'Added', PUT: 'Updated', DELETE: 'Deleted', PATCH: 'Updated' }[method] || method;
  if (/photos/.test(path)) return `${verb} a progress photo`;
  if (/metrics/.test(path)) return `${verb} progress measurements`;
  if (/sessions/.test(path)) return `${verb} a session`;
  if (/appointments/.test(path)) return `${verb} an appointment`;
  if (/^clients/.test(path)) return `${verb} a client`;
  if (/^products/.test(path)) return `${verb} a product`;
  if (/^sales/.test(path)) return `${verb} a sale`;
  if (/^purchases/.test(path)) return `${verb} a purchase`;
  if (/^services/.test(path)) return `${verb} a service`;
  if (/^templates/.test(path)) return `${verb} a message template`;
  return `${verb} ${path}`;
}

// ---------- boot ----------

async function boot() {
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  updateThemeToggleIcon();
  document.getElementById('settings-btn').addEventListener('click', () => { location.hash = '#/settings'; });

  const status = await api.authStatus();

  if (status === null) {
    // Couldn't reach the server. If this device was signed in before, let it
    // straight through to its cached data rather than blocking on a login it
    // can't complete offline; the server still refuses any real request.
    const known = lastKnownUser();
    if (known) {
      currentUser = known;
      showAppChrome(true);
      return render();
    }
    return renderLoginScreen('Can\'t reach the server right now. Check your connection and try again.');
  }
  if (!status.configured) return renderSetupScreen();
  if (!status.authenticated) {
    rememberSignedIn(null);
    return renderLoginScreen();
  }
  rememberSignedIn(status.user);
  showAppChrome(true);
  render();
}

boot();
