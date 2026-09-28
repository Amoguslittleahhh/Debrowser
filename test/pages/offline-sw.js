// Keeps the offline page and its "download" in Cache Storage; see offline.html.
const CACHE = 'offline-v1';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all([
    cache.add('offline.html'),
    cache.put('offline-video.bin', new Response(new Uint8Array(4096), { headers: { 'Content-Type': 'video/mp4' } }))
  ])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(caches.match(event.request, { ignoreSearch: true })
    .then((hit) => hit || fetch(event.request)));
});
