// Presence of a fetch handler is what makes browsers consider this app
// installable; screenmarker keeps its state client-side already, so this
// intentionally does no offline caching and just passes requests through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
