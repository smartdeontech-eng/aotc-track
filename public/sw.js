// AOTC Track service worker — delivers push notifications and routes taps to
// the exact area of attention.
// (No offline caching here on purpose: the app is light and always-online,
// and stale caches cause more confusion than they save.)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'AOTC Track';
  const url = data.url || '/';
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/img/icon-192.png',
      badge: '/img/icon-192.png',
      tag: data.tag || undefined,
      data: { url },
    });
    // If the app is already open, tell it a notification arrived so it can show
    // an in-app banner (the "decide when to jump" path).
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    all.forEach(c => c.postMessage({ type: 'aotc-push', title, body: data.body || '', url }));
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        // Hand the target to the app so it can guard unsaved work before
        // navigating, instead of the SW hard-reloading the tab.
        c.postMessage({ type: 'aotc-nav', url });
        return;
      }
    }
    // Nothing open — deep-link straight to the area of attention.
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
