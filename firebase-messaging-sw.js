/* TripGuide service worker: raw push handler (import-free, registration-safe) */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    try {
      payload = { data: { body: event.data ? event.data.text() : '' } };
    } catch (_) {
      payload = {};
    }
  }

  const notification = payload.notification || {};
  const data = payload.data || {};
  const webpush = payload.webpush || {};
  const fcmOptions = payload.fcmOptions || {};

  const title = notification.title || data.title || payload.title || 'TripGuide';
  const body = notification.body || data.body || payload.body || 'New TripGuide update';
  const url = data.url || fcmOptions.link || (webpush.fcm_options && webpush.fcm_options.link) || 'https://mdnadon112-sketch.github.io/TripGuide/';

  const options = {
    body,
    icon: data.icon || notification.icon || '/TripGuide/icon-192.png',
    badge: data.badge || '/TripGuide/icon-192.png',
    data: { url }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const fallbackUrl = 'https://mdnadon112-sketch.github.io/TripGuide/';
  const rawUrl =
    (event.notification && event.notification.data && event.notification.data.url) ||
    fallbackUrl;
  let targetUrl = fallbackUrl;
  try {
    targetUrl = new URL(rawUrl, fallbackUrl).href;
  } catch (_) {
    targetUrl = fallbackUrl;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const tripGuideClient = clientList.find((client) => {
        try {
          return String(client.url || '').includes('/TripGuide');
        } catch (_) {
          return false;
        }
      });

      if (tripGuideClient) {
        return tripGuideClient.focus()
          .then(() => ('navigate' in tripGuideClient ? tripGuideClient.navigate(targetUrl) : tripGuideClient))
          .catch(() => tripGuideClient.focus());
      }

      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus()
            .then(() => ('navigate' in client ? client.navigate(targetUrl) : client))
            .catch(() => client.focus());
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
      return undefined;
    })
  );
});
