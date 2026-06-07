#!/usr/bin/env node

const admin = require('firebase-admin');

const TRACKER_BASE = 'tripGuide';
const SITE_URL = 'https://mdnadon112-sketch.github.io/TripGuide/';
const BATCH_SIZE = 500;

function input(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function required(name) {
  const value = input(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function resolveDatabaseUrl(serviceAccount) {
  if (process.env.FIREBASE_DATABASE_URL) return process.env.FIREBASE_DATABASE_URL.trim();
  if (serviceAccount.database_url) return String(serviceAccount.database_url).trim();
  if (serviceAccount.project_id) {
    return `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`;
  }
  throw new Error('Missing Firebase database URL.');
}

function resolveUrl(value) {
  const raw = input('INPUT_URL', value || SITE_URL);
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

async function main() {
  const title = required('INPUT_TITLE');
  const body = required('INPUT_BODY');
  const link = resolveUrl(SITE_URL);

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

  try {
    const db = admin.database();
    const messaging = admin.messaging();

    const snap = await db.ref(`${TRACKER_BASE}/pushTokens`).get();
    const raw = snap.val() || {};

    const tokens = [];

    Object.values(raw).forEach((tokenMap) => {
      Object.values(tokenMap || {}).forEach((record) => {
        if (!record) return;
        if (record.enabled === false) return;
        if (typeof record.token !== 'string') return;

        const token = record.token.trim();
        if (token) tokens.push(token);
      });
    });

    const uniqueTokens = [...new Set(tokens)];

    if (!uniqueTokens.length) {
      console.log('attempted=0 success=0 failure=0');
      console.log('No push tokens found at tripGuide/pushTokens.');
      return;
    }

    let success = 0;
    let failure = 0;

    for (const batch of batches(uniqueTokens, BATCH_SIZE)) {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: {
          title,
          body
        },
        webpush: {
          fcmOptions: {
            link
          },
          notification: {
            title,
            body
          }
        },
        data: {
          type: 'tripGuide',
          title,
          body,
          url: link,
          sentAt: String(Date.now())
        }
      });

      success += response.successCount;
      failure += response.failureCount;

      response.responses.forEach((r, i) => {
        if (!r.success) {
          console.log(`failed token ${i}: ${r.error?.code || 'unknown-error'}`);
        }
      });
    }

    console.log(`attempted=${uniqueTokens.length} success=${success} failure=${failure}`);
  } finally {
    await app.delete();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
