/* Place this file next to index.html on GitHub Pages: /TripGuide/firebase-messaging-sw.js */
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: 'AIzaSyD4juSgEvK9CBX0ROiMnmmJrYYkSwI_2U4',
  authDomain: 'tripguide-f5056.firebaseapp.com',
  databaseURL: 'https://tripguide-f5056-default-rtdb.firebaseio.com',
  projectId: 'tripguide-f5056',
  storageBucket: 'tripguide-f5056.firebasestorage.app',
  messagingSenderId: '890615280609',
  appId: '1:890615280609:web:4f77c8e37fa7ec622418a0',
  measurementId: 'G-6STL3XZ7S4'
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

let messaging = null;

try {
  messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const notification = payload.notification || {};
    const title = notification.title || 'Final Trip Update';
    const options = {
      body: notification.body || 'New trip update available.',
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: payload.data || {}
    };

    self.registration.showNotification(title, options);
  });
} catch (err) {
  console.warn('[TripGuide SW] Firebase Messaging init failed:', err);
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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
