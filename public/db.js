// Minimal IndexedDB wrapper — no external libraries (keeps this $0 and
// dependency-free). Holds a local mirror of server data so the app can be
// viewed offline, plus an "outbox" of queued writes made while offline.
const DB_NAME = 'fitcube-erp';
const DB_VERSION = 2;
const STORES = ['clients', 'services', 'products', 'appointments', 'meta', 'outbox', 'templates'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('clients')) db.createObjectStore('clients', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('services')) db.createObjectStore('services', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('appointments')) db.createObjectStore('appointments', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('templates')) db.createObjectStore('templates', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

const idb = {
  async putAll(storeName, items) {
    return tx(storeName, 'readwrite', (store) => {
      items.forEach((item) => store.put(item));
    });
  },
  async put(storeName, item) {
    return tx(storeName, 'readwrite', (store) => store.put(item));
  },
  async delete(storeName, key) {
    return tx(storeName, 'readwrite', (store) => store.delete(key));
  },
  async getAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readonly');
      const req = t.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async get(storeName, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, 'readonly');
      const req = t.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async clear(storeName) {
    return tx(storeName, 'readwrite', (store) => store.clear());
  },
  // Outbox: queued mutations to replay against the server once back online.
  async queueMutation(method, url, body, requestId) {
    return tx('outbox', 'readwrite', (store) => {
      store.add({ method, url, body: body ?? null, requestId: requestId || null, createdAt: Date.now() });
    });
  },
  async getOutbox() {
    return idb.getAll('outbox');
  },
  async removeFromOutbox(id) {
    return idb.delete('outbox', id);
  },
  async outboxCount() {
    const items = await idb.getAll('outbox');
    return items.length;
  },
};

window.idb = idb;
