// Service worker — network-first, no caching.
// Presence of this file satisfies the Android Chrome install criteria.
self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request));
});
