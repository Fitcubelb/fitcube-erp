// Replays queued offline writes against the server once the connection is
// back, in the order they were made. Fires a 'fitcube:synced' event on
// `window` when a flush completes with at least one item sent, so the app
// can refresh its views.

let flushing = false;

async function flushOutbox() {
  if (flushing) return;
  if (!navigator.onLine) return;
  flushing = true;
  let sentAny = false;
  try {
    const items = await idb.getOutbox();
    for (const item of items.sort((a, b) => a.id - b.id)) {
      try {
        const headers = {};
        if (item.body !== null) headers['Content-Type'] = 'application/json';
        // Replaying with the id the write was first given lets the server
        // recognise anything it already accepted and skip it, instead of
        // creating a second copy.
        if (item.requestId) headers['X-Request-Id'] = item.requestId;
        const res = await fetch(item.url, {
          method: item.method,
          headers: Object.keys(headers).length ? headers : undefined,
          body: item.body !== null ? JSON.stringify(item.body) : undefined,
          credentials: 'same-origin',
        });
        if (res.status === 401) {
          // Signed out — nothing queued can succeed until that's fixed, and
          // retrying in a loop would be pointless. Keep the queue intact.
          window.dispatchEvent(new CustomEvent('fitcube:unauthorized'));
          break;
        }
        if (!res.ok && res.status >= 500) {
          // Server-side hiccup — stop here, try again on the next flush.
          break;
        }
        await idb.removeFromOutbox(item.id);
        sentAny = true;
      } catch {
        // Still offline / unreachable — stop, preserve order, retry later.
        break;
      }
    }
  } finally {
    flushing = false;
  }
  if (sentAny) {
    window.dispatchEvent(new CustomEvent('fitcube:synced'));
  }
}

window.addEventListener('online', flushOutbox);
window.addEventListener('load', () => {
  flushOutbox();
  // Cheap periodic retry in case 'online' doesn't fire reliably (some
  // mobile browsers are inconsistent about it).
  setInterval(flushOutbox, 20000);
});

window.fitcubeSync = { flushOutbox };
