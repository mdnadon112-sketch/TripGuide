#!/usr/bin/env node

const admin = require('firebase-admin');

const TRACKER_BASE = 'tripGuide';
const TARGET_TYPES = new Set(['allActive', 'adminsOnly', 'approvedViewers', 'singleUser']);
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const FCM_BATCH_SIZE = 500;
const MAX_TITLE = 80;
const MAX_BODY = 240;

function normalizeString(value, maxLen, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  if (normalized.length > maxLen) {
    throw new Error(`${fieldName} must be <= ${maxLen} chars.`);
  }
  return normalized;
}

function normalizeUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '/TripGuide/';
  }
  if (normalized.length > 2048) {
    throw new Error('url is too long.');
  }
  return normalized;
}

function toEpoch(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function isActiveTokenRecord(record, now) {
  if (!record || record.enabled !== true) return false;
  if (typeof record.token !== 'string' || !record.token.trim()) return false;
  const lastSeen = toEpoch(record.lastSeen || record.createdAt);
  return lastSeen > 0 && (now - lastSeen) <= NINETY_DAYS_MS;
}

function classifySendError(code) {
  const value = String(code || '');
  if (value.includes('registration-token-not-registered')) {
    return { reason: 'not-registered', disable: true };
  }
  if (value.includes('invalid-registration-token')) {
    return { reason: 'invalid-token', disable: true };
  }
  return { reason: 'send-failed', disable: false };
}

function toBatches(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

async function loadRoleSets(db) {
  const [adminsSnap, approvedSnap] = await Promise.all([
    db.ref(`${TRACKER_BASE}/admins`).get(),
    db.ref(`${TRACKER_BASE}/approvedUsers`).get()
  ]);

  const admins = new Set();
  Object.entries(adminsSnap.val() || {}).forEach(([uid, record]) => {
    if (record && record.admin === true) {
      admins.add(uid);
    }
  });

  const approved = new Set();
  Object.entries(approvedSnap.val() || {}).forEach(([uid, record]) => {
    if (record && (record.approved === true || record.admin === true)) {
      approved.add(uid);
    }
  });

  return { admins, approved };
}

function getInput(name, fallback = '') {
  const envName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return process.env[envName] || fallback;
}

function resolveDatabaseUrl(serviceAccount) {
  const envDatabaseUrl = String(process.env.FIREBASE_DATABASE_URL || '').trim();
  const jsonDatabaseUrl = String(serviceAccount.database_url || '').trim();
  const projectId = String(serviceAccount.project_id || '').trim();

  if (envDatabaseUrl) return envDatabaseUrl;
  if (jsonDatabaseUrl) return jsonDatabaseUrl;
  if (!projectId) return '';

  // Most RTDB instances use the -default-rtdb hostname; firebaseio.com is kept as fallback.
  return `https://${projectId}-default-rtdb.firebaseio.com`;
}

async function main() {
  const title = normalizeString(getInput('title'), MAX_TITLE, 'title');
  const body = normalizeString(getInput('body'), MAX_BODY, 'body');
  const targetType = String(getInput('targetType')).trim();
  const uid = String(getInput('uid')).trim();
  const url = normalizeUrl(getInput('url', '/TripGuide/'));
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!TARGET_TYPES.has(targetType)) {
    throw new Error('targetType must be one of allActive, adminsOnly, approvedViewers, singleUser.');
  }
  if (targetType === 'singleUser' && !uid) {
    throw new Error('uid is required when targetType is singleUser.');
  }
  if (!serviceAccountJson) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON secret.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (error) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }

  const databaseURL = resolveDatabaseUrl(serviceAccount);
  if (!databaseURL) {
    throw new Error('Unable to determine Realtime Database URL. Add database_url in the service account JSON or set FIREBASE_DATABASE_URL secret.');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL
  });

  const db = admin.database();
  const messaging = admin.messaging();

  const now = Date.now();
  const tokensSnap = await db.ref(`${TRACKER_BASE}/pushTokens`).get();
  const rawTokens = tokensSnap.val() || {};

  const needsRoles = targetType === 'adminsOnly' || targetType === 'approvedViewers';
  const roles = needsRoles ? await loadRoleSets(db) : { admins: new Set(), approved: new Set() };

  const selected = [];
  Object.entries(rawTokens).forEach(([tokenUid, tokenMap]) => {
    const includeUid = (
      targetType === 'allActive' ||
      (targetType === 'singleUser' && tokenUid === uid) ||
      (targetType === 'adminsOnly' && roles.admins.has(tokenUid)) ||
      (targetType === 'approvedViewers' && (roles.admins.has(tokenUid) || roles.approved.has(tokenUid)))
    );

    if (!includeUid) return;

    Object.entries(tokenMap || {}).forEach(([tokenId, record]) => {
      if (!isActiveTokenRecord(record, now)) return;
      selected.push({ uid: tokenUid, tokenId, token: String(record.token).trim() });
    });
  });

  if (!selected.length) {
    console.log('attempted=0 success=0 failure=0 cleaned=0');
    console.log('No active tokens matched the selected target.');
    return;
  }

  const sentAt = String(now);
  let successCount = 0;
  let failureCount = 0;
  let cleanedCount = 0;
  const cleanupUpdates = {};

  const batches = toBatches(selected, FCM_BATCH_SIZE);

  for (const batch of batches) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map((item) => item.token),
      notification: { title, body },
      webpush: {
        notification: { title, body, click_action: url },
        fcmOptions: { link: url }
      },
      data: {
        type: 'tripGuide',
        url,
        sentAt
      }
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((result, idx) => {
      if (result.success) return;

      const item = batch[idx];
      const code = result.error && result.error.code;
      const failure = classifySendError(code);

      cleanupUpdates[`${item.uid}/${item.tokenId}/lastSendFailureReason`] = failure.reason;
      cleanupUpdates[`${item.uid}/${item.tokenId}/lastSendFailureAt`] = now;
      cleanupUpdates[`${item.uid}/${item.tokenId}/lastErrorCode`] = String(code || 'unknown-error');

      if (failure.disable) {
        cleanupUpdates[`${item.uid}/${item.tokenId}/enabled`] = false;
        cleanupUpdates[`${item.uid}/${item.tokenId}/cleanupReason`] = failure.reason;
        cleanupUpdates[`${item.uid}/${item.tokenId}/cleanupAt`] = now;
        cleanedCount += 1;
      }
    });
  }

  if (Object.keys(cleanupUpdates).length > 0) {
    await db.ref(`${TRACKER_BASE}/pushTokens`).update(cleanupUpdates);
  }

  console.log(`attempted=${selected.length} success=${successCount} failure=${failureCount} cleaned=${cleanedCount}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
