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

function closeModal() { modalRoot.innerHTML = ''; }
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
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
}

// ---------- router ----------

function currentRoute() {
  const hash = location.hash.replace(/^#\//, '') || 'dashboard';
  const [route, param] = hash.split('/');
  return { route, param };
}

async function render() {
  const { route, param } = currentRoute();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.route === route));
  refreshStatusPill();

  if (route === 'dashboard') return renderDashboard();
  if (route === 'clients' && !param) return renderClientsList();
  if (route === 'clients' && param) return renderClientDetail(param);
  if (route === 'schedule') return renderSchedule();
  if (route === 'inventory') return renderInventory();
  if (route === 'sales') return renderSales();
  return renderDashboard();
}
window.addEventListener('hashchange', render);
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => { location.hash = '#/' + btn.dataset.route; });
});

// ---------- dashboard ----------

async function renderDashboard() {
  viewEl.innerHTML = `<h1>Overview</h1><div class="empty">Loading…</div>`;
  const { data, fromCache } = await api.dashboardSummary();
  if (!data) { viewEl.innerHTML = `<h1>Overview</h1><div class="empty">No data yet — connect once online to load your dashboard.</div>`; return; }
  viewEl.innerHTML = `
    <h1>Overview</h1>
    ${fromCache ? `<div class="sync-banner">Showing last saved data — you're offline.</div>` : ''}
    <div class="grid-2">
      <div class="card"><div class="stat" style="color:var(--accent)">${money(data.revenue_total)}</div><div class="stat-label">Total revenue collected</div></div>
      <div class="card"><div class="stat" style="color:var(--unpaid)">${money(data.unpaid_total)}</div><div class="stat-label">Unpaid balance (${data.unpaid_entries} entries)</div></div>
      <div class="card"><div class="stat" style="color:var(--credit)">${data.prepaid_credit_sessions}</div><div class="stat-label">Prepaid session credits</div></div>
      <div class="card"><div class="stat">${data.appointments_today}</div><div class="stat-label">Appointments today</div></div>
      <div class="card"><div class="stat">${data.active_clients}</div><div class="stat-label">Active clients</div></div>
    </div>
    ${data.low_stock_products > 0 ? `<div class="card" style="border-color:var(--unpaid)">⚠ ${data.low_stock_products} product(s) at or below reorder level — check Stock.</div>` : ''}
    <h2>Quick actions</h2>
    <div class="btn-row">
      <button class="btn block" onclick="location.hash='#/clients'">View clients</button>
      <button class="btn secondary block" onclick="location.hash='#/schedule'">Schedule</button>
    </div>

    <h2>Data &amp; backup</h2>
    <div class="card">
      <div class="sub" style="margin-bottom:10px">Your data is worth protecting on its own — don't rely only on the server. Download a copy after sessions, and save it to Drive, email, or AirDrop.</div>
      <div class="btn-row">
        <a class="btn block" href="/api/backup/export" style="text-decoration:none">Download backup</a>
        <button class="btn secondary block" id="restore-backup-btn">Restore from backup</button>
      </div>
      <input type="file" id="restore-file-input" accept="application/json" style="display:none" />
    </div>
  `;
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
  document.getElementById('add-client-fab').addEventListener('click', openAddClientModal);
}

const CONTACT_PICKER_SUPPORTED = 'contacts' in navigator && 'ContactsManager' in window;

function openAddClientModal() {
  openModal(`
    <h3>New client</h3>
    ${CONTACT_PICKER_SUPPORTED ? `<button class="btn secondary block" id="pick-contact-btn" style="margin-bottom:6px">Choose from Contacts</button>` : ''}
    <label>Name</label><input id="f-name" placeholder="Full name" autocomplete="name" />
    <label>Phone</label><input id="f-phone" placeholder="70 123 456" autocomplete="tel" type="tel" />
    <label>Notes</label><textarea id="f-notes" placeholder="Optional"></textarea>
    ${!CONTACT_PICKER_SUPPORTED ? `<div class="sub" style="margin-top:8px">Tip: tap into Name or Phone — your phone may suggest matching contacts as you type.</div>` : ''}
    <div class="btn-row"><button class="btn block" id="f-save">Save client</button></div>
  `);
  const pickBtn = document.getElementById('pick-contact-btn');
  if (pickBtn) {
    pickBtn.addEventListener('click', async () => {
      try {
        const [contact] = await navigator.contacts.select(['name', 'tel'], { multiple: false });
        if (contact) {
          if (contact.name && contact.name[0]) document.getElementById('f-name').value = contact.name[0];
          if (contact.tel && contact.tel[0]) document.getElementById('f-phone').value = contact.tel[0];
        }
      } catch (err) {
        // user cancelled the picker, or permission denied — nothing to do
      }
    });
  }
  document.getElementById('f-save').addEventListener('click', async () => {
    const name = document.getElementById('f-name').value.trim();
    if (!name) return;
    const phone = document.getElementById('f-phone').value.trim();
    const notes = document.getElementById('f-notes').value.trim();
    await api.createClient({ name, phone: phone || null, notes: notes || null });
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
        ${c.phone ? `<button class="btn secondary" id="whatsapp-btn">WhatsApp</button>` : ''}
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

    <h2>Session history</h2>
    <div class="card">
      ${sessions.length ? sessions.map((s) => sessionRowHtml(s)).join('') : '<div class="empty">No sessions logged yet.</div>'}
    </div>

    <h2>Appointments</h2>
    <div class="card">
      ${appts.length ? appts.map((a) => `
        <div class="session-row">
          <div><div>${esc(a.service_name || 'Session')}</div><div class="sub">${fmtDate(a.starts_at)} · ${a.status}</div></div>
          ${a.status === 'scheduled' && c.phone ? `<button class="btn secondary" style="padding:6px 10px;font-size:0.75rem" data-remind="${a.id}" data-service="${esc(a.service_name || 'session')}" data-when="${a.starts_at}">Remind</button>` : ''}
        </div>`).join('') : '<div class="empty">No appointments scheduled.</div>'}
    </div>
  `;

  document.getElementById('edit-client-btn').addEventListener('click', () => openEditClientModal(c));
  document.getElementById('log-session-btn').addEventListener('click', () => openLogSessionModal(c.id));
  document.getElementById('add-appt-btn').addEventListener('click', () => openAddAppointmentModal(c.id));
  const waBtn = document.getElementById('whatsapp-btn');
  if (waBtn) waBtn.addEventListener('click', () => sendWhatsAppReminder(c, `Hi ${c.name}, this is Fit Cube.`));
  viewEl.querySelectorAll('[data-remind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = `Hi ${c.name}, reminder from Fit Cube: your ${btn.dataset.service} session is on ${fmtDate(btn.dataset.when)}. See you then!`;
      sendWhatsAppReminder(c, msg, [c.name, btn.dataset.service, fmtDate(btn.dataset.when)]);
    });
  });

  viewEl.querySelectorAll('[data-mark-paid]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.updateSession(btn.dataset.markPaid, { payment_state: 'paid_now' });
      renderClientDetail(id);
    });
  });
  viewEl.querySelectorAll('[data-remove-session]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Remove this session entry?')) return;
      await api.deleteSession(btn.dataset.removeSession);
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
    <label>Name</label><input id="f-name" value="${esc(c.name)}" />
    <label>Phone</label><input id="f-phone" value="${esc(c.phone || '')}" />
    <label>Notes</label><textarea id="f-notes">${esc(c.notes || '')}</textarea>
    <div class="btn-row">
      <button class="btn block" id="f-save">Save</button>
      <button class="btn danger" id="f-archive">Archive client</button>
    </div>
  `);
  document.getElementById('f-save').addEventListener('click', async () => {
    await api.updateClient(c.id, {
      name: document.getElementById('f-name').value.trim(),
      phone: document.getElementById('f-phone').value.trim() || null,
      notes: document.getElementById('f-notes').value.trim() || null,
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
  document.getElementById('f-save').addEventListener('click', async () => {
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
  document.getElementById('f-save').addEventListener('click', async () => {
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
  const upcoming = data.filter((a) => a.status === 'scheduled').sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const groups = {};
  upcoming.forEach((a) => {
    const day = (a.starts_at || '').slice(0, 10);
    (groups[day] = groups[day] || []).push(a);
  });
  const dayKeys = Object.keys(groups).sort();

  viewEl.innerHTML = `
    <h1>Schedule</h1>
    ${fromCache ? `<div class="sync-banner">Showing saved data — you're offline.</div>` : ''}
    <div id="sched-body">
      ${dayKeys.length ? dayKeys.map((day) => `
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
        </div>`).join('') : '<div class="empty">No upcoming appointments.</div>'}
    </div>
    <button class="fab" id="add-appt-fab" title="Add appointment">+</button>
  `;

  document.getElementById('add-appt-fab').addEventListener('click', async () => {
    const { data: clients } = await api.listClients();
    const { data: services } = await api.listServices();
    openModal(`
      <h3>New appointment</h3>
      <label>Client</label>
      <select id="f-client">${clients.filter((c) => !c.archived).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <label>Service</label>
      <select id="f-service"><option value="">— general —</option>${services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <label>Date &amp; time</label>
      <input id="f-when" type="datetime-local" value="${todayLocalISO()}" />
      <label>Duration (minutes)</label>
      <input id="f-duration" type="number" value="60" />
      <label>Note</label><input id="f-note" placeholder="Optional" />
      <div class="btn-row"><button class="btn block" id="f-save">Save</button></div>
    `);
    document.getElementById('f-save').addEventListener('click', async () => {
      await api.createAppointment({
        client_id: document.getElementById('f-client').value,
        service_id: document.getElementById('f-service').value || null,
        starts_at: document.getElementById('f-when').value,
        duration_minutes: Number(document.getElementById('f-duration').value) || 60,
        note: document.getElementById('f-note').value.trim() || null,
      });
      closeModal();
      renderSchedule();
    });
  });

  viewEl.querySelectorAll('[data-remind]').forEach((btn) => btn.addEventListener('click', () => {
    const a = upcoming.find((x) => String(x.id) === btn.dataset.remind);
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
}

// ---------- inventory ----------

async function renderInventory() {
  viewEl.innerHTML = `<h1>Stock</h1><div class="empty">Loading…</div>`;
  const { data, fromCache } = await api.listProducts();
  viewEl.innerHTML = `
    <h1>Stock</h1>
    ${fromCache ? `<div class="sync-banner">Showing saved data — you're offline.</div>` : ''}
    <div id="prod-rows">
      ${data.length ? data.map((p) => `
        <div class="list-row" data-id="${p.id}">
          <div><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.category || '')}${p.sku ? ' · ' + esc(p.sku) : ''}</div></div>
          <div>
            <span class="badge ${Number(p.qty_on_hand) <= Number(p.reorder_level) ? 'unpaid' : 'neutral'}">${p.qty_on_hand} in stock</span>
          </div>
        </div>`).join('') : '<div class="empty">No products yet.</div>'}
    </div>
    <button class="fab" id="add-prod-fab" title="Add product">+</button>
  `;
  document.getElementById('add-prod-fab').addEventListener('click', openAddProductModal);
  document.querySelectorAll('#prod-rows .list-row').forEach((row) => {
    row.addEventListener('click', () => {
      const p = data.find((x) => String(x.id) === row.dataset.id);
      openEditProductModal(p);
    });
  });
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
  document.getElementById('f-save').addEventListener('click', async () => {
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
  document.getElementById('f-save').addEventListener('click', async () => {
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
  const [{ data: sales }, { data: purchases }, { data: revenue, fromCache: revenueFromCache }] = await Promise.all([
    api.listSales(), api.listPurchases(), api.revenueReport(),
  ]);
  viewEl.innerHTML = `
    <h1>Sales &amp; Purchases</h1>

    <h2>Revenue by service (all time)</h2>
    ${revenue ? revenueSectionHtml(revenue, revenueFromCache) : '<div class="empty">No revenue data yet.</div>'}

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
  document.getElementById('f-save').addEventListener('click', async () => {
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
  document.getElementById('f-save').addEventListener('click', async () => {
    await api.recordPurchase({
      supplier: document.getElementById('f-supplier').value.trim() || null,
      items: [{ product_id: document.getElementById('f-product').value, qty: Number(document.getElementById('f-qty').value), unit_cost: Number(document.getElementById('f-cost').value) }],
      note: document.getElementById('f-note').value.trim() || null,
    });
    closeModal();
    renderSales();
  });
}

// ---------- boot ----------
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
updateThemeToggleIcon();
render();
