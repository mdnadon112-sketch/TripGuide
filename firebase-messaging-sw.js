/* TripGuide minimal service worker — registration test */
console.log('[TripGuide SW] minimal worker evaluating');

self.addEventListener('install', () => {
  console.log('[TripGuide SW] install');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[TripGuide SW] activate');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.indexOf('/TripGuide/') !== -1 && 'focus' in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow('./');
      }

      return undefined;
    })
  );
});
