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
const DEFAULT_DAY_COMPLETE_RADIUS_METERS = 402.336; // 0.25 miles
const FALLBACK_DAY_COMPLETE_RADIUS_METERS = 804.672; // 0.5 miles
const INFERRED_DAY_COMPLETE_MAX_LIVE_AGE_MS = 20 * 60 * 1000;
const MAX_ACCURACY_RADIUS_BONUS_METERS = 250;

const TRIPGUIDE_NOTIFICATION_COPY = {
  tripStarted: {
    target: 'all',
    title: 'TripGuide: tracking started',
    body: 'Mike and Lauren are live on the trip map.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  tripStopped: {
    target: 'all',
    title: 'TripGuide: tracking stopped',
    body: 'Live tracking has stopped for now.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  tripComplete: {
    target: 'all',
    title: 'TripGuide: final arrival',
    body: 'Mike and Lauren made it to Seal Beach. Final Trip complete.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-9'
  },

  dayComplete: {
    1: {
      target: 'all',
      title: 'TripGuide: Day 1 complete',
      body: 'Mike and Lauren arrived at the hotel for Day 1.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-1'
    },
    2: {
      target: 'all',
      title: 'TripGuide: Day 2 complete',
      body: 'Mike and Lauren arrived at the hotel for Day 2.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-2'
    },
    3: {
      target: 'all',
      title: 'TripGuide: Day 3 complete',
      body: 'Mike and Lauren arrived at the hotel for Day 3.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-3'
    },
    4: {
      target: 'all',
      title: 'TripGuide: Day 4 complete',
      body: 'Mike and Lauren arrived at the hotel/lodge for Day 4.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-4'
    },
    5: {
      target: 'all',
      title: 'TripGuide: Day 5 complete',
      body: 'Mike and Lauren wrapped up Day 5 and made it back to the lodge.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-5'
    },
    6: {
      target: 'all',
      title: 'TripGuide: Day 6 complete',
      body: 'Mike and Lauren wrapped up the Angel Fire flex day.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-6'
    },
    7: {
      target: 'all',
      title: 'TripGuide: Day 7 complete',
      body: 'Mike and Lauren arrived at the hotel for Day 7.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-7'
    },
    8: {
      target: 'all',
      title: 'TripGuide: Day 8 complete',
      body: 'Mike and Lauren arrived at the hotel for Day 8.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-8'
    },
    9: {
      target: 'all',
      title: 'TripGuide: Day 9 complete',
      body: 'Mike and Lauren made it home to Seal Beach. Final Trip complete.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-9'
    }
  },

  liveStale: {
    target: 'admins',
    title: 'TripGuide: live signal stale',
    body: 'The live location has not updated in over 15 minutes.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  liveRestored: {
    target: 'admins',
    title: 'TripGuide: live signal restored',
    body: 'Live location updates are coming through again.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  accessRequest: {
    target: 'admins',
    title: 'TripGuide access request',
    body: '{name} requested access to the live trip hub.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  accessApproved: {
    target: 'singleUser',
    title: 'TripGuide access approved',
    body: 'You can now view Mike and Lauren\'s live trip hub.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  accessDenied: {
    target: 'singleUser',
    title: 'TripGuide access update',
    body: 'Your live trip hub access request was not approved.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  userBlocked: {
    target: 'admins',
    title: 'TripGuide user blocked',
    body: '{name} was blocked from the live trip hub.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  tripReset: {
    target: 'admins',
    title: 'TripGuide reset complete',
    body: 'The live trip state was reset by an admin.',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  newMessage: {
    target: 'all',
    title: 'TripGuide message from {name}',
    body: '{messagePreview}',
    url: 'https://mdnadon112-sketch.github.io/TripGuide/'
  },

  days: {
    1: {
      target: 'all',
      title: 'TripGuide: Day 1 started',
      body: 'Beaufort to Birmingham/Homewood. Stretch start day: Savannah shade stop, fuel, dogs, check-in, early sleep.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-1'
    },

    2: {
      target: 'all',
      title: 'TripGuide: Day 2 started',
      body: 'Homewood to North Little Rock. Memphis riverfront stop, dog relief, and reset before the long Plains/Texas leg.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-2'
    },

    3: {
      target: 'all',
      title: 'TripGuide: Day 3 started',
      body: 'North Little Rock to Amarillo. Longest push: OKC Memorial, Route 66 optional, heat and fatigue control.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-3'
    },

    4: {
      target: 'all',
      title: 'TripGuide: Day 4 started',
      body: 'Amarillo to Angel Fire. Scenic approach day: Palo Duro, Capulin, Raton, and Angel Fire arrival.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-4'
    },

    5: {
      target: 'all',
      title: 'TripGuide: Day 5 started',
      body: 'Angel Fire MTB day. Dog boarding, bike park, Monte Verde Lake, and recovery at the lodge.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-5'
    },

    6: {
      target: 'all',
      title: 'TripGuide: Day 6 started',
      body: 'Angel Fire flex day. Golf, recovery, Monte Verde Lake, Taos scenery, or low-effort rest.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-6'
    },

    7: {
      target: 'all',
      title: 'TripGuide: Day 7 started',
      body: 'Angel Fire to Flagstaff. I-40 corridor with Petrified Forest and Meteor Crater options.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-7'
    },

    8: {
      target: 'all',
      title: 'TripGuide: Day 8 started',
      body: 'Flagstaff/Sedona to Barstow. Spa stop, Kingman fuel, and final California staging night.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-8'
    },

    9: {
      target: 'all',
      title: 'TripGuide: Day 9 started',
      body: 'Final push to Seal Beach. Barstow fuel, home stretch, and trip finish.',
      url: 'https://mdnadon112-sketch.github.io/TripGuide/#day-9'
    }
  }
};

const TRIPGUIDE_PUSH_RULES = {
  trackingStarted: {
    when: 'tripGuide/live/trackingActive changes false/missing -> true',
    send: 'tripStarted',
    dedupeKey: 'trackingActive'
  },

  trackingStopped: {
    when: 'tripGuide/live/trackingActive changes true -> false',
    send: 'tripStopped',
    dedupeKey: 'trackingActive'
  },

  dayChanged: {
    when: 'tripGuide/live/activeDay changes to 1-9',
    send: 'days[activeDay]',
    dedupeKey: 'activeDay'
  },

  dayComplete: {
    when: 'tripGuide/live/dayComplete changes to 1-9, or inferred by live location arrival at that active day destination',
    send: 'dayComplete[day]',
    dedupeKey: 'dayCompleted/{day}'
  },

  tripComplete: {
    when: 'tripGuide/live/activeDay === 9 and tripGuide/live/tripComplete === true',
    send: 'tripComplete',
    dedupeKey: 'tripComplete'
  },

  newMessage: {
    when: 'newest tripGuide/messages item has createdAt newer than notificationState/lastMessageAt',
    send: 'newMessage',
    dedupeKey: 'lastMessageId'
  },

  accessRequest: {
    when: 'new pending tripGuide/accessRequests/{uid}',
    send: 'accessRequest',
    dedupeKey: 'lastAccessRequestUid + lastAccessRequestAt'
  },

  accessApproved: {
    when: 'tripGuide/approvedUsers/{uid}/approved becomes true',
    send: 'accessApproved to that uid',
    dedupeKey: 'approvalNotices/{uid}'
  },

  accessDenied: {
    when: 'tripGuide/accessRequests/{uid}/status becomes denied',
    send: 'accessDenied to that uid',
    dedupeKey: 'denialNotices/{uid}'
  },

  liveStale: {
    when: 'trackingActive true and live timestamp older than 15 minutes',
    send: 'liveStale admins only',
    cooldown: '60 minutes',
    dedupeKey: 'lastStaleAlertAt'
  },

  liveRestored: {
    when: 'liveWasStale true and live timestamp becomes fresh again',
    send: 'liveRestored admins only',
    dedupeKey: 'lastRecoveredAt'
  },

  userBlocked: {
    when: 'approvedUsers/{uid}/blocked becomes true or accessRequests/{uid}/status becomes blocked',
    send: 'userBlocked admins only',
    dedupeKey: 'blockedNotices/{uid}'
  },

  tripReset: {
    when: 'tripGuide/live/resetAt changes',
    send: 'tripReset admins only',
    dedupeKey: 'lastResetAt'
  }
};

const DAY_COMPLETION_DESTINATIONS = {
  1: { lat: 33.46895, lng: -86.80249, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS },
  2: { lat: 34.77358, lng: -92.2644, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS },
  3: { lat: 35.20874, lng: -101.83372, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS },
  4: { lat: 36.39319, lng: -105.28514, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS },
  5: { lat: 36.39319, lng: -105.28514, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS },
  6: { lat: 36.39319, lng: -105.28514, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS },
  7: { lat: 35.20062, lng: -111.61266, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS },
  8: { lat: 34.89452, lng: -117.02282, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS },
  9: { lat: 33.73904, lng: -118.10336, radiusMeters: DEFAULT_DAY_COMPLETE_RADIUS_METERS }
};

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveDatabaseUrl(serviceAccount) {
  const fromEnv = String(process.env.FIREBASE_DATABASE_URL || '').trim();
  if (fromEnv) return fromEnv;
  const fromServiceAccount = String(serviceAccount.databaseURL || '').trim();
  if (fromServiceAccount) return fromServiceAccount;
  const projectId = String(serviceAccount.project_id || '').trim();
  if (!projectId) {
    throw new Error('Could not resolve Firebase database URL. Set FIREBASE_DATABASE_URL secret.');
  }
  return `https://${projectId}-default-rtdb.firebaseio.com`;
}

function compileCopy(template, params = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => String(params[key] || ''));
}

function cloneCopy(copy, params = {}) {
  return {
    target: copy.target,
    title: compileCopy(copy.title, params),
    body: compileCopy(copy.body, params),
    url: copy.url
  };
}

function getDayCopy(day) {
  const dayCopy = TRIPGUIDE_NOTIFICATION_COPY.days[String(day)] || TRIPGUIDE_NOTIFICATION_COPY.days[day];
  if (dayCopy) return dayCopy;
  return {
    target: 'all',
    title: `TripGuide: Day ${day} active`,
    body: `The trip tracker is now on Day ${day}.`,
    url: `${SITE_URL}#day-${day}`
  };
}

function classifySendError(code) {
  const value = String(code || '');
  if (value.includes('registration-token-not-registered')) return { reason: 'not-registered', disable: true };
  if (value.includes('invalid-registration-token')) return { reason: 'invalid-token', disable: true };
  return { reason: 'send-failed', disable: false };
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

function hasStateMarker(value) {
  if (value === true) return true;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true' || toEpoch(value) > 0;
  return false;
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
    if (day >= 1 && day <= 9) return day;
  }
  return 0;
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
    if (!(day >= 1 && day <= 9)) return;
    if (!value || typeof value !== 'object') return;

    const latLng = extractLatLng(value);
    if (!latLng) return;

    const radiusMeters = toNumber(value.radiusMeters);
    const weakPrecision = toBoolean(value.weakPrecision);

    output[String(day)] = {
      lat: latLng.lat,
      lng: latLng.lng,
      radiusMeters: radiusMeters && radiusMeters > 0 ? radiusMeters : undefined,
      weakPrecision
    };
  });

  return output;
}

function mergeDestinationMaps(defaults, primaryOverrides, secondaryOverrides) {
  const merged = {};
  for (let day = 1; day <= 9; day += 1) {
    const key = String(day);
    merged[key] = Object.assign(
      {},
      defaults && (defaults[key] || defaults[day]) ? (defaults[key] || defaults[day]) : {},
      secondaryOverrides && secondaryOverrides[key] ? secondaryOverrides[key] : {},
      primaryOverrides && primaryOverrides[key] ? primaryOverrides[key] : {}
    );
  }
  return merged;
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
    candidates.push({
      coord,
      updatedAt,
      trackingActive,
      accuracy: toNumber(record.accuracy) || 0
    });
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.trackingActive !== b.trackingActive) return a.trackingActive ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  return candidates[0];
}

function getDayCompleteCopy(day) {
  const copy = TRIPGUIDE_NOTIFICATION_COPY.dayComplete[String(day)] || TRIPGUIDE_NOTIFICATION_COPY.dayComplete[day];
  if (copy) return copy;
  return {
    target: 'all',
    title: `TripGuide: Day ${day} complete`,
    body: `Mike and Lauren completed Day ${day}.`,
    url: `${SITE_URL}#day-${day}`
  };
}

function inferDayCompletionFromLocation(live, liveTrackers, activeDay, options = {}) {
  if (!(activeDay >= 1 && activeDay <= 9)) return 0;
  const destinationMap = options.destinationMap || DAY_COMPLETION_DESTINATIONS;
  const destination = destinationMap[String(activeDay)] || destinationMap[activeDay];
  if (!destination) return 0;

  if (!toBoolean(live.trackingActive)) return 0;

  const latestLiveAt = toEpoch(options.latestLiveAt);
  if (latestLiveAt > 0 && (Date.now() - latestLiveAt) > INFERRED_DAY_COMPLETE_MAX_LIVE_AGE_MS) {
    return 0;
  }

  const latest = latestLiveCoordinate(live, liveTrackers);
  if (!latest || !latest.coord) return 0;

  let radiusMeters = Number.isFinite(Number(destination.radiusMeters))
    ? Number(destination.radiusMeters)
    : FALLBACK_DAY_COMPLETE_RADIUS_METERS;
  if (toBoolean(destination.weakPrecision)) {
    radiusMeters = Math.max(radiusMeters, FALLBACK_DAY_COMPLETE_RADIUS_METERS);
  }

  const accuracyBonus = Math.max(0, Math.min(MAX_ACCURACY_RADIUS_BONUS_METERS, Number(latest.accuracy || 0)));
  const effectiveRadiusMeters = radiusMeters + accuracyBonus;

  const distanceMeters = haversineMeters(latest.coord, destination);
  return distanceMeters <= effectiveRadiusMeters ? activeDay : 0;
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalEmail(value) {
  return cleanEmail(value).replace(/@googlemail\.com$/, '@gmail.com');
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
    if (record && record.blocked === true) blockedUids.add(uid);
  });

  adminUids.forEach((uid) => approvedUids.add(uid));

  Object.entries(blockedUsers || {}).forEach(([uid, record]) => {
    if (isBlockedRecord(record)) blockedUids.add(uid);
  });

  return { adminUids, approvedUids, blockedUids };
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

async function sendPush(context, messaging, copy, options = {}) {
  const target = copy.target;
  const title = copy.title;
  const body = copy.body;
  const url = copy.url || SITE_URL;

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
      stateSnap,
      dayDestinationsSnap,
      tripConfigDayDestinationsSnap
    ] = await Promise.all([
      db.ref(`${TRACKER_BASE}/live`).get(),
      db.ref(`${TRACKER_BASE}/liveTrackers`).get(),
      db.ref(`${TRACKER_BASE}/messages`).orderByChild('createdAt').limitToLast(25).get(),
      db.ref(`${TRACKER_BASE}/accessRequests`).get(),
      db.ref(`${TRACKER_BASE}/admins`).get(),
      db.ref(`${TRACKER_BASE}/approvedUsers`).get(),
      db.ref(`${TRACKER_BASE}/blockedUsers`).get(),
      db.ref(`${TRACKER_BASE}/pushTokens`).get(),
      db.ref(`${TRACKER_BASE}/notificationState`).get(),
      db.ref(`${TRACKER_BASE}/dayCompletionDestinations`).get(),
      db.ref(`${TRACKER_BASE}/tripConfig/dayCompletionDestinations`).get()
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
    const dayDestinationOverrides = normalizeDestinationMap(dayDestinationsSnap.val() || {});
    const tripConfigDestinationOverrides = normalizeDestinationMap(tripConfigDayDestinationsSnap.val() || {});
    const destinationMap = mergeDestinationMaps(
      DAY_COMPLETION_DESTINATIONS,
      dayDestinationOverrides,
      tripConfigDestinationOverrides
    );

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

    // tracking started/stopped
    const trackingActive = toBoolean(live.trackingActive);
    const previousTrackingActive = toBoolean(state.trackingActive);
    if (trackingActive !== previousTrackingActive) {
      if (trackingActive) {
        await sendPush(context, messaging, TRIPGUIDE_NOTIFICATION_COPY.tripStarted);
      } else if (state.trackingActiveSeenOnce === true) {
        await sendPush(context, messaging, TRIPGUIDE_NOTIFICATION_COPY.tripStopped);
      }
      updates.trackingActive = trackingActive;
      updates.trackingActiveSeenOnce = true;
      updates.trackingActiveChangedAt = now;
      changed = true;
    }

    // day changed
    const activeDay = resolveActiveDay(live);
    const previousActiveDay = Number(state.activeDay || 0);
    if (activeDay >= 1 && activeDay <= 9 && activeDay !== previousActiveDay) {
      await sendPush(context, messaging, getDayCopy(activeDay));
      updates.activeDay = activeDay;
      updates.activeDayChangedAt = now;
      changed = true;
    }

    // day complete (preferred explicit fields, fallback inferred by location)
    const dayCompleted = Object.assign({}, state.dayCompleted || {});
    const dayCompletedAt = Object.assign({}, state.dayCompletedAt || {});
    const explicitDayComplete = Number(live.dayComplete || 0);
    let completedDay = 0;
    let completedDayAt = toEpoch(live.dayCompleteAt || now);

    if (explicitDayComplete >= 1 && explicitDayComplete <= 9) {
      completedDay = explicitDayComplete;
      completedDayAt = toEpoch(live.dayCompleteAt || live.lastUpdated || live.updatedAt || now);
    } else {
      completedDay = inferDayCompletionFromLocation(live, liveTrackers, activeDay, {
        destinationMap,
        latestLiveAt: newestLiveTimestamp(live, liveTrackers)
      });
      completedDayAt = now;
    }

    if (completedDay >= 1 && completedDay <= 9 && !hasStateMarker(dayCompleted[String(completedDay)])) {
      await sendPush(context, messaging, getDayCompleteCopy(completedDay));
      dayCompleted[String(completedDay)] = true;
      dayCompletedAt[String(completedDay)] = completedDayAt || now;
      changed = true;

      if (completedDay === 9) {
        updates.tripComplete = true;
        updates.tripCompleteAt = now;
      }
    }

    // trip complete (avoid duplicate if day 9 completion already sent)
    const tripComplete = toBoolean(live.tripComplete);
    if (tripComplete && activeDay === 9 && !toBoolean(state.tripComplete) && !hasStateMarker(dayCompleted['9'])) {
      await sendPush(context, messaging, TRIPGUIDE_NOTIFICATION_COPY.tripComplete);
      updates.tripComplete = true;
      updates.tripCompleteAt = now;
      changed = true;
    }

    // trip reset
    const resetAt = toEpoch(live.resetAt);
    if (resetAt > 0 && resetAt > toEpoch(state.lastResetAt)) {
      await sendPush(context, messaging, TRIPGUIDE_NOTIFICATION_COPY.tripReset);
      updates.lastResetAt = resetAt;
      changed = true;
    }

    // new message
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
        cloneCopy(TRIPGUIDE_NOTIFICATION_COPY.newMessage, {
          name: newestMessage.name,
          messagePreview: newestMessage.text.slice(0, 120)
        })
      );
      updates.lastMessageId = newestMessage.id;
      updates.lastMessageAt = newestMessage.createdAt;
      changed = true;
    }

    // new pending access request
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
        cloneCopy(TRIPGUIDE_NOTIFICATION_COPY.accessRequest, { name: newestPendingRequest.name })
      );
      updates.lastAccessRequestUid = newestPendingRequest.uid;
      updates.lastAccessRequestAt = newestPendingRequest.requestedAt;
      changed = true;
    }

    // access approved / denied
    const approvalNotices = Object.assign({}, state.approvalNotices || {});
    const denialNotices = Object.assign({}, state.denialNotices || {});

    for (const [uid, record] of Object.entries(approvedUsers)) {
      const approved = !!(record && (record.approved === true || record.admin === true));
      if (!approved) continue;
      if (approvalNotices[uid]) continue;
      if (context.roles.blockedUids.has(uid)) continue;

      await sendPush(context, messaging, TRIPGUIDE_NOTIFICATION_COPY.accessApproved, {
        uid,
        allowUnapprovedSingleUser: true
      });
      approvalNotices[uid] = true;
      changed = true;
    }

    for (const [uid, req] of Object.entries(requests)) {
      if (!req) continue;
      const status = cleanText(req.status).toLowerCase();
      if (status !== 'denied') continue;
      if (denialNotices[uid]) continue;
      await sendPush(context, messaging, TRIPGUIDE_NOTIFICATION_COPY.accessDenied, {
        uid,
        allowUnapprovedSingleUser: true
      });
      denialNotices[uid] = true;
      changed = true;
    }

    // live stale / restored
    const latestLiveAt = newestLiveTimestamp(live, liveTrackers);
    const liveAgeMs = latestLiveAt > 0 ? now - latestLiveAt : Number.POSITIVE_INFINITY;
    const liveIsStale = trackingActive && liveAgeMs > LIVE_STALE_MS;
    const liveWasStale = toBoolean(state.liveWasStale);
    const lastStaleAlertAt = toEpoch(state.lastStaleAlertAt);

    if (liveIsStale) {
      if (!liveWasStale || (now - lastStaleAlertAt) >= LIVE_STALE_REPEAT_MS) {
        await sendPush(context, messaging, TRIPGUIDE_NOTIFICATION_COPY.liveStale);
        updates.lastStaleAlertAt = now;
        changed = true;
      }
      if (!liveWasStale) {
        updates.liveWasStale = true;
        changed = true;
      }
    } else if (liveWasStale && trackingActive && latestLiveAt > 0 && liveAgeMs <= LIVE_STALE_MS) {
      await sendPush(context, messaging, TRIPGUIDE_NOTIFICATION_COPY.liveRestored);
      updates.liveWasStale = false;
      updates.lastRecoveredAt = now;
      changed = true;
    }

    // user blocked
    const blockedNotices = Object.assign({}, state.blockedNotices || {});
    const blockedCandidates = {};

    Object.entries(blockedUsers).forEach(([uid, record]) => {
      if (isBlockedRecord(record)) {
        blockedCandidates[uid] = cleanText(record && (record.displayName || record.email || record.name), 'A user');
      }
    });

    Object.entries(approvedUsers).forEach(([uid, record]) => {
      if (record && record.blocked === true) {
        blockedCandidates[uid] = cleanText(record.displayName || record.email || record.name, 'A user');
      }
    });

    Object.entries(requests).forEach(([uid, req]) => {
      if (!req) return;
      if (cleanText(req.status).toLowerCase() === 'blocked') {
        blockedCandidates[uid] = cleanText(req.displayName || req.email || req.name, 'A user');
      }
    });

    for (const [uid, name] of Object.entries(blockedCandidates)) {
      if (blockedNotices[uid]) continue;
      await sendPush(
        context,
        messaging,
        cloneCopy(TRIPGUIDE_NOTIFICATION_COPY.userBlocked, { name })
      );
      blockedNotices[uid] = true;
      changed = true;
    }

    if (changed) {
      updates.dayCompleted = dayCompleted;
      updates.dayCompletedAt = dayCompletedAt;
      updates.approvalNotices = approvalNotices;
      updates.denialNotices = denialNotices;
      updates.blockedNotices = blockedNotices;
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = now;
      await db.ref(`${TRACKER_BASE}/notificationState`).update(updates);
      console.log('notificationState updated');
    }

    if (!changed) {
      console.log('No notification changes.');
    }

    // referenced for explicit blend visibility
    if (!TRIPGUIDE_PUSH_RULES || !TRIPGUIDE_NOTIFICATION_COPY) {
      throw new Error('Notification rules/copy missing.');
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
