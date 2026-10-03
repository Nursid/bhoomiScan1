/**
 * Recurring verification (WEEKLY / MONTHLY / QUARTERLY share this one job).
 *
 *   1. claim parcels with monitoring on, next_verification_at due, and an owner
 *      whose subscription is ACTIVE right now (FOR UPDATE SKIP LOCKED + lease,
 *      so several workers never pick the same parcel)
 *   2. re-verify each: provider fetch -> diff vs previous snapshot -> new snapshot,
 *      changes, alert, smart contract record (all inside land-verification.service)
 *   3. success moves next_verification_at by the parcel's frequency; failure
 *      backs off (1h, 2h, 4h ... 24h) and alerts after repeated failures
 *
 * Parcels of users without an active subscription are skipped and resume when
 * the user renews.
 */

const config = require('../config');
const { prisma } = require('../database/prisma');
const logger = require('../utils/logger');
const requestContext = require('../utils/requestContext');
const landVerificationService = require('../modules/land-verification/land-verification.service');

const LEASE_MINUTES = 10;

const claimDue = async (limit) => {
  const rows = await prisma.$queryRaw`
    UPDATE land_verifications
       SET locked_until = now() + make_interval(mins => ${LEASE_MINUTES}::int)
     WHERE id IN (
       SELECT lv.id
         FROM land_verifications lv
        WHERE lv.monitoring_enabled = true
          AND lv.next_verification_at <= now()
          AND (lv.locked_until IS NULL OR lv.locked_until < now())
          AND EXISTS (
            SELECT 1 FROM subscriptions s
             WHERE s.user_id = lv.user_id
               AND s.status = 'ACTIVE'
               AND s.starts_at <= now()
               AND s.ends_at > now()
          )
        ORDER BY lv.next_verification_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, user_id AS "userId"`;
  return rows;
};

const run = async ({ limit = config.jobs.batchSize } = {}) => {
  const claimed = await claimDue(limit);
  const summary = { claimed: claimed.length, verified: 0, changed: 0, failed: 0 };

  for (const { id, userId } of claimed) {
    try {
      const result = await requestContext.run({ requestId: `job:recurring:${id}`, userId }, () => landVerificationService.reverify(id, 'SCHEDULED'));
      summary.verified += 1;
      if (result.status === 'CHANGED') summary.changed += 1;
    } catch (error) {
      // land-verification.service already recorded the failure and rescheduled the parcel.
      summary.failed += 1;
      logger.warn({ verificationId: id, code: error.code, err: error.code ? undefined : error }, 'scheduled verification failed');
      await prisma.landVerification.updateMany({ where: { id, lockedUntil: { not: null } }, data: { lockedUntil: null } }).catch(() => {});
    }
  }

  if (summary.claimed > 0) logger.info(summary, 'recurring verification run');
  return summary;
};

module.exports = { run, __testing: { claimDue } };
