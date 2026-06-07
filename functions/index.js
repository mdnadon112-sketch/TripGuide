const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

admin.initializeApp();

const db = admin.database();
const messaging = admin.messaging();

const TRACKER_BASE = 'tripGuide';
const TARGET_TYPES = new Set(['allActive', 'adminsOnly', 'approvedViewers', 'singleUser']);
const MAX_TITLE = 80;
const MAX_BODY = 240;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const FCM_BATCH_SIZE = 500;
const ADMIN_EMAILS = new Set([
  'mdnadon112@gmail.com',
  'pinnerpatter@gmail.com',
  'mdnadon112@googlemail.com',
  'pinnerpatter@googlemail.com'
].map(canonicalEmail));

function canonicalEmail(email) {
  return String(email || '').trim().toLowerCase().replace(/@googlemail\.com$/, '@gmail.com');
}

function normalizeString(value, maxLen, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new HttpsError('invalid-argument', `${fieldName} is required.`);
  if (normalized.length > maxLen) throw new HttpsError('invalid-argument', `${fieldName} must be <= ${maxLen} chars.`);
  return normalized;
}

function normalizeUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '/TripGuide/';
  if (normalized.length > 2048) throw new HttpsError('invalid-argument', 'url is too long.');
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
  if (value.includes('registration-token-not-registered')) return { reason: 'not-registered', disable: true };
  if (value.includes('invalid-registration-token')) return { reason: 'invalid-token', disable: true };
  return { reason: 'send-failed', disable: false };
}

function toBatches(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

async function callerIsAdmin(auth) {
  if (!auth || !auth.uid) return false;
  const emailAdmin = ADMIN_EMAILS.has(canonicalEmail(auth.token && auth.token.email));
  if (emailAdmin) return true;
  const snap = await db.ref(`${TRACKER_BASE}/admins/${auth.uid}/admin`).get();
  return snap.val() === true;
}

async function loadRoleSets() {
  const [adminsSnap, approvedSnap] = await Promise.all([
    db.ref(`${TRACKER_BASE}/admins`).get(),
    db.ref(`${TRACKER_BASE}/approvedUsers`).get()
  ]);

  const admins = new Set();
  Object.entries(adminsSnap.val() || {}).forEach(([uid, record]) => {
    if (record && record.admin === true) admins.add(uid);
  });

  const approved = new Set();
  Object.entries(approvedSnap.val() || {}).forEach(([uid, record]) => {
    if (record && (record.approved === true || record.admin === true)) approved.add(uid);
  });

  return { admins, approved };
}

exports.sendTripGuideNotification = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const isAdminCaller = await callerIsAdmin(request.auth);
  if (!isAdminCaller) throw new HttpsError('permission-denied', 'Admin access required.');

  const data = request.data || {};
  const title = normalizeString(data.title, MAX_TITLE, 'title');
  const body = normalizeString(data.body, MAX_BODY, 'body');
  const targetType = String(data.targetType || '').trim();
  if (!TARGET_TYPES.has(targetType)) {
    throw new HttpsError('invalid-argument', 'targetType must be one of allActive, adminsOnly, approvedViewers, singleUser.');
  }
  const targetUid = String(data.uid || '').trim();
  if (targetType === 'singleUser' && !targetUid) throw new HttpsError('invalid-argument', 'uid is required for singleUser targetType.');

  const url = normalizeUrl(data.url);
  const now = Date.now();

  const tokensSnap = await db.ref(`${TRACKER_BASE}/pushTokens`).get();
  const rawTokens = tokensSnap.val() || {};

  const needsRoles = targetType === 'adminsOnly' || targetType === 'approvedViewers';
  const roles = needsRoles ? await loadRoleSets() : { admins: new Set(), approved: new Set() };

  const selected = [];
  Object.entries(rawTokens).forEach(([uid, tokenMap]) => {
    const includeUid = (
      targetType === 'allActive' ||
      (targetType === 'singleUser' && uid === targetUid) ||
      (targetType === 'adminsOnly' && roles.admins.has(uid)) ||
      (targetType === 'approvedViewers' && (roles.admins.has(uid) || roles.approved.has(uid)))
    );
    if (!includeUid) return;

    Object.entries(tokenMap || {}).forEach(([tokenId, record]) => {
      if (!isActiveTokenRecord(record, now)) return;
      selected.push({ uid, tokenId, token: String(record.token).trim() });
    });
  });

  if (!selected.length) {
    return {
      attemptedCount: 0,
      successCount: 0,
      failureCount: 0,
      cleanedCount: 0,
      targetType,
      message: 'No active tokens matched the selected target.'
    };
  }

  const sentAt = String(now);
  let successCount = 0;
  let failureCount = 0;
  let cleanedCount = 0;
  const cleanupUpdates = {};

  const batches = toBatches(selected, FCM_BATCH_SIZE);
  for (const batch of batches) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map(item => item.token),
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

  if (cleanedCount > 0) {
    await db.ref(`${TRACKER_BASE}/pushTokens`).update(cleanupUpdates);
  }

  return {
    attemptedCount: selected.length,
    successCount,
    failureCount,
    cleanedCount,
    targetType,
    sentAt,
    url
  };
});
