// Thin API layer: talks to the server when online, and transparently falls
// back to the IndexedDB mirror when offline. Writes made offline are queued
// in the outbox (see db.js / sync.js) and replayed once the connection is
// back — the UI updates optimistically in the meantime.

// Every write carries a unique id. If a request is retried — or replayed from
// the outbox after the connection dropped between the server committing and
// the reply arriving — the server recognises the id and returns the original
// result instead of doing the work twice. Without this, one flaky upload
// becomes two identical progress photos.
function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// Thrown when the request never reached the server (no signal, server asleep).
// Distinguishing this from "the server answered, and said no" is the whole
// point: only the former should ever be queued for a retry.
class NetworkDownError extends Error {
  constructor(cause) {
    super('No connection to the server.');
    this.name = 'NetworkDownError';
    this.cause = cause;
  }
}

async function rawFetch(method, url, body, requestId) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (requestId) headers['X-Request-Id'] = requestId;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (err) {
    // fetch only rejects when the request didn't complete at all.
    throw new NetworkDownError(err);
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody.error || `HTTP ${res.status}`);
    err.status = res.status;
    // A 401 from an ordinary request means the session ended — expired,
    // signed out on another device, or the account was removed — and the app
    // should fall back to the lock screen. A 401 from the sign-in call itself
    // just means the password was wrong, and must be reported as such.
    if (res.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('fitcube:unauthorized'));
    }
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function get(url) {
  return rawFetch('GET', url);
}

async function mutate(method, url, body) {
  const requestId = newRequestId();
  try {
    return { data: await rawFetch(method, url, body, requestId), offline: false };
  } catch (err) {
    if (err instanceof NetworkDownError) {
      // Genuinely couldn't reach the server — keep the write and replay it
      // later, carrying the same request id so the replay can't duplicate it.
      await idb.queueMutation(method, url, body, requestId);
      return { data: null, offline: true };
    }
    // The server answered and rejected this (validation error, not allowed,
    // signed out). Queueing that would replay a doomed request forever, so
    // it's surfaced to the caller instead.
    throw err;
  }
}

// A client's page is one bundle (client + sessions + appointments + photos +
// metrics) cached under one key, refreshed only by a successful GET. Writes
// that touch a client's sub-resources (logging a session, adding a photo or
// metric, scheduling an appointment from their page, and their edits/deletes)
// used to skip past that cache entirely — so made offline, they'd queue for
// later sync but the client's own page kept showing the old bundle until the
// next successful fetch, i.e. until back online. This patches the cached
// bundle in place so the change is visible immediately either way. No-op if
// that client's page has never been cached (nothing to patch).
async function patchClientDetailCache(clientId, mutator) {
  if (!clientId) return;
  const key = `client_detail_${clientId}`;
  const cached = await idb.get('meta', key);
  if (!cached || !cached.value) return;
  const bundle = { ...cached.value };
  mutator(bundle);
  await idb.put('meta', { key, value: bundle });
}

const api = {
  async listClients() {
    try {
      const data = await get('/api/clients');
      await idb.putAll('clients', data);
      return { data, fromCache: false };
    } catch {
      return { data: await idb.getAll('clients'), fromCache: true };
    }
  },

  async getClient(id) {
    try {
      const data = await get(`/api/clients/${id}`);
      await idb.put('meta', { key: `client_detail_${id}`, value: data });
      return { data, fromCache: false };
    } catch {
      const cached = await idb.get('meta', `client_detail_${id}`);
      return { data: cached ? cached.value : null, fromCache: true };
    }
  },

  async createClient(payload) {
    const result = await mutate('POST', '/api/clients', payload);
    const id = result.offline ? `tmp_${Date.now()}` : result.data.id;
    await idb.put('clients', { id, archived: 0, balance: null, _pending: result.offline, ...payload });
    // So opening this client's own page works right away even if made and
    // viewed offline in the same visit, before any sync has fetched it.
    await idb.put('meta', {
      key: `client_detail_${id}`,
      value: { id, archived: 0, sessions: [], appointments: [], photos: [], metrics: [], _pending: result.offline, ...payload },
    });
    return { id, offline: result.offline };
  },

  async updateClient(id, payload) {
    const result = await mutate('PUT', `/api/clients/${id}`, payload);
    const existing = (await idb.get('clients', id)) || { id };
    await idb.put('clients', { ...existing, ...payload, _pending: result.offline || existing._pending });
    // The clients LIST reads from the store just updated above, but a
    // client's own page reads from a separate cached bundle — without this
    // it kept showing the old name/phone/notes until back online.
    await patchClientDetailCache(id, (bundle) => {
      Object.assign(bundle, payload);
      bundle._pending = result.offline || bundle._pending;
    });
    return result;
  },

  async logSession(clientId, payload) {
    const result = await mutate('POST', `/api/clients/${clientId}/sessions`, payload);
    const id = result.offline ? `tmp_${Date.now()}` : result.data.id;
    let service_name = null;
    if (payload.service_id) {
      const svc = await idb.get('services', Number(payload.service_id));
      service_name = svc ? svc.name : null;
    }
    await patchClientDetailCache(clientId, (bundle) => {
      bundle.sessions = [
        { id, client_id: Number(clientId), created_at: new Date().toISOString(), service_name, _pending: result.offline, ...payload },
        ...(bundle.sessions || []),
      ];
    });
    return result;
  },

  async updateSession(sessionId, payload, clientId) {
    const result = await mutate('PUT', `/api/sessions/${sessionId}`, payload);
    await patchClientDetailCache(clientId, (bundle) => {
      bundle.sessions = (bundle.sessions || []).map((s) =>
        String(s.id) === String(sessionId) ? { ...s, ...payload, _pending: result.offline || s._pending } : s
      );
    });
    return result;
  },

  async deleteSession(sessionId, clientId) {
    const result = await mutate('DELETE', `/api/sessions/${sessionId}`, undefined);
    await patchClientDetailCache(clientId, (bundle) => {
      bundle.sessions = (bundle.sessions || []).filter((s) => String(s.id) !== String(sessionId));
    });
    return result;
  },

  async listServices() {
    try {
      const data = await get('/api/services');
      await idb.putAll('services', data);
      return { data, fromCache: false };
    } catch {
      return { data: await idb.getAll('services'), fromCache: true };
    }
  },

  async addClientPhoto(clientId, payload) {
    const result = await mutate('POST', `/api/clients/${clientId}/photos`, payload);
    const id = result.offline ? `tmp_${Date.now()}` : result.data.id;
    await patchClientDetailCache(clientId, (bundle) => {
      bundle.photos = [
        { id, client_id: Number(clientId), taken_at: new Date().toISOString(), created_at: new Date().toISOString(), _pending: result.offline, ...payload },
        ...(bundle.photos || []),
      ];
    });
    return result;
  },

  async deletePhoto(photoId, clientId) {
    const result = await mutate('DELETE', `/api/photos/${photoId}`, undefined);
    await patchClientDetailCache(clientId, (bundle) => {
      bundle.photos = (bundle.photos || []).filter((p) => String(p.id) !== String(photoId));
    });
    return result;
  },

  async addClientMetric(clientId, payload) {
    const result = await mutate('POST', `/api/clients/${clientId}/metrics`, payload);
    const id = result.offline ? `tmp_${Date.now()}` : result.data.id;
    await patchClientDetailCache(clientId, (bundle) => {
      bundle.metrics = [...(bundle.metrics || []), { id, client_id: Number(clientId), _pending: result.offline, ...payload }];
    });
    return result;
  },

  async deleteMetric(metricId, clientId) {
    const result = await mutate('DELETE', `/api/metrics/${metricId}`, undefined);
    await patchClientDetailCache(clientId, (bundle) => {
      bundle.metrics = (bundle.metrics || []).filter((m) => String(m.id) !== String(metricId));
    });
    return result;
  },

  async listTemplates() {
    try {
      const data = await get('/api/templates');
      await idb.putAll('templates', data);
      return { data, fromCache: false };
    } catch {
      return { data: await idb.getAll('templates'), fromCache: true };
    }
  },

  async createTemplate(payload) {
    const result = await mutate('POST', '/api/templates', payload);
    const id = result.offline ? `tmp_${Date.now()}` : result.data.id;
    await idb.put('templates', { id, _pending: result.offline, ...payload });
    return { id, offline: result.offline };
  },

  async updateTemplate(id, payload) {
    const result = await mutate('PUT', `/api/templates/${id}`, payload);
    const existing = (await idb.get('templates', id)) || { id };
    await idb.put('templates', { ...existing, ...payload, _pending: result.offline || existing._pending });
    return result;
  },

  async deleteTemplate(id) {
    await idb.delete('templates', id);
    return mutate('DELETE', `/api/templates/${id}`, undefined);
  },

  async createService(payload) {
    const result = await mutate('POST', '/api/services', payload);
    const id = result.offline ? `tmp_${Date.now()}` : result.data.id;
    const record = { id, active: 1, _pending: result.offline, ...payload };
    await idb.put('services', record);
    return { id, offline: result.offline, ...record };
  },

  async listAppointments(params = '') {
    try {
      const data = await get(`/api/appointments${params}`);
      await idb.putAll('appointments', data);
      return { data, fromCache: false };
    } catch {
      return { data: await idb.getAll('appointments'), fromCache: true };
    }
  },

  async createAppointment(payload) {
    const result = await mutate('POST', '/api/appointments', payload);
    const id = result.offline ? `tmp_${Date.now()}` : result.data.id;
    let service_name = null;
    if (payload.service_id) {
      const svc = await idb.get('services', Number(payload.service_id));
      service_name = svc ? svc.name : null;
    }
    await idb.put('appointments', { id, status: 'scheduled', service_name, _pending: result.offline, ...payload });
    // Booked from a client's own page (has client_id) — also show up there
    // right away, not just once the Schedule tab next syncs.
    if (payload.client_id) {
      await patchClientDetailCache(payload.client_id, (bundle) => {
        bundle.appointments = [
          { id, status: 'scheduled', service_name, _pending: result.offline, ...payload },
          ...(bundle.appointments || []),
        ];
      });
    }
    return { id, offline: result.offline };
  },

  async updateAppointment(id, payload) {
    const result = await mutate('PUT', `/api/appointments/${id}`, payload);
    const existing = (await idb.get('appointments', id)) || { id };
    await idb.put('appointments', { ...existing, ...payload, _pending: result.offline || existing._pending });
    return result;
  },

  async deleteAppointment(id) {
    await idb.delete('appointments', id);
    return mutate('DELETE', `/api/appointments/${id}`, undefined);
  },

  async listProducts() {
    try {
      const data = await get('/api/products');
      await idb.putAll('products', data);
      return { data, fromCache: false };
    } catch {
      return { data: await idb.getAll('products'), fromCache: true };
    }
  },

  async createProduct(payload) {
    const result = await mutate('POST', '/api/products', payload);
    const id = result.offline ? `tmp_${Date.now()}` : result.data.id;
    await idb.put('products', { id, qty_on_hand: 0, reorder_level: 0, _pending: result.offline, ...payload });
    return { id, offline: result.offline };
  },

  async updateProduct(id, payload) {
    const result = await mutate('PUT', `/api/products/${id}`, payload);
    const existing = (await idb.get('products', id)) || { id };
    await idb.put('products', { ...existing, ...payload, _pending: result.offline || existing._pending });
    return result;
  },

  async recordSale(payload) {
    return mutate('POST', '/api/sales', payload);
  },

  async recordPurchase(payload) {
    return mutate('POST', '/api/purchases', payload);
  },

  async listSales() {
    try { return { data: await get('/api/sales'), fromCache: false }; }
    catch { return { data: [], fromCache: true }; }
  },

  async listPurchases() {
    try { return { data: await get('/api/purchases'), fromCache: false }; }
    catch { return { data: [], fromCache: true }; }
  },

  async revenueReport() {
    try {
      const data = await get('/api/reports/revenue');
      await idb.put('meta', { key: 'revenue_report', value: data });
      return { data, fromCache: false };
    } catch {
      const cached = await idb.get('meta', 'revenue_report');
      return { data: cached ? cached.value : null, fromCache: true };
    }
  },

  async whatsappLink(phone, message) {
    return rawFetch('POST', '/api/whatsapp/link', { phone, message });
  },

  async whatsappSend(phone, clientName, bodyParams) {
    try {
      return await rawFetch('POST', '/api/whatsapp/send', { phone, clientName, bodyParams });
    } catch {
      return { configured: false };
    }
  },

  async restoreBackup(dump) {
    // Deliberately NOT queued to the offline outbox — a restore only makes
    // sense against the live server, and must not silently no-op offline.
    return rawFetch('POST', '/api/backup/import', dump);
  },

  async importClients(contacts) {
    // Same reasoning as restoreBackup — a one-time bulk write that only
    // makes sense against the live server, not something to replay later
    // from an offline queue.
    return rawFetch('POST', '/api/clients/import', { contacts });
  },

  async duplicateCheck() {
    return get('/api/clients/duplicate-check');
  },

  async dashboardSummary() {
    try {
      const data = await get('/api/dashboard/summary');
      await idb.put('meta', { key: 'dashboard_summary', value: data });
      return { data, fromCache: false };
    } catch {
      const cached = await idb.get('meta', 'dashboard_summary');
      return { data: cached ? cached.value : null, fromCache: true };
    }
  },

  // ---------- accounts ----------

  // Returns null when the server can't be reached, which the app treats as
  // "offline" rather than "signed out" — otherwise losing signal in the gym
  // would throw up a login screen over perfectly good cached data.
  async authStatus() {
    try {
      return await get('/api/auth/status');
    } catch (err) {
      if (err instanceof NetworkDownError) return null;
      throw err;
    }
  },
  async authSetup(payload) {
    return rawFetch('POST', '/api/auth/setup', payload);
  },
  async authLogin(username, password) {
    return rawFetch('POST', '/api/auth/login', { username, password });
  },
  async authLogout() {
    return rawFetch('POST', '/api/auth/logout', {});
  },
  async changePassword(currentPassword, newPassword) {
    return rawFetch('POST', '/api/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
  },
  async listUsers() {
    return get('/api/users');
  },
  async createUser(payload) {
    return rawFetch('POST', '/api/users', payload);
  },
  async updateUser(id, payload) {
    return rawFetch('PUT', `/api/users/${id}`, payload);
  },
  async deleteUser(id) {
    return rawFetch('DELETE', `/api/users/${id}`, undefined);
  },
  async listActivity() {
    return get('/api/activity');
  },
};

window.api = api;
