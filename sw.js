const CACHE = 'bossmetal-v4';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './boss-metal-icon-180.png', './boss-metal-icon-192.png', './boss-metal-icon-512.png', './plantilla.xlsx'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all(['bossmetal-v1', 'bossmetal-v2', 'bossmetal-v3'].map(name => caches.delete(name)))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-cache' }).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match(request, { ignoreSearch: true })) ?? Response.error();
      })
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async cache => (await cache.match(request)) ?? fetch(request))
  );
});
