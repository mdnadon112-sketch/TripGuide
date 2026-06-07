/* TripGuide minimal service worker with raw push notification handling */
console.log('[TripGuide SW] worker evaluating');

self.addEventListener('install', () => {
  console.log('[TripGuide SW] install');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[TripGuide SW] activate');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
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

  const title =
    notification.title ||
    data.title ||
    payload.title ||
    'TripGuide';

  const body =
    notification.body ||
    data.body ||
    payload.body ||
    'Trip update available.';

  const url =
    data.url ||
    fcmOptions.link ||
    (webpush.fcm_options && webpush.fcm_options.link) ||
    '/TripGuide/';

  const options = {
    body,
    icon: data.icon || notification.icon || './icon-192.png',
    badge: data.badge || './icon-192.png',
    data: {
      url
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const notificationData = (event.notification && event.notification.data) || {};
  const targetUrl = notificationData.url || '/TripGuide/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const normalizedTarget = new URL(targetUrl, self.location.origin);

      for (const client of clientList) {
        const clientUrl = new URL(client.url);
        if (clientUrl.pathname.indexOf('/TripGuide/') !== -1 && 'focus' in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(normalizedTarget.href);
      }

      return undefined;
    })
  );
});
