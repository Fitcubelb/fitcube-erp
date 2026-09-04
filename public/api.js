// Thin API layer: talks to the server when online, and transparently falls
// back to the IndexedDB mirror when offline. Writes made offline are queued
// in the outbox (see db.js / sync.js) and replayed once the connection is
// back — the UI updates optimistically in the meantime.

async function rawFetch(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function get(url) {
  return rawFetch('GET', url);
}

async function mutate(method, url, body) {
  try {
    return { data: await rawFetch(method, url, body), offline: false };
  } catch (err) {
    // Network failure (offline / server unreachable) -> queue for later.
    // A real validation error from the server (4xx) also throws here, but
    // since we're offline-first we can't tell the difference without a
    // reachability check; we optimistically assume "offline" so nothing the
    // user enters locally is ever silently dropped.
    await idb.queueMutation(method, url, body);
    return { data: null, offline: true };
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
};

window.api = api;
