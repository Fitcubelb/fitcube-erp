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
    return { id, offline: result.offline };
  },

  async updateClient(id, payload) {
    const result = await mutate('PUT', `/api/clients/${id}`, payload);
    const existing = (await idb.get('clients', id)) || { id };
    await idb.put('clients', { ...existing, ...payload, _pending: result.offline || existing._pending });
    return result;
  },

  async logSession(clientId, payload) {
    return mutate('POST', `/api/clients/${clientId}/sessions`, payload);
  },

  async updateSession(sessionId, payload) {
    return mutate('PUT', `/api/sessions/${sessionId}`, payload);
  },

  async deleteSession(sessionId) {
    return mutate('DELETE', `/api/sessions/${sessionId}`, undefined);
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
    return mutate('POST', `/api/clients/${clientId}/photos`, payload);
  },

  async deletePhoto(photoId) {
    return mutate('DELETE', `/api/photos/${photoId}`, undefined);
  },

  async addClientMetric(clientId, payload) {
    return mutate('POST', `/api/clients/${clientId}/metrics`, payload);
  },

  async deleteMetric(metricId) {
    return mutate('DELETE', `/api/metrics/${metricId}`, undefined);
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
    await idb.put('appointments', { id, status: 'scheduled', _pending: result.offline, ...payload });
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
