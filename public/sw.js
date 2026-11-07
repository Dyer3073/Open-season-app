'use strict';
// Open Season service worker — push notifications ONLY.
// No offline caching: fetch is a straight pass-through to the network, so the
// app can never get stuck serving a stale copy of itself.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass-through: do not intercept */ });

self.addEventListener('push', event => {
  let data = { title: 'Open Season', body: 'Something happened in the hunt.' };
  try { data = { ...data, ...event.data.json() }; } catch (_) {
    try { data.body = event.data.text() || data.body; } catch (_) { /* keep default */ }
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag || 'open-season',
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) return w.focus();
    }
    return self.clients.openWindow(target);
  })());
});
