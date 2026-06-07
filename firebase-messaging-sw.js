console.log('[TripGuide SW] evaluating firebase-messaging-sw.js');

importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: 'AIzaSyD4juSgEvK9CBX0ROiMnmmJrYYkSwI_2U4',
  authDomain: 'tripguide-f5056.firebaseapp.com',
  databaseURL: 'https://tripguide-f5056-default-rtdb.firebaseio.com',
  projectId: 'tripguide-f5056',
  storageBucket: 'tripguide-f5056.firebasestorage.app',
  messagingSenderId: '890615280609',
  appId: '1:890615280609:web:4f77c8e37fa7ec622418a0'
};

self.addEventListener('install', () => {
  console.log('[TripGuide SW] install');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[TripGuide SW] activate');
  event.waitUntil(self.clients.claim());
});

try {
  if (typeof firebase === 'undefined') {
    throw new Error('Firebase compat import failed; firebase is undefined.');
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  console.log('[TripGuide SW] Firebase initialized');
} catch (err) {
  console.error('[TripGuide SW] Firebase initialization failed:', err);
}

let messaging = null;

try {
  if (firebase && firebase.messaging && firebase.messaging.isSupported) {
    firebase.messaging.isSupported()
      .then((supported) => {
        if (!supported) {
          console.warn('[TripGuide SW] Firebase messaging not supported in this service worker context.');
          return;
        }

        messaging = firebase.messaging();

        messaging.onBackgroundMessage((payload) => {
          const notification = payload.notification || {};
          const title = notification.title || 'Final Trip Update';

          self.registration.showNotification(title, {
            body: notification.body || 'New trip update available.',
            icon: './icon-192.png',
            badge: './icon-192.png',
            data: payload.data || {}
          });
        });
      })
      .catch((err) => {
        console.warn('[TripGuide SW] Messaging support check failed:', err);
      });
  }
} catch (err) {
  console.warn('[TripGuide SW] Firebase Messaging setup failed:', err);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/TripGuide/') && 'focus' in client) {
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
