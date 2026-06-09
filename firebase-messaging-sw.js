/* TripGuide service worker: raw push handler (import-free, registration-safe) */
const TRIPGUIDE_SW_BUILD = 'v5.28-authfix-2026-06-09T00:00:00Z';
const TRIPGUIDE_FALLBACK_URL = 'https://mdnadon112-sketch.github.io/TripGuide/';
const TRIPGUIDE_ORIGIN = 'https://mdnadon112-sketch.github.io';
const TRIPGUIDE_PATH_PREFIX = '/TripGuide';

function normalizeTripGuideUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim() || TRIPGUIDE_FALLBACK_URL, TRIPGUIDE_FALLBACK_URL);
    if (parsed.origin !== TRIPGUIDE_ORIGIN) return TRIPGUIDE_FALLBACK_URL;
    if (!String(parsed.pathname || '').startsWith(TRIPGUIDE_PATH_PREFIX)) return TRIPGUIDE_FALLBACK_URL;
    return parsed.href;
  } catch (_) {
    return TRIPGUIDE_FALLBACK_URL;
  }
}

self.addEventListener('install', () => {
  // Keep this worker push-only; no fetch handler means auth redirects are untouched.
  console.log('[TripGuide SW] install', TRIPGUIDE_SW_BUILD);
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[TripGuide SW] activate', TRIPGUIDE_SW_BUILD);
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
  const fcmMsgData = (data && data.FCM_MSG && data.FCM_MSG.data) || (payload && payload.FCM_MSG && payload.FCM_MSG.data) || {};

  const title = notification.title || data.title || payload.title || 'TripGuide';
  const body = notification.body || data.body || payload.body || 'New TripGuide update';
  const url = normalizeTripGuideUrl(
    data.url ||
    fcmOptions.link ||
    (webpush.fcm_options && webpush.fcm_options.link) ||
    (fcmMsgData && fcmMsgData.url) ||
    TRIPGUIDE_FALLBACK_URL
  );

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

  const fallbackUrl = TRIPGUIDE_FALLBACK_URL;
  const data = (event.notification && event.notification.data) || {};
  const nestedFcmData = (data && data.FCM_MSG && data.FCM_MSG.data) || {};
  const rawUrl =
    data.url ||
    nestedFcmData.url ||
    fallbackUrl;
  const targetUrl = normalizeTripGuideUrl(rawUrl);
  let targetOrigin = TRIPGUIDE_ORIGIN;
  try { targetOrigin = new URL(targetUrl).origin; } catch (_) { }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const exactClient = clientList.find((client) => String(client.url || '') === targetUrl);
      if (exactClient && 'focus' in exactClient) {
        return exactClient.focus();
      }

      const sameOriginClient = clientList.find((client) => {
        try {
          return new URL(String(client.url || ''), fallbackUrl).origin === targetOrigin;
        } catch (_) {
          return false;
        }
      });

      if (sameOriginClient && 'focus' in sameOriginClient) {
        return sameOriginClient.focus()
          .then(() => ('navigate' in sameOriginClient ? sameOriginClient.navigate(targetUrl) : sameOriginClient))
          .catch(() => sameOriginClient.focus());
      }

      if (clients.openWindow) return clients.openWindow(targetUrl);
      return undefined;
    })
  );
});
