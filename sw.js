const CACHE = 'bossmetal-v40';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './boss-metal-icon-180.png', './boss-metal-icon-192.png', './boss-metal-icon-512.png', './plantilla.xlsx?v=3', './avisos.js?v=1', './nomina.js?v=gastos15','./gastos.js?v=11', './balance.js?v=9', './excel-corporativo.js?v=3'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all(['bossmetal-v1', 'bossmetal-v2', 'bossmetal-v3', 'bossmetal-v4', 'bossmetal-v5', 'bossmetal-v6', 'bossmetal-v7', 'bossmetal-v8', 'bossmetal-v9', 'bossmetal-v10', 'bossmetal-v11', 'bossmetal-v12', 'bossmetal-v13', 'bossmetal-v14','bossmetal-v15','bossmetal-v16','bossmetal-v17','bossmetal-v18','bossmetal-v19','bossmetal-v20','bossmetal-v21','bossmetal-v22','bossmetal-v23','bossmetal-v24','bossmetal-v25','bossmetal-v26','bossmetal-v27','bossmetal-v28','bossmetal-v29','bossmetal-v30','bossmetal-v31','bossmetal-v32','bossmetal-v33','bossmetal-v34','bossmetal-v35','bossmetal-v36','bossmetal-v37','bossmetal-v38','bossmetal-v39'].map(name => caches.delete(name)))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const home = new URL('./index.html', self.registration.scope).href;
        const path = new URL(request.url).pathname;
        const isHome = path === new URL(home).pathname || path === new URL(self.registration.scope).pathname;
        let response;
        try {
          response = await fetch(request, { cache: 'reload' });
        } catch {
          return (isHome && await cache.match(home)) || Response.error();
        }
        if (isHome && response.ok && response.headers.get('content-type')?.includes('text/html')) {
          await cache.put(home, response.clone()).catch(() => {});
        }
        return response;
      })()
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async cache => (await cache.match(request)) ?? fetch(request))
  );
});

self.addEventListener('push', event => {
  const notice = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification(notice.title || 'Constructora Boss Metal',{
    body:notice.body,tag:'boss-aviso-'+notice.id,icon:new URL('./boss-metal-icon-192.png',self.registration.scope).href
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({type:'window'});
    const page = pages.find(client=>client.url.startsWith(self.registration.scope));
    if (page) { await page.focus(); page.postMessage('abrir-avisos'); }
    else await self.clients.openWindow(new URL('./index.html#avisos',self.registration.scope).href);
  })());
});
