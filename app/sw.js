// Service worker: keeps the app itself available offline.
// Data is never cached here - it lives in IndexedDB and moves via /api/sync.
const CACHE = 'bridge-register-v5'; // bump on every app release
const SHELL = ['./', 'index.html', 'app.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'tanroads-logo.jpg'];
const NETWORK_WAIT_MS = 3000; // on a weak signal, fall back to the stored copy after this

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first: always show the latest version when online, and keep a copy
// for offline use. If the network fails or is too slow, serve the stored copy.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const network = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const fallback = () => cache.match(e.request, { ignoreSearch: true })
      .then(hit => hit || network); // nothing stored yet: keep waiting for the network
    const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_WAIT_MS)).then(fallback);
    return Promise.race([network.catch(fallback), timeout]);
  }));
});
