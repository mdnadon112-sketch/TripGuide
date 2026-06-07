/* Place this file next to index.html on GitHub Pages: /TripGuide/firebase-messaging-sw.js */
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js');

firebase.initializeApp({
  "apiKey": "AIzaSyD4juSgEvK9CBX0ROiMnmmJrYYkSwI_2U4",
  "authDomain": "tripguide-f5056.firebaseapp.com",
  "databaseURL": "https://tripguide-f5056-default-rtdb.firebaseio.com",
  "projectId": "tripguide-f5056",
  "storageBucket": "tripguide-f5056.firebasestorage.app",
  "messagingSenderId": "890615280609",
  "appId": "1:890615280609:web:4f77c8e37fa7ec622418a0",
  "measurementId": "G-6STL3XZ7S4"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notification = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(notification.title || 'TripGuide', {
    body: notification.body || 'Trip update available.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: data.url || './' }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || './';
  event.waitUntil(clients.openWindow(url));
});
