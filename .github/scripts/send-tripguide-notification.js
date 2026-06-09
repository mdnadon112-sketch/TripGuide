#!/usr/bin/env node

const admin = require('firebase-admin');

const TRACKER_BASE = 'tripGuide';
const SITE_URL = 'https://mdnadon112-sketch.github.io/TripGuide/';
const MAX_TOKEN_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;
const TARGET_TYPES = new Set(['allActive', 'adminsOnly', 'approvedViewers', 'singleUser']);
const ADMIN_EMAILS = new Set([
  'mdnadon112@gmail.com',
  'pinnerpatter@gmail.com',
  'mdnadon112@googlemail.com',
  'pinnerpatter@googlemail.com'
].map(canonicalEmail));

function input(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function required(name) {
  const value = input(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function canonicalEmail(email) {
  return String(email || '').trim().toLowerCase().replace(/@googlemail\.com$/, '@gmail.com');
}

function toEpoch(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveDatabaseUrl(serviceAccount) {
  if (process.env.FIREBASE_DATABASE_URL) return process.env.FIREBASE_DATABASE_URL.trim();
  if (serviceAccount.database_url) return String(serviceAccount.database_url).trim();
  if (serviceAccount.project_id) {
    return `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`;
  }
  throw new Error('Missing Firebase database URL.');
}

function resolveUrl(rawInput) {
  const raw = String(rawInput || '/TripGuide/').trim() || '/TripGuide/';
  try {
    return new URL(raw, SITE_URL).href;
  } catch {
    return SITE_URL;
  }
}

function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isActiveTokenRecord(record, now) {
  if (!record || record.enabled !== true) return false;
  const token = String(record.token || '').trim();
  if (!token) return false;
  const lastSeen = toEpoch(record.lastSeen || record.createdAt);
  if (!lastSeen) return true;
  return (now - lastSeen) <= MAX_TOKEN_AGE_MS;
}

function classifySendError(code) {
  const value = String(code || '').toLowerCase();
  if (value.includes('registration-token-not-registered')) return { reason: 'not-registered', disable: true };
  if (value.includes('invalid-registration-token')) return { reason: 'invalid-token', disable: true };
  if (value.includes('mismatch-credential')) return { reason: 'mismatch-credential', disable: false };
  if (value.includes('unavailable')) return { reason: 'temporary-unavailable', disable: false };
  return { reason: value || 'unknown-send-error', disable: false };
}

function buildRoleSets(admins, approvedUsers) {
  const adminUids = new Set();
  const approvedUids = new Set();

  Object.entries(admins || {}).forEach(([uid, record]) => {
    if (record && record.admin === true) adminUids.add(uid);
  });

  Object.entries(approvedUsers || {}).forEach(([uid, record]) => {
    if (record && record.approved === true) approvedUids.add(uid);
    if (record && record.admin === true) adminUids.add(uid);
  });

  return { adminUids, approvedUids };
}

function collectTokenRecords(context, targetType, targetUid) {
  const now = Date.now();
  const dedup = new Map();

  Object.entries(context.pushTokens || {}).forEach(([uid, tokenMap]) => {
    Object.entries(tokenMap || {}).forEach(([tokenId, record]) => {
      if (!isActiveTokenRecord(record, now)) return;

      const token = String(record.token || '').trim();
      if (!token) return;

      const adminByEmail = ADMIN_EMAILS.has(canonicalEmail(record.email));
      const isAdmin = context.roles.adminUids.has(uid) || adminByEmail;
      const isApprovedViewer = context.roles.approvedUids.has(uid);

      let include = false;
      if (targetType === 'allActive') include = true;
      else if (targetType === 'adminsOnly') include = isAdmin;
      else if (targetType === 'approvedViewers') include = isApprovedViewer;
      else if (targetType === 'singleUser') include = uid === targetUid;

      if (!include) return;

      if (!dedup.has(token)) {
        dedup.set(token, { uid, tokenId, token });
      }
    });
  });

  return Array.from(dedup.values());
}

async function main() {
  const title = required('INPUT_TITLE');
  const body = required('INPUT_BODY');
  const targetType = input('INPUT_TARGET_TYPE', 'allActive');
  const uid = input('INPUT_UID');
  const url = resolveUrl(input('INPUT_URL', '/TripGuide/'));

  if (!TARGET_TYPES.has(targetType)) {
    throw new Error('INPUT_TARGET_TYPE must be one of allActive, adminsOnly, approvedViewers, singleUser.');
  }

  if (targetType === 'singleUser' && !uid) {
    throw new Error('INPUT_UID is required when INPUT_TARGET_TYPE=singleUser.');
  }

  const serviceAccountJson = required('FIREBASE_SERVICE_ACCOUNT_JSON');

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }

  const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: resolveDatabaseUrl(serviceAccount)
  });

  const db = admin.database(app);
  const messaging = admin.messaging(app);

    const [pushTokensSnap, adminsSnap, approvedSnap] = await Promise.all([
      db.ref(`${TRACKER_BASE}/pushTokens`).get(),
      db.ref(`${TRACKER_BASE}/admins`).get(),
      db.ref(`${TRACKER_BASE}/approvedUsers`).get()
    ]);

    const context = {
      pushTokens: pushTokensSnap.val() || {},
      roles: buildRoleSets(adminsSnap.val() || {}, approvedSnap.val() || {})
    };

    const tokenRecords = collectTokenRecords(context, targetType, uid);

  if (!tokenRecords.length) {
    console.log('attempted=0 success=0 failure=0 cleaned=0');
    // NUCLEAR_EXIT_AFTER_SUCCESS_SUMMARY
    // Push already sent. Do not wait for Firebase/Admin SDK sockets.
    setTimeout(() => process.exit(0), 500).unref();
    await new Promise(() => process.stdout.write("", () => process.exit(0)));
    return;
  }

  let success = 0;
  let failure = 0;
  let cleaned = 0;
  const cleanupUpdates = {};

  for (const batch of batches(tokenRecords, BATCH_SIZE)) {
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
        title,
        body,
        url
      }
    });

    success += response.successCount;
    failure += response.failureCount;

    response.responses.forEach((result, idx) => {
      if (result.success) return;

      const tokenRecord = batch[idx];
      if (!tokenRecord) return;

      const code = result.error && result.error.code;
      const sendError = classifySendError(code);
      const base = `${tokenRecord.uid}/${tokenRecord.tokenId}`;

      cleanupUpdates[`${base}/lastSendFailureReason`] = sendError.reason;
      cleanupUpdates[`${base}/lastSendFailureAt`] = Date.now();
      cleanupUpdates[`${base}/lastErrorCode`] = String(code || 'unknown-error');

      if (sendError.disable) {
        cleanupUpdates[`${base}/enabled`] = false;
        cleanupUpdates[`${base}/cleanupReason`] = sendError.reason;
        cleanupUpdates[`${base}/cleanupAt`] = Date.now();
        cleaned += 1;
      }
    });
  }

  if (Object.keys(cleanupUpdates).length > 0) {
    await db.ref(`${TRACKER_BASE}/pushTokens`).update(cleanupUpdates);
  }

  console.log(`attempted=${tokenRecords.length} success=${success} failure=${failure} cleaned=${cleaned}`);
}

(async () => {
  try {
    await main();
    process.exitCode = 0;
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  } finally {
    const exitCode = process.exitCode || 0;
    const hardExitTimer = setTimeout(() => {
      process.exit(exitCode);
    }, 400);

    try {
      if (admin.apps && admin.apps.length) {
        await Promise.race([
          Promise.all(admin.apps.map((app) => app.delete())),
          new Promise((resolve) => setTimeout(resolve, 150))
        ]);
      }
    } catch (_) {
      // Best-effort cleanup only; hard exit handles any lingering handles.
    }

    clearTimeout(hardExitTimer);
    process.exit(exitCode);
  }
})();
