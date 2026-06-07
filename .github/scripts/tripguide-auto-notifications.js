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
const LIVE_STALE_MS = 15 * 60 * 1000;
const LIVE_STALE_REPEAT_MS = 60 * 60 * 1000;

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

function canonicalEmail(value) {
  return cleanEmail(value).replace(/@googlemail\.com$/, '@gmail.com');
}

function cleanText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
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

function isBlockedRecord(record) {
  if (!record) return false;
  if (record === true) return true;
  if (typeof record === 'object') {
    if (record.blocked === false) return false;
    if (record.blocked === true) return true;
    if (record.status === 'blocked') return true;
    if (record.isBlocked === true) return true;
    return true;
  }
  return false;
}

function buildRoleSets(admins, approvedUsers, blockedUsers) {
  const adminUids = new Set();
  const approvedUids = new Set();
  const blockedUids = new Set();

  Object.entries(admins || {}).forEach(([uid, record]) => {
    if (record && record.admin === true) adminUids.add(uid);
  });

  Object.entries(approvedUsers || {}).forEach(([uid, record]) => {
    if (record && (record.approved === true || record.admin === true)) approvedUids.add(uid);
    if (record && record.admin === true) adminUids.add(uid);
  });

  adminUids.forEach((uid) => approvedUids.add(uid));

  Object.entries(blockedUsers || {}).forEach(([uid, record]) => {
    if (isBlockedRecord(record)) blockedUids.add(uid);
  });

  return { adminUids, approvedUids, blockedUids };
}

function classifySendError(code) {
  const value = String(code || '');
  if (value.includes('registration-token-not-registered')) return { reason: 'not-registered', disable: true };
  if (value.includes('invalid-registration-token')) return { reason: 'invalid-token', disable: true };
  return { reason: 'send-failed', disable: false };
}

function collectTargetTokenRecords(context, target, targetUid, options = {}) {
  const now = Date.now();
  const allowUnapprovedSingleUser = options.allowUnapprovedSingleUser === true;
  const dedup = new Map();

  Object.entries(context.pushTokens || {}).forEach(([uid, tokenMap]) => {
    const isBlocked = context.roles.blockedUids.has(uid);
    if (isBlocked) return;

    const adminByUid = context.roles.adminUids.has(uid);
    const approvedByUid = context.roles.approvedUids.has(uid);

    Object.entries(tokenMap || {}).forEach(([tokenId, record]) => {
      if (!isTokenActive(record, now)) return;

      const token = String(record.token || '').trim();
      if (!token) return;

      const adminByEmail = ADMIN_EMAILS.has(canonicalEmail(record.email));
      let include = false;

      if (target === 'admins') {
        include = adminByUid || adminByEmail;
      } else if (target === 'all') {
        include = adminByUid || approvedByUid;
      } else if (target === 'singleUser') {
        include = uid === targetUid && (allowUnapprovedSingleUser || adminByUid || approvedByUid);
      }

      if (!include) return;
      if (!dedup.has(token)) dedup.set(token, { uid, tokenId, token });
    });
  });

  return Array.from(dedup.values());
}

async function sendPush(context, messaging, target, title, body, url = SITE_URL, options = {}) {
  const tokenRecords = collectTargetTokenRecords(context, target, options.uid || '', {
    allowUnapprovedSingleUser: options.allowUnapprovedSingleUser === true
  });

  if (!tokenRecords.length) {
    console.log(`sent target=${target} attempted=0 success=0 failure=0 cleaned=0 title="${title}"`);
    return { attempted: 0, success: 0, failure: 0, cleaned: 0 };
  }

  let success = 0;
  let failure = 0;
  let cleaned = 0;
  const cleanupUpdates = {};

  for (const batch of batches(tokenRecords, FCM_BATCH_SIZE)) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map((entry) => entry.token),
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
          icon: '/TripGuide/icon-192.png',
          badge: '/TripGuide/icon-192.png'
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

    response.responses.forEach((result, idx) => {
      if (result.success) return;
      const item = batch[idx];
      if (!item) return;

      const code = result.error && result.error.code;
      const sendError = classifySendError(code);
      cleanupUpdates[`${item.uid}/${item.tokenId}/lastSendFailureReason`] = sendError.reason;
      cleanupUpdates[`${item.uid}/${item.tokenId}/lastSendFailureAt`] = Date.now();
      cleanupUpdates[`${item.uid}/${item.tokenId}/lastErrorCode`] = String(code || 'unknown-error');

      if (sendError.disable) {
        cleanupUpdates[`${item.uid}/${item.tokenId}/enabled`] = false;
        cleanupUpdates[`${item.uid}/${item.tokenId}/cleanupReason`] = sendError.reason;
        cleanupUpdates[`${item.uid}/${item.tokenId}/cleanupAt`] = Date.now();
        cleaned += 1;
      }
    });
  }

  if (Object.keys(cleanupUpdates).length > 0) {
    await context.db.ref(`${TRACKER_BASE}/pushTokens`).update(cleanupUpdates);
  }

  console.log(`sent target=${target} attempted=${tokenRecords.length} success=${success} failure=${failure} cleaned=${cleaned} title="${title}"`);
  return { attempted: tokenRecords.length, success, failure, cleaned };
}

function newestLiveTimestamp(live, liveTrackers) {
  const fields = ['updatedAt', 'lastUpdated', 'lastSeen', 'timestamp', 'sentAt'];
  let newest = 0;

  fields.forEach((field) => {
    newest = Math.max(newest, toEpoch(live && live[field]));
  });

  Object.values(liveTrackers || {}).forEach((record) => {
    fields.forEach((field) => {
      newest = Math.max(newest, toEpoch(record && record[field]));
    });
  });

  return newest;
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

    const [
      liveSnap,
      liveTrackersSnap,
      messagesSnap,
      requestsSnap,
      adminsSnap,
      approvedSnap,
      blockedSnap,
      pushTokensSnap,
      stateSnap
    ] = await Promise.all([
      db.ref(`${TRACKER_BASE}/live`).get(),
      db.ref(`${TRACKER_BASE}/liveTrackers`).get(),
      db.ref(`${TRACKER_BASE}/messages`).orderByChild('createdAt').limitToLast(25).get(),
      db.ref(`${TRACKER_BASE}/accessRequests`).get(),
      db.ref(`${TRACKER_BASE}/admins`).get(),
      db.ref(`${TRACKER_BASE}/approvedUsers`).get(),
      db.ref(`${TRACKER_BASE}/blockedUsers`).get(),
      db.ref(`${TRACKER_BASE}/pushTokens`).get(),
      db.ref(`${TRACKER_BASE}/notificationState`).get()
    ]);

    const live = liveSnap.val() || {};
    const liveTrackers = liveTrackersSnap.val() || {};
    const messages = messagesSnap.val() || {};
    const requests = requestsSnap.val() || {};
    const admins = adminsSnap.val() || {};
    const approvedUsers = approvedSnap.val() || {};
    const blockedUsers = blockedSnap.val() || {};
    const pushTokens = pushTokensSnap.val() || {};
    const state = stateSnap.val() || {};

    const now = Date.now();
    const updates = {};
    let changed = false;

    const context = {
      db,
      pushTokens,
      admins,
      approvedUsers,
      blockedUsers,
      roles: buildRoleSets(admins, approvedUsers, blockedUsers)
    };

    // A/B: tracking started/stopped.
    const trackingActive = live.trackingActive === true;
    const previousTrackingActive = state.trackingActive === true;

    if (trackingActive !== previousTrackingActive) {
      if (trackingActive) {
        await sendPush(context, messaging, 'all', 'TripGuide: tracking started', 'Mike and Lauren are live on the trip map.', SITE_URL);
      } else if (state.trackingActiveSeenOnce === true) {
        await sendPush(context, messaging, 'all', 'TripGuide: tracking stopped', 'Live tracking has stopped for now.', SITE_URL);
      }
      updates.trackingActive = trackingActive;
      updates.trackingActiveSeenOnce = true;
      updates.trackingActiveChangedAt = now;
      changed = true;
    }

    // C: active day changed.
    const activeDay = Number(live.activeDay || 0);
    const previousActiveDay = Number(state.activeDay || 0);

    if (activeDay >= 1 && activeDay <= 9 && activeDay !== previousActiveDay) {
      await sendPush(
        context,
        messaging,
        'all',
        `TripGuide: Day ${activeDay} active`,
        `The trip tracker is now on Day ${activeDay}.`,
        `${SITE_URL}#day-${activeDay}`
      );

      updates.activeDay = activeDay;
      updates.activeDayChangedAt = now;
      changed = true;
    }

    // E: new message posted.
    let newestMessage = null;
    Object.entries(messages).forEach(([id, msg]) => {
      const createdAt = toEpoch(msg && msg.createdAt);
      if (!createdAt) return;
      if (!newestMessage || createdAt > newestMessage.createdAt) {
        newestMessage = {
          id,
          createdAt,
          name: cleanText(msg && (msg.name || msg.displayName), 'Someone'),
          text: cleanText(msg && (msg.text || msg.message), 'New trip message posted.')
        };
      }
    });

    if (
      newestMessage &&
      newestMessage.id !== state.lastMessageId &&
      newestMessage.createdAt > toEpoch(state.lastMessageAt)
    ) {
      await sendPush(
        context,
        messaging,
        'all',
        `TripGuide message from ${newestMessage.name}`,
        newestMessage.text.slice(0, 120),
        SITE_URL
      );

      updates.lastMessageId = newestMessage.id;
      updates.lastMessageAt = newestMessage.createdAt;
      changed = true;
    }

    // D: new pending access request.
    let newestPendingRequest = null;
    Object.entries(requests).forEach(([uid, req]) => {
      if (!req) return;
      const status = cleanText(req.status).toLowerCase();
      const isPending = status ? status === 'pending' : req.approved !== true;
      if (!isPending) return;

      const requestedAt = toEpoch(req.requestedAt || req.createdAt);
      if (!requestedAt) return;

      if (!newestPendingRequest || requestedAt > newestPendingRequest.requestedAt) {
        newestPendingRequest = {
          uid,
          requestedAt,
          name: cleanText(req.displayName || req.email || req.name, 'New viewer')
        };
      }
    });

    if (
      newestPendingRequest &&
      (newestPendingRequest.uid !== state.lastAccessRequestUid || newestPendingRequest.requestedAt > toEpoch(state.lastAccessRequestAt))
    ) {
      await sendPush(
        context,
        messaging,
        'admins',
        'TripGuide access request',
        `${newestPendingRequest.name} requested access to the live trip hub.`,
        SITE_URL
      );

      updates.lastAccessRequestUid = newestPendingRequest.uid;
      updates.lastAccessRequestAt = newestPendingRequest.requestedAt;
      changed = true;
    }

    // F/G: live signal stale / restored.
    const latestLiveAt = newestLiveTimestamp(live, liveTrackers);
    const liveAgeMs = latestLiveAt > 0 ? now - latestLiveAt : Number.POSITIVE_INFINITY;
    const liveIsStale = trackingActive && liveAgeMs > LIVE_STALE_MS;
    const liveWasStale = state.liveWasStale === true;
    const lastStaleAlertAt = toEpoch(state.lastStaleAlertAt);

    if (liveIsStale) {
      if (!liveWasStale || (now - lastStaleAlertAt) >= LIVE_STALE_REPEAT_MS) {
        await sendPush(
          context,
          messaging,
          'admins',
          'TripGuide live signal stale',
          'The live location has not updated in over 15 minutes.',
          SITE_URL
        );
        updates.lastStaleAlertAt = now;
        changed = true;
      }
      if (!liveWasStale) {
        updates.liveWasStale = true;
        changed = true;
      }
    } else if (liveWasStale && trackingActive && latestLiveAt > 0 && liveAgeMs <= LIVE_STALE_MS) {
      await sendPush(
        context,
        messaging,
        'admins',
        'TripGuide live signal restored',
        'Live location updates are coming through again.',
        SITE_URL
      );
      updates.liveWasStale = false;
      updates.lastRecoveredAt = now;
      changed = true;
    }

    // H: optional user approval notifications.
    const approvalNotices = Object.assign({}, state.approvalNotices || {});
    for (const [uid, record] of Object.entries(approvedUsers)) {
      const approved = !!(record && (record.approved === true || record.admin === true));
      if (!approved) continue;
      if (approvalNotices[uid]) continue;
      if (context.roles.blockedUids.has(uid)) continue;

      await sendPush(
        context,
        messaging,
        'singleUser',
        'TripGuide access approved',
        'You can now view Mike and Lauren\'s live trip hub.',
        SITE_URL,
        { uid, allowUnapprovedSingleUser: true }
      );

      approvalNotices[uid] = now;
      changed = true;
    }

    // I: optional blocked-user admin notifications.
    const blockedNotices = Object.assign({}, state.blockedNotices || {});
    for (const [uid, record] of Object.entries(blockedUsers)) {
      if (!isBlockedRecord(record)) continue;
      if (blockedNotices[uid]) continue;

      const name = cleanText(record && (record.displayName || record.email || record.name), 'A user');
      await sendPush(
        context,
        messaging,
        'admins',
        'TripGuide user blocked',
        `${name} was blocked from the live trip hub.`,
        SITE_URL
      );

      blockedNotices[uid] = now;
      changed = true;
    }

    updates.approvalNotices = approvalNotices;
    updates.blockedNotices = blockedNotices;

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = now;
      await db.ref(`${TRACKER_BASE}/notificationState`).update(updates);
      console.log('notificationState updated');
    }

    if (!changed) {
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
