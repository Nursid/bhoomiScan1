/**
 * Push notifications (FCM) with a database outbox.
 *
 *   enqueue      inside the caller's transaction (e.g. with the new land snapshot),
 *                so a notification exists exactly when the event was committed
 *   processOne   immediate send right after commit (fire-and-forget, best effort)
 *   processDue   job: claims PENDING rows (FOR UPDATE SKIP LOCKED + lease), sends,
 *                retries with backoff up to PUSH_MAX_ATTEMPTS
 *
 * Push carries only a short summary and ids (FCM payloads are capped at ~4 KB);
 * the app opens GET /land-verification/:id/comparison for old / new / changes.
 * Every notification is also kept as the user's inbox (GET /notifications).
 */

const { prisma } = require('../../database/prisma');
const config = require('../../config');
const logger = require('../../utils/logger');
const messaging = require('../../integrations/firebase/firebase-messaging.client');

const LEASE_SECONDS = 120;
const BASE_RETRY_SECONDS = 30;
const MAX_RETRY_SECONDS = 3600;

/* ------------------------------- Messages -------------------------------- */

const formatDate = (date) =>
  new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/**
 * Notification text for a completed land verification.
 * @param {object} p
 * @param {'INITIAL'|'UNCHANGED'|'CHANGED'} p.snapshotStatus
 * @param {string|null} p.displayName
 * @param {{ total: number, critical: number }} p.summary
 * @param {Date|null} p.previousVerifiedAt
 */
const landVerificationMessage = ({ snapshotStatus, displayName, summary, previousVerifiedAt }) => {
  const land = displayName || 'Your land';
  if (snapshotStatus === 'CHANGED') {
    const important = summary.critical > 0 ? ` (${summary.critical} important)` : '';
    return {
      type: 'LAND_CHANGED',
      title: summary.critical > 0 ? '⚠️ Important change in your land record' : 'Your land record has changed',
      body: `${land}: ${summary.total} change(s) found${important}. Tap to see old vs new.`,
    };
  }
  if (snapshotStatus === 'UNCHANGED') {
    return {
      type: 'LAND_UNCHANGED',
      title: 'Everything is good ✅',
      body: `${land}: no changes${previousVerifiedAt ? ` since ${formatDate(previousVerifiedAt)}` : ''}.`,
    };
  }
  return {
    type: 'LAND_VERIFIED',
    title: 'Land record verified',
    body: `${land}: record saved. We'll notify you if anything changes.`,
  };
};

/* -------------------------------- Outbox --------------------------------- */

/** @param {object} db transaction client (or prisma) */
const enqueue = (db, { userId, type, title, body, data, landVerificationId, snapshotId }) =>
  db.notification.create({
    data: { userId, type, title, body, data: data || undefined, landVerificationId: landVerificationId || null, snapshotId: snapshotId || null },
  });

const retryDelaySeconds = (attempts) => Math.min(MAX_RETRY_SECONDS, BASE_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1));

const finish = (id, data) => prisma.notification.update({ where: { id }, data: { lockedUntil: null, ...data } });

const retryOrFail = (notification, reason) => {
  if (notification.attempts >= config.push.maxAttempts) {
    return finish(notification.id, { status: 'FAILED', lastError: reason });
  }
  return finish(notification.id, {
    status: 'PENDING',
    lastError: reason,
    nextAttemptAt: new Date(Date.now() + retryDelaySeconds(notification.attempts) * 1000),
  });
};

/** Sends one claimed notification and records the outcome. */
const deliver = async (notification) => {
  if (!messaging.isConfigured()) {
    return finish(notification.id, { status: 'SKIPPED', lastError: 'PUSH_NOT_CONFIGURED' });
  }
  const devices = await prisma.deviceToken.findMany({ where: { userId: notification.userId }, select: { token: true } });
  if (devices.length === 0) {
    return finish(notification.id, { status: 'SKIPPED', lastError: 'NO_DEVICES' });
  }

  let result;
  try {
    result = await messaging.sendToTokens(
      devices.map((device) => device.token),
      {
        title: notification.title,
        body: notification.body,
        data: { ...(notification.data || {}), notificationId: notification.id, type: notification.type },
      },
    );
  } catch (error) {
    logger.warn({ notificationId: notification.id, code: error?.code, err: error?.message }, 'push send failed');
    return retryOrFail(notification, String(error?.code || 'SEND_FAILED').slice(0, 200));
  }

  if (result.deadTokens.length > 0) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: result.deadTokens } } });
    logger.info({ userId: notification.userId, removed: result.deadTokens.length }, 'removed dead device tokens');
  }
  if (result.delivered > 0) {
    return finish(notification.id, { status: 'SENT', sentAt: new Date(), deliveredCount: result.delivered, lastError: null });
  }
  if (result.transientErrors.length === 0) {
    return finish(notification.id, { status: 'SKIPPED', lastError: 'NO_VALID_DEVICES' });
  }
  return retryOrFail(notification, result.transientErrors[0]);
};

/** Claims due notifications (optionally one id) with a lease; attempts are counted here. */
const claim = async ({ id = null, limit = config.jobs.batchSize } = {}) => {
  const rows = await prisma.$queryRaw`
    UPDATE notifications
       SET locked_until = now() + make_interval(secs => ${LEASE_SECONDS}::int),
           attempts = attempts + 1
     WHERE id IN (
       SELECT n.id FROM notifications n
        WHERE n.status = 'PENDING'
          AND n.next_attempt_at <= now()
          AND (n.locked_until IS NULL OR n.locked_until < now())
          AND (${id}::uuid IS NULL OR n.id = ${id}::uuid)
        ORDER BY n.next_attempt_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id`;
  if (rows.length === 0) return [];
  return prisma.notification.findMany({ where: { id: { in: rows.map((row) => row.id) } } });
};

/** Immediate attempt right after the event commits; the job retries anything left. */
const processOne = async (id) => {
  const [notification] = await claim({ id, limit: 1 });
  return notification ? deliver(notification) : null;
};

/** Job entry point. */
const processDue = async () => {
  const claimed = await claim();
  const summary = { claimed: claimed.length, sent: 0, skipped: 0, pending: 0, failed: 0 };
  for (const notification of claimed) {
    try {
      const updated = await deliver(notification);
      summary[{ SENT: 'sent', SKIPPED: 'skipped', PENDING: 'pending', FAILED: 'failed' }[updated.status]] += 1;
    } catch (error) {
      summary.pending += 1;
      logger.error({ err: error, notificationId: notification.id }, 'push delivery crashed; lease will expire and retry');
    }
  }
  if (summary.claimed > 0) logger.info(summary, 'push notifications processed');
  return summary;
};

/** Fire-and-forget immediate send; never throws into the caller. */
const sendSoon = (id) => {
  setImmediate(() => {
    processOne(id).catch((error) => logger.error({ err: error, notificationId: id }, 'immediate push failed; the job will retry'));
  });
};

/* -------------------------------- Devices -------------------------------- */

const registerDevice = async (userId, { token, platform }) => {
  const now = new Date();
  // A token belongs to one install; if another account logged in on it, it moves.
  const device = await prisma.deviceToken.upsert({
    where: { token },
    create: { userId, token, platform, lastSeenAt: now },
    update: { userId, platform, lastSeenAt: now },
  });
  return { id: device.id, platform: device.platform, lastSeenAt: device.lastSeenAt };
};

const removeDevice = async (userId, token) => {
  const { count } = await prisma.deviceToken.deleteMany({ where: { userId, token } });
  return { removed: count };
};

/* --------------------------------- Inbox --------------------------------- */

const publicNotification = (notification) => ({
  id: notification.id,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  data: notification.data,
  landVerificationId: notification.landVerificationId,
  snapshotId: notification.snapshotId,
  delivery: notification.status,
  createdAt: notification.createdAt,
  sentAt: notification.sentAt,
});

const listNotifications = async (userId, { skip, limit }) => {
  const where = { userId };
  const [items, total] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.notification.count({ where }),
  ]);
  return { notifications: items.map(publicNotification), total };
};

module.exports = {
  landVerificationMessage,
  enqueue,
  sendSoon,
  processOne,
  processDue,
  registerDevice,
  removeDevice,
  listNotifications,
  publicNotification,
  __testing: { retryDelaySeconds, deliver, claim },
};
