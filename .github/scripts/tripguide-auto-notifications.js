#!/usr/bin/env node

const admin = require('firebase-admin');

const TRACKER_BASE = 'tripGuide';
const SITE_URL = 'https://mdnadon112-sketch.github.io/TripGuide/';
const TRIPGUIDE_ORIGIN = 'https://mdnadon112-sketch.github.io';
const TRIPGUIDE_PATH_PREFIX = '/TripGuide';
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
const DEFAULT_DAY_COMPLETE_RADIUS_METERS = 402.336;
const FALLBACK_DAY_COMPLETE_RADIUS_METERS = 804.672;
const INFERRED_DAY_COMPLETE_MAX_LIVE_AGE_MS = 20 * 60 * 1000;
const MAX_ACCURACY_RADIUS_BONUS_METERS = 250;
const COPY_HISTORY_PATH = `${TRACKER_BASE}/notificationCopyHistory`;
const COPY_HISTORY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const COPY_HISTORY_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const SETTINGS_PATH = `${TRACKER_BASE}/settings`;
const SENT_EVENTS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOTAL_NOTIFICATIONS_WINDOW_MS = 60 * 60 * 1000;
const TOTAL_NOTIFICATIONS_LIMIT = 2;
const TRIP_TIMEZONE_OFFSET_HOURS = -5;
const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 7;
const DRY_RUN = process.env.DRY_RUN === 'true';

const EVENT_IMPORTANCE = {
  tripStarted: 'high',
  dayComplete: 'high',
  finalArrival: 'high',
  arrivedAtHotel: 'high',
  accessApproved: 'high',
  accessRemoved: 'high',
  dayStarted: 'medium',
  arrivedAtStop: 'medium',
  liveTrackingStarted: 'medium',
  newMessage: 'medium',
  liveTrackingStopped: 'low',
  foodVoteUpdated: 'low',
  genericTripUpdate: 'low'
};

const EVENT_TYPE_COOLDOWN_MS = {
  liveTrackingStarted: 60 * 60 * 1000,
  liveTrackingStopped: 60 * 60 * 1000,
  dayStarted: 60 * 60 * 1000,
  newMessage: 60 * 60 * 1000,
  arrivedAtStop: 60 * 60 * 1000,
  foodVoteUpdated: 6 * 60 * 60 * 1000,
  genericTripUpdate: 4 * 60 * 60 * 1000
};

const HIGH_PRIORITY_EVENTS = new Set(['tripStarted', 'dayComplete', 'finalArrival', 'arrivedAtHotel', 'accessApproved', 'accessRemoved']);

const DAY_COMPLETION_DESTINATIONS = {
  1: { lat: 33.46895, lng: -86.80249, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'Homewood', state: 'AL', majorCheckpoint: true },
  2: { lat: 34.77358, lng: -92.2644, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'North Little Rock', state: 'AR', majorCheckpoint: true },
  3: { lat: 35.20874, lng: -101.83372, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'Amarillo', state: 'TX', majorCheckpoint: true },
  4: { lat: 36.39319, lng: -105.28514, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'Angel Fire', state: 'NM', majorCheckpoint: true },
  5: { lat: 36.39319, lng: -105.28514, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'Angel Fire', state: 'NM', majorCheckpoint: false },
  6: { lat: 36.39319, lng: -105.28514, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'Angel Fire', state: 'NM', majorCheckpoint: false },
  7: { lat: 35.20062, lng: -111.61266, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'Flagstaff', state: 'AZ', majorCheckpoint: true },
  8: { lat: 34.89452, lng: -117.02282, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'Barstow', state: 'CA', majorCheckpoint: true },
  9: { lat: 33.73904, lng: -118.10336, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS, city: 'Seal Beach', state: 'CA', majorCheckpoint: true }
};

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function resolveDatabaseUrl(serviceAccount) {
  const fromEnv = String(process.env.FIREBASE_DATABASE_URL || '').trim();
  if (fromEnv) return fromEnv;
  const fromServiceAccount = String(serviceAccount.databaseURL || '').trim();
  if (fromServiceAccount) return fromServiceAccount;
  const projectId = String(serviceAccount.project_id || '').trim();
  if (!projectId) throw new Error('Could not resolve Firebase database URL. Set FIREBASE_DATABASE_URL secret.');
  return `https://${projectId}-default-rtdb.firebaseio.com`;
}

function normalizeTripGuideUrl(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return SITE_URL;
  try {
    const parsed = new URL(raw, SITE_URL);
    if (parsed.origin !== TRIPGUIDE_ORIGIN) return SITE_URL;
    if (!String(parsed.pathname || '').startsWith(TRIPGUIDE_PATH_PREFIX)) return SITE_URL;
    return parsed.href;
  } catch {
    return SITE_URL;
  }
}

function cleanText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toEpoch(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return false;
}

function normalizeName(value, fallback = '') {
  return cleanText(value, fallback).replace(/\s+/g, ' ').slice(0, 80);
}

function normalizeMessagePreview(value) {
  return cleanText(value, '').replace(/\s+/g, ' ').slice(0, 120);
}

function canonicalEmail(value) {
  return String(value || '').trim().toLowerCase().replace(/@googlemail\.com$/, '@gmail.com');
}

function classifySendError(code) {
  const value = String(code || '');
  if (value.includes('registration-token-not-registered')) return { reason: 'not-registered', disable: true };
  if (value.includes('invalid-registration-token')) return { reason: 'invalid-token', disable: true };
  return { reason: 'send-failed', disable: false };
}

function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function extractLatLng(record) {
  if (!record || typeof record !== 'object') return null;
  const lat = toNumber(record.lat ?? record.latitude ?? record.locationLat ?? record.locationLatitude);
  const lng = toNumber(record.lng ?? record.lon ?? record.long ?? record.longitude ?? record.locationLng ?? record.locationLongitude);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function normalizeDestinationMap(raw) {
  const output = {};
  const source = raw && typeof raw === 'object' ? (raw.days && typeof raw.days === 'object' ? raw.days : raw) : {};

  Object.entries(source).forEach(([key, value]) => {
    const day = Number(key || 0);
    if (!(day >= 1 && day <= 99)) return;
    if (!value || typeof value !== 'object') return;

    const latLng = extractLatLng(value);
    if (!latLng) return;

    const radiusMeters = toNumber(value.radiusMeters);
    output[String(day)] = {
      lat: latLng.lat,
      lng: latLng.lng,
      radiusMeters: radiusMeters && radiusMeters > 0 ? radiusMeters : undefined,
      weakPrecision: toBoolean(value.weakPrecision),
      city: cleanText(value.city || value.town || value.locality),
      state: cleanText(value.state || value.region || value.stateCode),
      placeName: cleanText(value.placeName || value.name || value.hotelName),
      majorCheckpoint: toBoolean(value.majorCheckpoint || value.isMajorCheckpoint)
    };
  });

  return output;
}

function mergeDestinationMaps(defaults, primaryOverrides, secondaryOverrides) {
  const merged = {};
  const keys = new Set([
    ...Object.keys(defaults || {}),
    ...Object.keys(primaryOverrides || {}),
    ...Object.keys(secondaryOverrides || {})
  ]);

  keys.forEach((key) => {
    merged[String(key)] = Object.assign(
      {},
      defaults && defaults[key] ? defaults[key] : {},
      secondaryOverrides && secondaryOverrides[key] ? secondaryOverrides[key] : {},
      primaryOverrides && primaryOverrides[key] ? primaryOverrides[key] : {}
    );
  });

  return merged;
}

function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const p = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(p)));
}

function latestLiveCoordinate(live, liveTrackers) {
  const candidates = [];
  const liveCoord = extractLatLng(live);
  if (liveCoord) {
    candidates.push({
      coord: liveCoord,
      updatedAt: toEpoch(live.lastUpdated || live.updatedAt || live.lastSeen || live.timestamp || live.sentAt),
      trackingActive: toBoolean(live.trackingActive),
      accuracy: toNumber(live.accuracy) || 0
    });
  }

  Object.values(liveTrackers || {}).forEach((record) => {
    const coord = extractLatLng(record);
    if (!coord) return;
    const trackingActive = toBoolean(record.trackingActive);
    const updatedAt = toEpoch(record.lastUpdated || record.updatedAt || record.lastSeen || record.timestamp || record.sentAt);
    if (!trackingActive && updatedAt === 0) return;
    candidates.push({ coord, updatedAt, trackingActive, accuracy: toNumber(record.accuracy) || 0 });
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.trackingActive !== b.trackingActive) return a.trackingActive ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  return candidates[0];
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

function resolveActiveDay(live) {
  const candidates = [
    live && live.activeDay,
    live && live.progress && live.progress.activeDay,
    live && live.tripProgress && live.tripProgress.activeDay,
    live && live.computedDay
  ];

  for (const value of candidates) {
    const day = Number(value || 0);
    if (day >= 1 && day <= 99) return day;
  }
  return 0;
}

function inferDayCompletionFromLocation(live, liveTrackers, activeDay, options = {}) {
  if (!(activeDay >= 1)) return 0;
  const destinationMap = options.destinationMap || DAY_COMPLETION_DESTINATIONS;
  const destination = destinationMap[String(activeDay)] || destinationMap[activeDay];
  if (!destination) return 0;
  if (!toBoolean(live.trackingActive)) return 0;

  const latestLiveAt = toEpoch(options.latestLiveAt);
  if (latestLiveAt > 0 && (Date.now() - latestLiveAt) > INFERRED_DAY_COMPLETE_MAX_LIVE_AGE_MS) return 0;

  const latest = latestLiveCoordinate(live, liveTrackers);
  if (!latest || !latest.coord) return 0;

  let radiusMeters = Number.isFinite(Number(destination.radiusMeters))
    ? Number(destination.radiusMeters)
    : FALLBACK_DAY_COMPLETE_RADIUS_METERS;
  if (toBoolean(destination.weakPrecision)) radiusMeters = Math.max(radiusMeters, FALLBACK_DAY_COMPLETE_RADIUS_METERS);

  const accuracyBonus = Math.max(0, Math.min(MAX_ACCURACY_RADIUS_BONUS_METERS, Number(latest.accuracy || 0)));
  const effectiveRadiusMeters = radiusMeters + accuracyBonus;
  return haversineMeters(latest.coord, destination) <= effectiveRadiusMeters ? activeDay : 0;
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
    if (record && record.blocked === true) blockedUids.add(uid);
  });

  adminUids.forEach((uid) => approvedUids.add(uid));

  Object.entries(blockedUsers || {}).forEach(([uid, record]) => {
    if (isBlockedRecord(record)) blockedUids.add(uid);
  });

  return { adminUids, approvedUids, blockedUids };
}

function isTokenActive(record, now) {
  if (!record) return false;
  if (record.enabled === false) return false;
  if (typeof record.token !== 'string' || !record.token.trim()) return false;
  const lastSeen = toEpoch(record.lastSeen || record.createdAt);
  if (!lastSeen) return true;
  return now - lastSeen <= MAX_TOKEN_AGE_MS;
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
      if (target === 'admins') include = adminByUid || adminByEmail;
      else if (target === 'all') include = adminByUid || approvedByUid;
      else if (target === 'singleUser') include = uid === targetUid && (allowUnapprovedSingleUser || adminByUid || approvedByUid);

      if (!include) return;
      if (!dedup.has(token)) dedup.set(token, { uid, tokenId, token });
    });
  });

  return Array.from(dedup.values());
}

function getEventImportance(eventType) {
  return EVENT_IMPORTANCE[String(eventType || '')] || 'low';
}

function buildEventKey(eventType, context) {
  const day = Number((context && (context.day || context.activeDay || context.completedDay)) || 0);
  const city = cleanText(
    context && (context.city || (context.destination && context.destination.city) || context.placeName || '')
  ).slice(0, 20).toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/, '');
  const milestone = day > 0 ? `d${day}` : '';
  const parts = [String(eventType || 'unknown'), milestone, city].filter(Boolean);
  return parts.join('_').slice(0, 100);
}

function isInQuietHours(now) {
  const localMs = now + TRIP_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
  const hour = new Date(localMs).getUTCHours();
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

function shouldSkipForQuietHours(eventType, now) {
  if (HIGH_PRIORITY_EVENTS.has(eventType)) return false;
  return isInQuietHours(now);
}

function pruneOldSentEvents(sentEvents, now) {
  const pruned = {};
  Object.entries(sentEvents || {}).forEach(([key, ts]) => {
    if (toEpoch(ts) >= now - SENT_EVENTS_TTL_MS) pruned[key] = ts;
  });
  return pruned;
}

function isCreatedAtIndexError(err) {
  const text = String((err && (err.message || err.code)) || err || '');
  return /index not defined|\.indexOn|createdAt/i.test(text);
}

async function readRecentMessagesSnapshot(db) {
  try {
    return await db.ref(`${TRACKER_BASE}/messages`).orderByChild('createdAt').limitToLast(25).get();
  } catch (err) {
    if (isCreatedAtIndexError(err)) {
      throw new Error("Firebase rules need .indexOn ['createdAt'] under /tripGuide/messages.");
    }
    throw err;
  }
}

function pickFirstText(candidates = []) {
  for (const value of candidates) {
    const text = cleanText(value);
    if (text) return text;
  }
  return '';
}

function normalizeStateAbbrev(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  if (raw.length <= 3) return raw.toUpperCase();
  return raw;
}

function formatCityState(context = {}) {
  const entries = [
    { city: context.city, state: context.state },
    { city: context.stop && context.stop.city, state: context.stop && context.stop.state },
    { city: context.destination && context.destination.city, state: context.destination && context.destination.state },
    { city: context.hotel && context.hotel.city, state: context.hotel && context.hotel.state },
    { city: context.route && context.route.city, state: context.route && context.route.state },
    { city: context.arrival && context.arrival.city, state: context.arrival && context.arrival.state },
    { city: context.place && context.place.city, state: context.place && context.place.state }
  ];

  for (const entry of entries) {
    const city = cleanText(entry && entry.city);
    const state = normalizeStateAbbrev(entry && entry.state);
    if (city && state) return `${city}, ${state}`;
    if (city) return city;
  }

  return pickFirstText([
    context.placeName,
    context.stop && context.stop.name,
    context.hotelName,
    context.hotel && context.hotel.name,
    context.destination && context.destination.placeName,
    context.destination && context.destination.name,
    context.route && context.route.placeName
  ]);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function calculateTripCompletionPercent(context = {}) {
  const majorCompleted = toNumber(
    context.completedMajorStopIndex ??
    context.majorStopCompletedIndex ??
    context.progressMajorStopIndex ??
    (context.progress && context.progress.completedMajorStopIndex)
  );
  const majorTotal = toNumber(
    context.totalMajorStops ??
    context.majorStopTotal ??
    context.progressMajorStopTotal ??
    (context.progress && context.progress.totalMajorStops)
  );

  if (majorCompleted !== null && majorTotal !== null && majorTotal > 0) {
    return clampPercent((majorCompleted / majorTotal) * 100);
  }

  const completedDay = toNumber(
    context.completedDayIndex ??
    context.completedDay ??
    context.day ??
    context.activeDay ??
    (context.progress && context.progress.completedDayIndex)
  );
  const totalDays = toNumber(
    context.totalDays ??
    context.tripDaysTotal ??
    context.totalTripDays ??
    (context.progress && context.progress.totalDays)
  );

  if (completedDay !== null && totalDays !== null && totalDays > 0) {
    return clampPercent((completedDay / totalDays) * 100);
  }

  const milesCompleted = toNumber(
    context.completedRouteMiles ??
    context.routeMilesCompleted ??
    (context.progress && context.progress.completedRouteMiles)
  );
  const milesTotal = toNumber(
    context.totalRouteMiles ??
    context.routeMilesTotal ??
    (context.progress && context.progress.totalRouteMiles)
  );

  if (milesCompleted !== null && milesTotal !== null && milesTotal > 0) {
    return clampPercent((milesCompleted / milesTotal) * 100);
  }

  return null;
}

function buildPercentSuffix(percent) {
  if (!(percent >= 0 && percent <= 100)) return '';
  if (Math.abs(percent - 50) <= 3) return 'Roughly halfway.';
  const templates = [
    `About ${percent}% done.`,
    `Roughly ${percent}% of the trip down.`,
    `That puts us around ${percent}% done.`,
    `Trip is about ${percent}% complete.`
  ];
  return templates[percent % templates.length];
}

function shouldIncludeTripPercent(eventType, context, recentHistory, percent) {
  if (!(percent >= 0 && percent <= 100)) return false;
  if (eventType === 'finalArrival') return true;

  const allowed = new Set(['dayComplete', 'arrivedAtHotel', 'arrivedAtStop']);
  if (!allowed.has(eventType)) return false;
  if (eventType === 'arrivedAtStop' && context.isMajorCheckpoint !== true) return false;

  const sorted = (recentHistory || []).slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const recentPercentIndex = sorted.findIndex((item) => /\b\d{1,3}%\b/.test(String(item && item.body || '')) || /halfway/i.test(String(item && item.body || '')));
  if (recentPercentIndex !== -1 && recentPercentIndex < 2) return false;

  if (eventType === 'dayComplete') return true;
  if (eventType === 'arrivedAtHotel') {
    const priorHotels = sorted.filter((item) => item && item.eventType === 'arrivedAtHotel').length;
    return priorHotels % 2 === 0;
  }
  return true;
}

function copyWithFallback(text, fallback) {
  const value = cleanText(text);
  return value || fallback;
}

function getCopyPools(eventType, context = {}) {
  const day = Number(context.day || context.activeDay || 0);
  const place = formatCityState(context);
  const percent = calculateTripCompletionPercent(context);
  const includePercent = shouldIncludeTripPercent(eventType, context, context.recentHistory || [], percent);
  const percentSuffix = includePercent ? buildPercentSuffix(percent) : '';
  const withPercent = (base) => {
    const first = cleanText(base);
    if (!first) return '';
    if (!percentSuffix) return first;
    return `${first} ${percentSuffix}`.trim();
  };

  const madeItBody = place
    ? `We made it to ${place}.`
    : 'Made it. Finally.';

  if (eventType === 'tripStarted') {
    return {
      target: 'all',
      options: [
        { title: 'We\'re Rolling', body: 'We\'re on the road.' },
        { title: 'Trip Started', body: 'We\'re moving. Finally.' },
        { title: 'We\'re Out', body: 'Trip started. Here we go.' }
      ]
    };
  }

  if (eventType === 'dayStarted') {
    return {
      target: 'all',
      options: [
        { title: day > 0 ? `Day ${day}` : 'Back At It', body: 'We\'re back on the road.' },
        { title: 'Back At It', body: day > 0 ? `Day ${day}. Still driving.` : 'Still driving.' },
        { title: 'Rolling Again', body: 'We\'re moving again.' }
      ]
    };
  }

  if (eventType === 'arrivedAtStop') {
    return {
      target: 'all',
      options: [
        { title: 'Made It', body: withPercent(madeItBody) },
        { title: 'Stop Reached', body: place ? withPercent(`Stopped at ${place}.`) : withPercent('Checkpoint hit. Moving again soon.') },
        { title: 'We\'re Here', body: withPercent(place ? `Checkpoint hit in ${place}. Moving again soon.` : 'Checkpoint hit. Moving again soon.') }
      ]
    };
  }

  if (eventType === 'arrivedAtHotel') {
    return {
      target: 'all',
      options: [
        { title: 'Hotel Secured', body: withPercent(place ? `We made it to ${place}. Done for now.` : 'Hotel secured. We\'re cooked.') },
        { title: 'We\'re In', body: withPercent(place ? `Hotel secured in ${place}. We\'re cooked.` : 'We\'re in for the night.') },
        { title: 'Parked', body: withPercent(place ? `Parked in ${place}. Not moving for a bit.` : 'Parked. Done.') }
      ]
    };
  }

  if (eventType === 'dayComplete') {
    const localDay = day > 0 ? day : 1;
    return {
      target: 'all',
      options: [
        { title: `Day ${localDay} Done`, body: place ? `${place}. That\'s enough driving for today.` : withPercent(`Day ${localDay} is done.`) },
        { title: 'Done Driving', body: withPercent('That\'s enough driving for today.') },
        { title: 'That\'s Enough', body: withPercent('We\'re done driving for the night.') }
      ]
    };
  }

  if (eventType === 'finalArrival') {
    const placeBody = place ? `Final stop reached in ${place}. Done.` : 'We made it. Trip complete.';
    return {
      target: 'all',
      options: [
        { title: 'Trip Complete', body: withPercent(placeBody) },
        { title: 'We Made It', body: withPercent('We made it. Trip complete.') },
        { title: 'Final Stop', body: withPercent(placeBody) }
      ]
    };
  }

  if (eventType === 'liveTrackingStarted') {
    return {
      target: 'all',
      options: [
        { title: 'Location Is Live', body: 'You can follow us now.' },
        { title: 'Map Is Live', body: 'Map is live if you\'re checking on us.' },
        { title: 'Tracking Is On', body: 'Location is on.' }
      ]
    };
  }

  if (eventType === 'liveTrackingStopped') {
    return {
      target: 'all',
      options: [
        { title: 'Tracking Paused', body: 'Location is paused for now.' },
        { title: 'Map Paused', body: 'Map is off for a bit.' },
        { title: 'Location Off', body: 'Tracking is paused.' }
      ]
    };
  }

  if (eventType === 'newMessage') {
    return {
      target: 'all',
      options: [
        { title: 'New Update', body: 'New update from us.' },
        { title: 'New Message', body: 'We posted something new.' },
        { title: 'Update Posted', body: 'Check the latest update.' }
      ]
    };
  }

  if (eventType === 'foodVoteUpdated') {
    return {
      target: 'all',
      options: [
        { title: 'Food Update', body: 'Food plans changed.' },
        { title: 'Food Vote', body: 'Someone has food opinions.' },
        { title: 'Food Changed', body: 'Food vote updated.' }
      ]
    };
  }

  if (eventType === 'accessApproved') {
    return {
      target: 'singleUser',
      options: [
        { title: 'You\'re In', body: 'Your access to Mike and Lauren\'s TripGuide is approved.' }
      ]
    };
  }

  if (eventType === 'accessRemoved') {
    return {
      target: 'singleUser',
      options: [
        { title: 'Access Updated', body: context.blocked === true ? 'You cannot view this trip right now.' : 'Your TripGuide access has been updated.' }
      ]
    };
  }

  return {
    target: 'all',
    options: [
      { title: 'Trip Update', body: 'New trip update.' },
      { title: 'Quick Update', body: 'Quick update from us.' },
      { title: 'Update', body: 'Check the TripGuide.' }
    ]
  };
}

function makeCopyKey(eventType, title, body) {
  return `${eventType}|${title}|${body}`;
}

function chooseCopyOption(eventType, pool, recentHistory = []) {
  const candidates = (pool.options || []).map((opt) => {
    const title = copyWithFallback(opt.title, 'Trip Update').slice(0, 80);
    const body = copyWithFallback(opt.body, 'New trip update.').slice(0, 240);
    return { title, body, copyKey: makeCopyKey(eventType, title, body) };
  });

  if (!candidates.length) {
    const fallback = { title: 'Trip Update', body: 'New trip update.' };
    return { title: fallback.title, body: fallback.body, copyKey: makeCopyKey(eventType, fallback.title, fallback.body) };
  }

  const byKey = new Map();
  recentHistory.forEach((entry) => {
    if (!entry || entry.eventType !== eventType) return;
    const key = cleanText(entry.copyKey);
    if (!key) return;
    const createdAt = toEpoch(entry.createdAt);
    const prev = byKey.get(key);
    if (!prev || createdAt < prev.firstUsedAt) {
      byKey.set(key, { firstUsedAt: createdAt || Date.now() });
    }
  });

  const unused = candidates.filter((entry) => !byKey.has(entry.copyKey));
  if (unused.length) {
    const idx = Date.now() % unused.length;
    return unused[idx];
  }

  const ranked = candidates
    .map((entry) => ({
      entry,
      firstUsedAt: byKey.has(entry.copyKey) ? byKey.get(entry.copyKey).firstUsedAt : Number.MAX_SAFE_INTEGER
    }))
    .sort((a, b) => a.firstUsedAt - b.firstUsedAt);

  return ranked[0].entry;
}

function buildTripNotificationCopy(eventType, context = {}) {
  const pool = getCopyPools(eventType, context);
  const selected = chooseCopyOption(eventType, pool, context.recentHistory || []);
  return {
    title: selected.title,
    body: selected.body,
    copyKey: selected.copyKey,
    target: pool.target || context.target || 'all',
    url: normalizeTripGuideUrl(context.url || SITE_URL)
  };
}

function buildCopyHistoryRecord(eventType, copy, now) {
  return {
    eventType,
    title: copy.title,
    body: copy.body,
    copyKey: copy.copyKey,
    createdAt: now
  };
}

async function loadCopyHistory(db, now) {
  const earliestKeep = now - COPY_HISTORY_RETENTION_MS;
  let raw = {};

  try {
    const snap = await db.ref(COPY_HISTORY_PATH).orderByChild('createdAt').startAt(earliestKeep).get();
    raw = snap.val() || {};
  } catch (_) {
    const snap = await db.ref(COPY_HISTORY_PATH).get();
    raw = snap.val() || {};
  }

  const all = [];
  const cleanup = {};
  Object.entries(raw || {}).forEach(([key, value]) => {
    const record = value && typeof value === 'object' ? value : {};
    const createdAt = toEpoch(record.createdAt);
    const eventType = cleanText(record.eventType);
    const title = cleanText(record.title);
    const body = cleanText(record.body);
    const copyKey = cleanText(record.copyKey) || (eventType && title && body ? makeCopyKey(eventType, title, body) : '');

    if (!createdAt || createdAt < earliestKeep || !eventType || !title || !body || !copyKey) {
      cleanup[key] = null;
      return;
    }

    all.push({ key, eventType, title, body, copyKey, createdAt });
  });

  const recent = all.filter((entry) => entry.createdAt >= now - COPY_HISTORY_LOOKBACK_MS);
  recent.sort((a, b) => b.createdAt - a.createdAt);

  return { recent, cleanup };
}

async function sendPush(context, messaging, copy, options = {}) {
  const target = copy.target;
  const title = copy.title;
  const body = copy.body;
  const url = normalizeTripGuideUrl(copy.url || SITE_URL);

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
    const sentAt = Date.now();
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map((entry) => entry.token),
      notification: { title, body },
      webpush: {
        fcmOptions: { link: url },
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
        sentAt: String(sentAt)
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
      cleanupUpdates[`${item.uid}/${item.tokenId}/lastSendFailureAt`] = sentAt;
      cleanupUpdates[`${item.uid}/${item.tokenId}/lastErrorCode`] = String(code || 'unknown-error');

      if (sendError.disable) {
        cleanupUpdates[`${item.uid}/${item.tokenId}/enabled`] = false;
        cleanupUpdates[`${item.uid}/${item.tokenId}/cleanupReason`] = sendError.reason;
        cleanupUpdates[`${item.uid}/${item.tokenId}/cleanupAt`] = sentAt;
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

async function sendAutoEvent(context, messaging, eventType, copyContext = {}, options = {}) {
  const now = Date.now();
  const importance = getEventImportance(eventType);
  const isHigh = HIGH_PRIORITY_EVENTS.has(eventType);

  // --- eventKey idempotency ---
  const eventKey = buildEventKey(eventType, copyContext);
  if (context.sentEvents && context.sentEvents[eventKey]) {
    console.log(`skip eventType=${eventType} eventKey=${eventKey} reason=already-sent`);
    return { attempted: 0, success: 0, failure: 0, cleaned: 0, skipped: true };
  }

  // --- quiet hours (skip low/medium, high always sends) ---
  if (shouldSkipForQuietHours(eventType, now)) {
    console.log(`skip eventType=${eventType} eventKey=${eventKey} importance=${importance} reason=quiet-hours`);
    return { attempted: 0, success: 0, failure: 0, cleaned: 0, skipped: true };
  }

  // --- event-type cooldown ---
  const typeCooldown = EVENT_TYPE_COOLDOWN_MS[eventType];
  if (typeCooldown && !isHigh) {
    const lastSentForType = toEpoch(context.lastSentByType && context.lastSentByType[eventType]);
    if (lastSentForType > 0 && (now - lastSentForType) < typeCooldown) {
      console.log(`skip eventType=${eventType} eventKey=${eventKey} reason=type-cooldown`);
      return { attempted: 0, success: 0, failure: 0, cleaned: 0, skipped: true };
    }
  }

  // --- total rate limit (non-high events only) ---
  if (!isHigh) {
    const windowStart = toEpoch(context.notificationWindow && context.notificationWindow.windowStart);
    const windowCount = Number((context.notificationWindow && context.notificationWindow.count) || 0);
    const inWindow = windowStart > 0 && (now - windowStart) < TOTAL_NOTIFICATIONS_WINDOW_MS;
    if (inWindow && windowCount >= TOTAL_NOTIFICATIONS_LIMIT) {
      console.log(`skip eventType=${eventType} eventKey=${eventKey} reason=rate-limit count=${windowCount}/${TOTAL_NOTIFICATIONS_LIMIT}`);
      return { attempted: 0, success: 0, failure: 0, cleaned: 0, skipped: true };
    }
  }

  // --- build copy ---
  let copy;
  try {
    copy = buildTripNotificationCopy(eventType, {
      ...copyContext,
      recentHistory: context.copyHistoryRecent
    });
  } catch (_) {
    copy = { title: 'Trip Update', body: 'New update from us.', target: 'all', copyKey: `${eventType}|fallback`, url: SITE_URL };
  }
  if (options.target) copy.target = options.target;

  // --- dry run ---
  if (DRY_RUN) {
    console.log(`dry-run eventType=${eventType} eventKey=${eventKey} importance=${importance} title="${copy.title}" body="${copy.body}" target=${copy.target}`);
    return { attempted: 0, success: 0, failure: 0, cleaned: 0, skipped: true };
  }

  const result = await sendPush(context, messaging, copy, options);

  if (result.attempted > 0) {
    // Record eventKey
    if (!context.newSentEvents) context.newSentEvents = {};
    context.newSentEvents[eventKey] = now;

    // Update last-sent-by-type
    if (!context.lastSentByType) context.lastSentByType = {};
    context.lastSentByType[eventType] = now;
    context.updatedLastSentByType = true;

    // Update notification window count
    const windowStart = toEpoch(context.notificationWindow && context.notificationWindow.windowStart);
    const inWindow = windowStart > 0 && (now - windowStart) < TOTAL_NOTIFICATIONS_WINDOW_MS;
    if (inWindow) {
      context.notificationWindow = { windowStart, count: Number(context.notificationWindow.count || 0) + 1 };
    } else {
      context.notificationWindow = { windowStart: now, count: 1 };
    }
    context.updatedNotificationWindow = true;

    // Record copy history (non-fatal)
    try {
      const key = context.db.ref(COPY_HISTORY_PATH).push().key;
      if (key) {
        context.copyHistoryUpdates[key] = buildCopyHistoryRecord(eventType, copy, now);
        context.copyHistoryRecent.unshift({
          key, eventType, title: copy.title, body: copy.body, copyKey: copy.copyKey, createdAt: now
        });
      }
    } catch (_) { /* copy history is non-fatal */ }
  }
  return result;
}

function buildLocationContextFromDay(day, destinationMap, live = {}) {
  const destination = destinationMap[String(day)] || destinationMap[day] || {};
  const stop = live.stop || (live.progress && live.progress.stop) || {};
  const hotel = live.hotel || (live.progress && live.progress.hotel) || {};

  return {
    day,
    activeDay: day,
    totalDays: Object.keys(destinationMap || {}).length || null,
    destination: {
      city: cleanText(destination.city),
      state: cleanText(destination.state),
      placeName: cleanText(destination.placeName),
      name: cleanText(destination.name)
    },
    stop: {
      city: cleanText(stop.city),
      state: cleanText(stop.state),
      name: cleanText(stop.name)
    },
    hotel: {
      city: cleanText(hotel.city),
      state: cleanText(hotel.state),
      name: cleanText(hotel.name)
    },
    placeName: pickFirstText([
      live.placeName,
      live.locationName,
      destination.placeName,
      destination.name,
      stop.name,
      hotel.name
    ]),
    isMajorCheckpoint: toBoolean(destination.majorCheckpoint)
  };
}

async function main() {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(required('FIREBASE_SERVICE_ACCOUNT_JSON'));
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }

  let app;
  try {
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: resolveDatabaseUrl(serviceAccount)
    });

    const db = admin.database(app);
    const messaging = admin.messaging(app);

    const pushTokensSnap = await db.ref(`${TRACKER_BASE}/pushTokens`).get();
    const pushTokens = pushTokensSnap.val() || {};
    if (!Object.keys(pushTokens).length) {
      console.log('No push tokens.');
      return;
    }

    // Emergency off switch
    const settingsSnap = await db.ref(SETTINGS_PATH).get();
    const settings = settingsSnap.val() || {};
    if (toBoolean(settings.autoNotificationsEnabled) === false) {
      console.log('Auto-notifications disabled via settings. Exiting.');
      return;
    }

    const now = Date.now();
    const [copyHistoryResult,
      liveSnap,
      liveTrackersSnap,
      messagesSnap,
      requestsSnap,
      adminsSnap,
      approvedSnap,
      blockedSnap,
      stateSnap,
      dayDestinationsSnap,
      tripConfigDayDestinationsSnap] = await Promise.all([
      loadCopyHistory(db, now).catch(() => ({ recent: [], cleanup: {} })),
      db.ref(`${TRACKER_BASE}/live`).get(),
      db.ref(`${TRACKER_BASE}/liveTrackers`).get(),
      readRecentMessagesSnapshot(db),
      db.ref(`${TRACKER_BASE}/accessRequests`).get(),
      db.ref(`${TRACKER_BASE}/admins`).get(),
      db.ref(`${TRACKER_BASE}/approvedUsers`).get(),
      db.ref(`${TRACKER_BASE}/blockedUsers`).get(),
      db.ref(`${TRACKER_BASE}/notificationState`).get(),
      db.ref(`${TRACKER_BASE}/dayCompletionDestinations`).get(),
      db.ref(`${TRACKER_BASE}/tripConfig/dayCompletionDestinations`).get()
    ]);
    const { recent: copyHistoryRecent, cleanup: copyHistoryCleanup } = copyHistoryResult;

    const live = liveSnap.val() || {};
    const liveTrackers = liveTrackersSnap.val() || {};
    const messages = messagesSnap.val() || {};
    const requests = requestsSnap.val() || {};
    const admins = adminsSnap.val() || {};
    const approvedUsers = approvedSnap.val() || {};
    const blockedUsers = blockedSnap.val() || {};
    const state = stateSnap.val() || {};

    // Load sentEvents for idempotency and prune old ones
    const rawSentEvents = state.sentEvents || {};
    const sentEvents = pruneOldSentEvents(rawSentEvents, now);
    const prunedSentEventKeys = Object.keys(rawSentEvents).filter((k) => !sentEvents[k]);

    const dayDestinationOverrides = normalizeDestinationMap(dayDestinationsSnap.val() || {});
    const tripConfigDestinationOverrides = normalizeDestinationMap(tripConfigDayDestinationsSnap.val() || {});
    const destinationMap = mergeDestinationMaps(DAY_COMPLETION_DESTINATIONS, dayDestinationOverrides, tripConfigDestinationOverrides);

    const context = {
      db,
      pushTokens,
      admins,
      approvedUsers,
      blockedUsers,
      roles: buildRoleSets(admins, approvedUsers, blockedUsers),
      copyHistoryRecent,
      copyHistoryUpdates: {},
      copyHistoryCleanup,
      sentEvents,
      newSentEvents: {},
      lastSentByType: Object.assign({}, state.lastSentByType || {}),
      updatedLastSentByType: false,
      notificationWindow: Object.assign({}, state.notificationWindow || {}),
      updatedNotificationWindow: false
    };

    const updates = {};
    let changed = false;

    const trackingActive = toBoolean(live.trackingActive);
    const previousTrackingActive = toBoolean(state.trackingActive);
    if (trackingActive !== previousTrackingActive) {
      if (trackingActive) {
        const firstStartSent = toBoolean(state.tripStartedNoticeSent);
        const eventType = firstStartSent ? 'liveTrackingStarted' : 'tripStarted';
        await sendAutoEvent(context, messaging, eventType, {
          activeDay: resolveActiveDay(live),
          totalDays: Object.keys(destinationMap || {}).length || null
        });
        updates.tripStartedNoticeSent = true;
      } else if (state.trackingActiveSeenOnce === true) {
        await sendAutoEvent(context, messaging, 'liveTrackingStopped', {});
      }
      updates.trackingActive = trackingActive;
      updates.trackingActiveSeenOnce = true;
      updates.trackingActiveChangedAt = now;
      changed = true;
    }

    const activeDay = resolveActiveDay(live);
    const previousActiveDay = Number(state.activeDay || 0);
    if (activeDay >= 1 && activeDay !== previousActiveDay) {
      await sendAutoEvent(context, messaging, 'dayStarted', buildLocationContextFromDay(activeDay, destinationMap, live));
      updates.activeDay = activeDay;
      updates.activeDayChangedAt = now;
      changed = true;
    }

    const dayCompleted = Object.assign({}, state.dayCompleted || {});
    const dayCompletedAt = Object.assign({}, state.dayCompletedAt || {});
    const explicitDayComplete = Number(live.dayComplete || 0);
    let completedDay = 0;
    let completedDayAt = toEpoch(live.dayCompleteAt || now);

    if (explicitDayComplete >= 1) {
      completedDay = explicitDayComplete;
      completedDayAt = toEpoch(live.dayCompleteAt || live.lastUpdated || live.updatedAt || now);
    } else {
      completedDay = inferDayCompletionFromLocation(live, liveTrackers, activeDay, {
        destinationMap,
        latestLiveAt: newestLiveTimestamp(live, liveTrackers)
      });
      completedDayAt = now;
    }

    if (completedDay >= 1 && !toBoolean(dayCompleted[String(completedDay)])) {
      const dayContext = buildLocationContextFromDay(completedDay, destinationMap, live);
      dayContext.completedDay = completedDay;
      if (completedDay === 9) {
        await sendAutoEvent(context, messaging, 'finalArrival', dayContext);
        updates.tripComplete = true;
        updates.tripCompleteAt = now;
      } else {
        await sendAutoEvent(context, messaging, 'dayComplete', dayContext);
      }
      dayCompleted[String(completedDay)] = true;
      dayCompletedAt[String(completedDay)] = completedDayAt || now;
      changed = true;
    }

    const tripComplete = toBoolean(live.tripComplete);
    if (tripComplete && activeDay >= 1 && !toBoolean(state.tripComplete) && !toBoolean(dayCompleted[String(activeDay)])) {
      const finalDay = activeDay;
      const finalContext = buildLocationContextFromDay(finalDay, destinationMap, live);
      finalContext.completedDay = finalDay;
      await sendAutoEvent(context, messaging, 'finalArrival', finalContext);
      updates.tripComplete = true;
      updates.tripCompleteAt = now;
      dayCompleted[String(finalDay)] = true;
      dayCompletedAt[String(finalDay)] = now;
      changed = true;
    }

    let newestMessage = null;
    Object.entries(messages).forEach(([id, msg]) => {
      const createdAt = toEpoch(msg && msg.createdAt);
      if (!createdAt) return;
      if (!newestMessage || createdAt > newestMessage.createdAt) {
        newestMessage = {
          id,
          createdAt,
          name: normalizeName(msg && (msg.name || msg.displayName), 'Someone'),
          text: normalizeMessagePreview(msg && (msg.text || msg.message))
        };
      }
    });

    if (newestMessage && newestMessage.id !== state.lastMessageId && newestMessage.createdAt > toEpoch(state.lastMessageAt)) {
      await sendAutoEvent(context, messaging, 'newMessage', { message: newestMessage.text, name: newestMessage.name });
      updates.lastMessageId = newestMessage.id;
      updates.lastMessageAt = newestMessage.createdAt;
      changed = true;
    }

    const approvalNotices = Object.assign({}, state.approvalNotices || {});
    const removalNotices = Object.assign({}, state.removalNotices || {});

    for (const [uid, record] of Object.entries(approvedUsers || {})) {
      const approved = !!(record && (record.approved === true || record.admin === true));
      if (!approved || approvalNotices[uid]) continue;
      if (context.roles.blockedUids.has(uid)) continue;
      await sendAutoEvent(context, messaging, 'accessApproved', {}, { uid, allowUnapprovedSingleUser: true });
      approvalNotices[uid] = true;
      changed = true;
    }

    for (const [uid, req] of Object.entries(requests || {})) {
      if (!req) continue;
      const status = cleanText(req.status).toLowerCase();
      if (!status || (status !== 'denied' && status !== 'revoked' && status !== 'blocked')) continue;
      if (removalNotices[uid]) continue;
      await sendAutoEvent(
        context,
        messaging,
        'accessRemoved',
        { blocked: status === 'blocked' },
        { uid, allowUnapprovedSingleUser: true }
      );
      removalNotices[uid] = true;
      changed = true;
    }

    const latestLiveAt = newestLiveTimestamp(live, liveTrackers);
    const liveAgeMs = latestLiveAt > 0 ? now - latestLiveAt : Number.POSITIVE_INFINITY;
    const liveIsStale = trackingActive && liveAgeMs > LIVE_STALE_MS;
    const liveWasStale = toBoolean(state.liveWasStale);
    const lastStaleAlertAt = toEpoch(state.lastStaleAlertAt);

    if (liveIsStale) {
      if (!liveWasStale || (now - lastStaleAlertAt) >= LIVE_STALE_REPEAT_MS) {
        await sendAutoEvent(context, messaging, 'genericTripUpdate', { target: 'admins' }, { target: 'admins' });
        updates.lastStaleAlertAt = now;
        changed = true;
      }
      if (!liveWasStale) {
        updates.liveWasStale = true;
        changed = true;
      }
    } else if (liveWasStale && trackingActive && latestLiveAt > 0 && liveAgeMs <= LIVE_STALE_MS) {
      await sendAutoEvent(context, messaging, 'liveTrackingStarted', {}, { target: 'admins' });
      updates.liveWasStale = false;
      updates.lastRecoveredAt = now;
      changed = true;
    }

    if (changed) {
      updates.dayCompleted = dayCompleted;
      updates.dayCompletedAt = dayCompletedAt;
      updates.approvalNotices = approvalNotices;
      updates.removalNotices = removalNotices;
    }

    // Write back sentEvents (new + pruned old keys)
    const hasSentEventChanges = Object.keys(context.newSentEvents || {}).length > 0 || prunedSentEventKeys.length > 0;
    if (hasSentEventChanges) {
      const sentEventUpdates = {};
      Object.entries(context.newSentEvents || {}).forEach(([k, v]) => { sentEventUpdates[k] = v; });
      prunedSentEventKeys.forEach((k) => { sentEventUpdates[k] = null; });
      if (!updates.sentEvents) updates.sentEvents = Object.assign({}, sentEvents);
      Object.entries(sentEventUpdates).forEach(([k, v]) => {
        if (v === null) delete updates.sentEvents[k];
        else updates.sentEvents[k] = v;
      });
    }

    // Write back cooldown tracking
    if (context.updatedLastSentByType) {
      updates.lastSentByType = context.lastSentByType;
    }
    if (context.updatedNotificationWindow) {
      updates.notificationWindow = context.notificationWindow;
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = now;
      await db.ref(`${TRACKER_BASE}/notificationState`).update(updates);
      console.log('notificationState updated');
    }

    if (Object.keys(context.copyHistoryCleanup).length > 0 || Object.keys(context.copyHistoryUpdates).length > 0) {
      try {
        const historyUpdates = Object.assign({}, context.copyHistoryCleanup);
        Object.entries(context.copyHistoryUpdates).forEach(([key, record]) => {
          historyUpdates[key] = record;
        });
        await db.ref(COPY_HISTORY_PATH).update(historyUpdates);
        console.log('notificationCopyHistory updated');
      } catch (_) { /* copy history write is non-fatal */ }
    }

    if (!changed) {
      console.log('No notification changes.');
    }
  } finally {
    if (app) await app.delete();
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();
