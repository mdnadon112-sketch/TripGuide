#!/usr/bin/env node

const admin = require('firebase-admin');

const TRACKER_BASE = 'tripGuide';
const SITE_URL = 'https://mdnadon112-sketch.github.io/TripGuide/';
const ADMIN_EMAILS = new Set([
  'mdnadon112@gmail.com',
  'pinnerpatter@gmail.com',
  'mdnadon112@googlemail.com',
  'pinnerpatter@googlemail.com'
]);

const MAX_TOKEN_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const FCM_BATCH_SIZE = 500;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function resolveDatabaseUrl(serviceAccount) {
  const envUrl = String(process.env.FIREBASE_DATABASE_URL || '').trim();
  if (envUrl) return envUrl;

  const jsonUrl = String(serviceAccount.database_url || '').trim();
  if (jsonUrl) return jsonUrl;

  const projectId = String(serviceAccount.project_id || '').trim();
  if (projectId) return `https://${projectId}-default-rtdb.firebaseio.com`;

  throw new Error('Missing Firebase database URL.');
}

function toEpoch(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isTokenActive(record, now) {
  if (!record) return false;
  if (record.enabled === false) return false;
  if (typeof record.token !== 'string' || !record.token.trim()) return false;

  const lastSeen = toEpoch(record.lastSeen || record.createdAt);
  if (!lastSeen) return true;

  return now - lastSeen <= MAX_TOKEN_AGE_MS;
}

async function loadTokens(db, target = 'all') {
  const now = Date.now();

  const [tokensSnap, adminsSnap] = await Promise.all([
    db.ref(`${TRACKER_BASE}/pushTokens`).get(),
    db.ref(`${TRACKER_BASE}/admins`).get()
  ]);

  const rawTokens = tokensSnap.val() || {};
  const admins = adminsSnap.val() || {};
  const tokens = [];

  Object.entries(rawTokens).forEach(([uid, tokenMap]) => {
    const adminByUid = !!(admins[uid] && admins[uid].admin === true);

    Object.values(tokenMap || {}).forEach((record) => {
      if (!isTokenActive(record, now)) return;

      const email = cleanEmail(record.email);
      const adminByEmail = ADMIN_EMAILS.has(email);

      if (target === 'admins' && !adminByUid && !adminByEmail) return;

      tokens.push(String(record.token).trim());
    });
  });

  return [...new Set(tokens)];
}

async function sendPush(db, messaging, target, title, body, url = SITE_URL) {
  const tokens = await loadTokens(db, target);

  if (!tokens.length) {
    console.log(`No tokens for target=${target}: ${title}`);
    return { attempted: 0, success: 0, failure: 0 };
  }

  let success = 0;
  let failure = 0;

  for (const batch of batches(tokens, FCM_BATCH_SIZE)) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: {
        title,
        body
      },
      webpush: {
        fcmOptions: {
          link: url
        },
        notification: {
          title,
          body,
          icon: '/TripGuide/icon-192.png'
        }
      },
      data: {
        type: 'tripGuide',
        title,
        body,
        url,
        sentAt: String(Date.now())
      }
    });

    success += response.successCount;
    failure += response.failureCount;
  }

  console.log(`sent target=${target} attempted=${tokens.length} success=${success} failure=${failure} title="${title}"`);

  return { attempted: tokens.length, success, failure };
}

async function main() {
  const serviceAccount = JSON.parse(required('FIREBASE_SERVICE_ACCOUNT_JSON'));

  const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: resolveDatabaseUrl(serviceAccount)
  });

  try {
    const db = admin.database();
    const messaging = admin.messaging();

    const [liveSnap, messagesSnap, requestsSnap, stateSnap] = await Promise.all([
      db.ref(`${TRACKER_BASE}/live`).get(),
      db.ref(`${TRACKER_BASE}/messages`).orderByChild('createdAt').limitToLast(5).get(),
      db.ref(`${TRACKER_BASE}/accessRequests`).get(),
      db.ref(`${TRACKER_BASE}/notificationState`).get()
    ]);

    const live = liveSnap.val() || {};
    const messages = messagesSnap.val() || {};
    const requests = requestsSnap.val() || {};
    const state = stateSnap.val() || {};
    const updates = {};

    const now = Date.now();

    // 1. Trip started / stopped
    const trackingActive = live.trackingActive === true;
    const previousTrackingActive = state.trackingActive === true;

    if (trackingActive !== previousTrackingActive) {
      if (trackingActive) {
        await sendPush(
          db,
          messaging,
          'all',
          'TripGuide: tracking started',
          'Mike and Lauren are live on the trip map.',
          SITE_URL
        );
      } else if (state.trackingActiveSeenOnce === true) {
        await sendPush(
          db,
          messaging,
          'all',
          'TripGuide: tracking stopped',
          'Live tracking has stopped for now.',
          SITE_URL
        );
      }

      updates.trackingActive = trackingActive;
      updates.trackingActiveSeenOnce = true;
      updates.trackingActiveChangedAt = now;
    }

    // 2. Active day changed
    const activeDay = Number(live.activeDay || 0);
    const previousActiveDay = Number(state.activeDay || 0);

    if (activeDay >= 1 && activeDay <= 9 && activeDay !== previousActiveDay) {
      await sendPush(
        db,
        messaging,
        'all',
        `TripGuide: Day ${activeDay} active`,
        `The live trip tracker is now on Day ${activeDay}.`,
        `${SITE_URL}#day-${activeDay}`
      );

      updates.activeDay = activeDay;
      updates.activeDayChangedAt = now;
    }

    // 3. New message posted
    let newestMessage = null;

    Object.entries(messages).forEach(([id, msg]) => {
      const createdAt = toEpoch(msg && msg.createdAt);
      if (!createdAt) return;
      if (!newestMessage || createdAt > newestMessage.createdAt) {
        newestMessage = {
          id,
          createdAt,
          name: msg.name || msg.displayName || 'Someone',
          text: String(msg.text || msg.message || '').trim()
        };
      }
    });

    if (
      newestMessage &&
      newestMessage.id !== state.lastMessageId &&
      newestMessage.createdAt > toEpoch(state.lastMessageAt)
    ) {
      const preview = newestMessage.text.slice(0, 120) || 'New trip message posted.';

      await sendPush(
        db,
        messaging,
        'all',
        `TripGuide message from ${newestMessage.name}`,
        preview,
        SITE_URL
      );

      updates.lastMessageId = newestMessage.id;
      updates.lastMessageAt = newestMessage.createdAt;
    }

    // 4. New access request
    let newestPendingRequest = null;

    Object.entries(requests).forEach(([uid, req]) => {
      if (!req || req.status !== 'pending') return;

      const requestedAt = toEpoch(req.requestedAt || req.createdAt);
      if (!requestedAt) return;

      if (!newestPendingRequest || requestedAt > newestPendingRequest.requestedAt) {
        newestPendingRequest = {
          uid,
          requestedAt,
          name: req.name || req.displayName || req.email || 'New viewer'
        };
      }
    });

    if (
      newestPendingRequest &&
      newestPendingRequest.uid !== state.lastAccessRequestUid &&
      newestPendingRequest.requestedAt > toEpoch(state.lastAccessRequestAt)
    ) {
      await sendPush(
        db,
        messaging,
        'admins',
        'TripGuide access request',
        `${newestPendingRequest.name} requested access to the live trip hub.`,
        SITE_URL
      );

      updates.lastAccessRequestUid = newestPendingRequest.uid;
      updates.lastAccessRequestAt = newestPendingRequest.requestedAt;
    }

    if (Object.keys(updates).length) {
      updates.updatedAt = now;
      await db.ref(`${TRACKER_BASE}/notificationState`).update(updates);
      console.log('notificationState updated');
    } else {
      console.log('No notification changes.');
    }
  } finally {
    await app.delete();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
