importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyD4juSgEvK9CBX0ROiMnmmJrYYkSwI_2U4',
  authDomain: 'tripguide-f5056.firebaseapp.com',
  databaseURL: 'https://tripguide-f5056-default-rtdb.firebaseio.com',
  projectId: 'tripguide-f5056',
  storageBucket: 'tripguide-f5056.firebasestorage.app',
  messagingSenderId: '890615280609',
  appId: '1:890615280609:web:4f77c8e37fa7ec622418a0'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Background message:', payload);

  const title =
    (payload.notification && payload.notification.title) ||
    (payload.data && payload.data.title) ||
    'TripGuide';

  const options = {
    body:
      (payload.notification && payload.notification.body) ||
      (payload.data && payload.data.body) ||
      'New TripGuide update',
    icon: '/TripGuide/icon-192.png',
    badge: '/TripGuide/icon-192.png',
    data: {
      url: (payload.data && payload.data.url) || 'https://mdnadon112-sketch.github.io/TripGuide/'
    }
  };

  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url =
    (event.notification && event.notification.data && event.notification.data.url) ||
    'https://mdnadon112-sketch.github.io/TripGuide/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
      return undefined;
    })
  );
});
