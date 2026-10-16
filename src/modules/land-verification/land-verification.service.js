/**
 * Land verification business logic. Provider-agnostic: everything state- or
 * provider-specific comes from the adapter (providers/registry.js).
 *
 * verify():
 *   1. fetch the current record from the provider (outside any DB transaction)
 *   2. normalize + hash it
 *   3. in one transaction, with the parcel row locked:
 *        previous snapshot -> re-normalized with current rules -> diff
 *        insert snapshot, changes, PENDING smart contract record, alert (if CHANGED)
 *        update parcel status / counters / next scheduled date
 *   4. after commit: submit to the smart contract (inline once; retried by the job)
 */

const { Prisma } = require('@prisma/client');
const config = require('../../config');
const { prisma } = require('../../database/prisma');
const logger = require('../../utils/logger');
const { canonicalStringify, sha256Hex } = require('../../utils/canonicalJson');
const { notFound, forbidden, unprocessable } = require('../../utils/errors');
const { hashRecord } = require('./land-record-normalizer');
const { diffRecords, summarize } = require('./land-record-diff.service');
const { nextVerificationDate, failureRetryDate } = require('./verification-schedule');
const registry = require('./providers/registry');
const smartContractService = require('../smart-contract/smart-contract.service');
const alertsService = require('../alerts/alerts.service');
const notificationsService = require('../notifications/notifications.service');
const { describeField } = require('./land-record-labels');

const SCHEDULED_FAILURE_ALERT_THRESHOLD = 3;
const MAX_ALERT_FIELDS = 20;

/* -------------------------------- Helpers -------------------------------- */

const parcelKeyFor = (adapter, locator) => sha256Hex(canonicalStringify({ state: adapter.stateCode, ...adapter.parcelIdentity(locator) }));

const snapshotStatusToVerificationStatus = { INITIAL: 'VERIFIED', UNCHANGED: 'UNCHANGED', CHANGED: 'CHANGED' };

const publicChange = (change) => ({
  id: change.id,
  type: change.type,
  field: change.field,
  previousValue: change.oldValue ?? null,
  currentValue: change.newValue ?? null,
  isCritical: change.isCritical,
  snapshotId: change.snapshotId,
  previousSnapshotId: change.previousSnapshotId,
  createdAt: change.createdAt,
});

const publicSnapshot = (snapshot, { includeRaw = false } = {}) => ({
  id: snapshot.id,
  sequence: snapshot.sequence,
  status: snapshot.status,
  trigger: snapshot.trigger,
  hash: snapshot.hash,
  provider: snapshot.provider,
  providerReference: snapshot.providerReference,
  normalizerVersion: snapshot.normalizerVersion,
  previousSnapshotId: snapshot.previousSnapshotId,
  changeCount: snapshot.changeCount,
  verifiedAt: snapshot.verifiedAt,
  record: snapshot.normalizedData,
  ...(includeRaw ? { rawResponse: snapshot.rawResponse } : {}),
  ...(snapshot.smartContractRecord !== undefined ? { smartContract: smartContractService.publicRecord(snapshot.smartContractRecord) } : {}),
});

const publicVerification = (verification) => ({
  id: verification.id,
  state: verification.stateCode,
  provider: verification.provider,
  locator: verification.locator,
  displayName: verification.displayName,
  status: verification.status,
  verificationCount: verification.verificationCount,
  changeCount: verification.changeCount,
  latestSnapshotId: verification.latestSnapshotId,
  firstVerifiedAt: verification.firstVerifiedAt,
  lastVerifiedAt: verification.lastVerifiedAt,
  lastAttemptAt: verification.lastAttemptAt,
  lastError: verification.lastErrorCode ? { code: verification.lastErrorCode, message: verification.lastErrorMessage } : null,
  monitoring: {
    enabled: verification.monitoringEnabled,
    frequency: verification.verificationFrequency,
    nextVerificationAt: verification.nextVerificationAt,
  },
  createdAt: verification.createdAt,
  updatedAt: verification.updatedAt,
});

const findOwned = async (userId, id, db = prisma) => {
  const verification = await db.landVerification.findFirst({ where: { id, userId } });
  if (!verification) throw notFound('Land verification not found', 'LAND_VERIFICATION_NOT_FOUND');
  return verification;
};

/** Find-or-create the parcel row; tolerant of two concurrent first verifications. */
const ensureVerification = async ({ userId, adapter, locator, parcelKey }) => {
  const where = { userId_stateCode_parcelKey: { userId, stateCode: adapter.stateCode, parcelKey } };
  const existing = await prisma.landVerification.findUnique({ where });
  if (existing) return existing;
  try {
    return await prisma.landVerification.create({
      data: {
        userId,
        stateCode: adapter.stateCode,
        provider: adapter.provider,
        parcelKey,
        locator,
        displayName: adapter.displayName(locator),
        status: 'PENDING',
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.landVerification.findUniqueOrThrow({ where });
    }
    throw error;
  }
};

/* ------------------------------ Failure path ----------------------------- */

const recordFailure = async (verification, error, trigger) => {
  const failures = verification.consecutiveFailures + 1;
  const now = new Date();
  const data = {
    lastAttemptAt: now,
    lastErrorCode: error?.code || 'VERIFICATION_FAILED',
    lastErrorMessage: String(error?.message || 'Verification failed').slice(0, 500),
    consecutiveFailures: failures,
    ...(verification.status === 'PENDING' ? { status: 'FAILED' } : {}),
    ...(trigger === 'SCHEDULED' ? { nextVerificationAt: failureRetryDate(failures, now), lockedUntil: null } : {}),
  };
  await prisma.landVerification.update({ where: { id: verification.id }, data });

  if (trigger !== 'SCHEDULED') return;
  // A previously verified record disappearing at the source is significant on its own.
  const vanished = error?.code === 'LAND_RECORD_NOT_FOUND' && verification.verificationCount > 0;
  if (vanished || failures === SCHEDULED_FAILURE_ALERT_THRESHOLD) {
    await alertsService.createAlert({
      userId: verification.userId,
      landVerificationId: verification.id,
      type: 'VERIFICATION_FAILED',
      severity: vanished ? 'CRITICAL' : 'WARNING',
      title: vanished ? 'Land record no longer found' : 'Scheduled verification failing',
      message: vanished
        ? `The provider no longer returns a record for ${verification.displayName}.`
        : `Scheduled verification of ${verification.displayName} failed ${failures} times in a row.`,
      data: { errorCode: data.lastErrorCode, consecutiveFailures: failures },
    });
  }
};

/* -------------------------------- Verify -------------------------------- */

/**
 * @param {object} params
 * @param {string} params.userId
 * @param {object} params.adapter     provider adapter
 * @param {object} params.locator     validated locator
 * @param {'MANUAL'|'SCHEDULED'} [params.trigger]
 */
const verify = async ({ userId, adapter, locator, trigger = 'MANUAL' }) => {
  const parcelKey = parcelKeyFor(adapter, locator);
  const known = await prisma.landVerification.findUnique({
    where: { userId_stateCode_parcelKey: { userId, stateCode: adapter.stateCode, parcelKey } },
  });

  let fetched;
  try {
    fetched = await adapter.fetchRecord(locator);
  } catch (error) {
    // Unknown parcels are not stored on failure (a typo should not create a tracked parcel).
    if (known) await recordFailure(known, error, trigger);
    throw error;
  }

  const verification = known || (await ensureVerification({ userId, adapter, locator, parcelKey }));
  const normalized = adapter.normalizeRecord(fetched.raw);
  const hash = hashRecord(normalized);
  const verifiedAt = new Date();

  const outcome = await prisma.$transaction(
    async (tx) => {
      // Serialize verifications of the same parcel (manual vs scheduled, double taps).
      await tx.$queryRaw`SELECT id FROM land_verifications WHERE id = ${verification.id}::uuid FOR UPDATE`;
      const current = await tx.landVerification.findUniqueOrThrow({ where: { id: verification.id } });
      const previous = await tx.landRecordSnapshot.findFirst({ where: { landVerificationId: verification.id }, orderBy: { sequence: 'desc' } });

      let changes = [];
      let snapshotStatus = 'INITIAL';
      if (previous) {
        // Re-normalize the stored raw response with today's rules, so normalizer or
        // ignore-list updates never show up as land-record changes.
        const previousNormalized = adapter.normalizeRecord(previous.rawResponse);
        changes = hashRecord(previousNormalized) === hash ? [] : diffRecords(previousNormalized, normalized, adapter.diffOptions);
        snapshotStatus = changes.length > 0 ? 'CHANGED' : 'UNCHANGED';
      }

      const snapshot = await tx.landRecordSnapshot.create({
        data: {
          landVerificationId: verification.id,
          sequence: (previous?.sequence || 0) + 1,
          provider: adapter.provider,
          providerReference: fetched.providerReference ? String(fetched.providerReference) : null,
          providerRequestId: fetched.providerRequestId || null,
          rawResponse: fetched.raw ?? {},
          normalizedData: normalized,
          normalizerVersion: adapter.normalizerVersion,
          hash,
          status: snapshotStatus,
          trigger,
          previousSnapshotId: previous?.id || null,
          changeCount: changes.length,
          verifiedAt,
        },
      });

      if (changes.length > 0) {
        await tx.landRecordChange.createMany({
          data: changes.map((change) => ({
            landVerificationId: verification.id,
            snapshotId: snapshot.id,
            previousSnapshotId: previous.id,
            type: change.type,
            field: change.field.slice(0, 500),
            oldValue: change.oldValue === null ? Prisma.JsonNull : change.oldValue,
            newValue: change.newValue === null ? Prisma.JsonNull : change.newValue,
            isCritical: change.isCritical,
          })),
        });
      }

      const smartContractRecord = await smartContractService.createPendingRecord(tx, {
        landVerificationId: verification.id,
        snapshotId: snapshot.id,
        dataHash: hash,
        propertyId: adapter.propertyId(locator),
      });

      let alert = null;
      if (snapshotStatus === 'CHANGED') {
        const summary = summarize(changes);
        alert = await alertsService.createAlert(
          {
            userId,
            landVerificationId: verification.id,
            snapshotId: snapshot.id,
            type: 'LAND_RECORD_CHANGED',
            severity: summary.critical > 0 ? 'CRITICAL' : 'WARNING',
            title: 'Land record changed',
            message: `${summary.total} change(s) detected in ${current.displayName} since the previous verification.`,
            data: { summary, fields: changes.slice(0, MAX_ALERT_FIELDS).map((change) => ({ type: change.type, field: change.field })) },
          },
          tx,
        );
      }

      // Push for every completed verification (good news included), committed with the snapshot.
      const summary = summarize(changes);
      const message = notificationsService.landVerificationMessage({
        snapshotStatus,
        displayName: current.displayName,
        summary,
        previousVerifiedAt: previous?.verifiedAt || null,
      });
      const notification = await notificationsService.enqueue(tx, {
        userId,
        ...message,
        landVerificationId: verification.id,
        snapshotId: snapshot.id,
        data: {
          screen: 'LAND_COMPARISON',
          verificationId: verification.id,
          snapshotId: snapshot.id,
          status: snapshotStatus,
          changes: summary.total,
          critical: summary.critical,
        },
      });

      const updated = await tx.landVerification.update({
        where: { id: verification.id },
        data: {
          status: snapshotStatusToVerificationStatus[snapshotStatus],
          latestSnapshotId: snapshot.id,
          verificationCount: { increment: 1 },
          changeCount: { increment: changes.length },
          firstVerifiedAt: current.firstVerifiedAt || verifiedAt,
          lastVerifiedAt: verifiedAt,
          lastAttemptAt: verifiedAt,
          lastErrorCode: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
          lockedUntil: null,
          ...(current.monitoringEnabled && current.verificationFrequency
            ? { nextVerificationAt: nextVerificationDate(current.verificationFrequency, verifiedAt) }
            : {}),
        },
      });

      return { verification: updated, previous, snapshot, changes, smartContractRecord, alert, notification };
    },
    { timeout: 20000 },
  );

  if (outcome.alert) alertsService.notify(outcome.alert);
  notificationsService.sendSoon(outcome.notification.id);
  logger.info(
    { verificationId: verification.id, snapshotId: outcome.snapshot.id, status: outcome.snapshot.status, changes: outcome.changes.length, trigger },
    'land record verified',
  );

  let smartContract = outcome.smartContractRecord;
  if (config.smartContract.inlineSubmit && smartContract.status === 'PENDING') {
    try {
      smartContract = await smartContractService.processRecord(smartContract.id);
    } catch (error) {
      // The retry job picks the record up; the verification itself already succeeded.
      logger.error({ err: error, recordId: smartContract.id }, 'inline smart contract submission crashed');
    }
  }

  return {
    verificationId: outcome.verification.id,
    status: outcome.verification.status,
    snapshotStatus: outcome.snapshot.status,
    isFirstVerification: !outcome.previous,
    previousVerification: outcome.previous?.id || null,
    currentVerification: outcome.snapshot.id,
    previousVerifiedAt: outcome.previous?.verifiedAt || null,
    verifiedAt: outcome.snapshot.verifiedAt,
    sequence: outcome.snapshot.sequence,
    hash: outcome.snapshot.hash,
    changes: outcome.changes.map((change) => ({
      type: change.type,
      field: change.field,
      previousValue: change.oldValue,
      currentValue: change.newValue,
      isCritical: change.isCritical,
    })),
    changeSummary: summarize(outcome.changes),
    record: normalized,
    source: { state: adapter.stateCode, provider: adapter.provider, reference: outcome.snapshot.providerReference },
    smartContract: {
      recordId: smartContract.id,
      status: smartContract.status,
      reference: smartContract.externalReference || smartContract.transactionHash || null,
      transactionHash: smartContract.transactionHash || null,
    },
    alertId: outcome.alert?.id || null,
    notificationId: outcome.notification.id,
  };
};

/** Re-verify a stored parcel (used by the scheduler). */
const reverify = async (verificationId, trigger = 'SCHEDULED') => {
  const verification = await prisma.landVerification.findUniqueOrThrow({ where: { id: verificationId } });
  const adapter = registry.getAdapterByStateCode(verification.stateCode);
  return verify({ userId: verification.userId, adapter, locator: verification.locator, trigger });
};

/* -------------------------------- Queries -------------------------------- */

const listVerifications = async (userId, { skip, limit }) => {
  const where = { userId };
  const [items, total] = await Promise.all([
    prisma.landVerification.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take: limit }),
    prisma.landVerification.count({ where }),
  ]);
  return { verifications: items.map(publicVerification), total };
};

const getVerification = async (userId, id) => {
  const verification = await findOwned(userId, id);
  const latest = verification.latestSnapshotId
    ? await prisma.landRecordSnapshot.findUnique({ where: { id: verification.latestSnapshotId }, include: { smartContractRecord: true } })
    : null;
  const latestChanges = latest && latest.changeCount > 0 ? await prisma.landRecordChange.findMany({ where: { snapshotId: latest.id }, orderBy: { field: 'asc' } }) : [];
  return {
    verification: publicVerification(verification),
    latestSnapshot: latest ? publicSnapshot(latest) : null,
    latestChanges: latestChanges.map(publicChange),
  };
};

const getHistory = async (userId, id, { skip, limit }) => {
  await findOwned(userId, id);
  const where = { landVerificationId: id };
  const [items, total] = await Promise.all([
    prisma.landRecordSnapshot.findMany({ where, orderBy: { sequence: 'desc' }, skip, take: limit, include: { smartContractRecord: true } }),
    prisma.landRecordSnapshot.count({ where }),
  ]);
  return { snapshots: items.map((item) => publicSnapshot(item)), total };
};

const getSnapshot = async (userId, id, snapshotId) => {
  await findOwned(userId, id);
  const snapshot = await prisma.landRecordSnapshot.findFirst({ where: { id: snapshotId, landVerificationId: id }, include: { smartContractRecord: true } });
  if (!snapshot) throw notFound('Snapshot not found', 'SNAPSHOT_NOT_FOUND');
  const changes = await prisma.landRecordChange.findMany({ where: { snapshotId }, orderBy: { field: 'asc' } });
  return { snapshot: publicSnapshot(snapshot, { includeRaw: true }), changes: changes.map(publicChange) };
};

const getChanges = async (userId, id, { skip, limit, snapshotId, criticalOnly }) => {
  await findOwned(userId, id);
  const where = { landVerificationId: id, ...(snapshotId ? { snapshotId } : {}), ...(criticalOnly ? { isCritical: true } : {}) };
  const [items, total] = await Promise.all([
    prisma.landRecordChange.findMany({ where, orderBy: [{ createdAt: 'desc' }, { field: 'asc' }], skip, take: limit }),
    prisma.landRecordChange.count({ where }),
  ]);
  return { changes: items.map(publicChange), total };
};

/**
 * One verification result laid out for a mobile screen: a headline (same text as
 * the push), the previous record (`old`), the new record (`new`) and the list of
 * differences with readable labels, critical ones first.
 *
 * `old` is the previous snapshot normalized with the adapter's rules, exactly as
 * verify compared it, so old / new / changes always agree.
 */
const getComparison = async (userId, id, { snapshotId } = {}) => {
  const verification = await findOwned(userId, id);
  const current = await prisma.landRecordSnapshot.findFirst({
    where: { landVerificationId: id, ...(snapshotId ? { id: snapshotId } : {}) },
    orderBy: { sequence: 'desc' },
  });
  if (!current) throw notFound('Snapshot not found', 'SNAPSHOT_NOT_FOUND');

  const [previous, changeRows] = await Promise.all([
    current.previousSnapshotId ? prisma.landRecordSnapshot.findUnique({ where: { id: current.previousSnapshotId } }) : null,
    prisma.landRecordChange.findMany({ where: { snapshotId: current.id } }),
  ]);

  let oldRecord = previous?.normalizedData ?? null;
  if (previous) {
    try {
      oldRecord = registry.getAdapterByStateCode(verification.stateCode).normalizeRecord(previous.rawResponse);
    } catch (error) {
      logger.warn({ verificationId: id, err: error.message }, 'comparison: re-normalizing previous snapshot failed; using stored data');
    }
  }

  const summary = summarize(changeRows);
  const message = notificationsService.landVerificationMessage({
    snapshotStatus: current.status,
    displayName: verification.displayName,
    summary,
    previousVerifiedAt: previous?.verifiedAt || null,
  });
  const changes = changeRows
    .map((change) => ({
      field: change.field,
      ...describeField(change.field),
      type: change.type,
      oldValue: change.oldValue ?? null,
      newValue: change.newValue ?? null,
      isCritical: change.isCritical,
    }))
    .sort((a, b) => Number(b.isCritical) - Number(a.isCritical) || a.field.localeCompare(b.field));

  return {
    verificationId: verification.id,
    land: { displayName: verification.displayName, state: verification.stateCode, locator: verification.locator },
    snapshotId: current.id,
    sequence: current.sequence,
    status: current.status,
    hasChanges: changes.length > 0,
    headline: { title: message.title, body: message.body },
    verifiedAt: current.verifiedAt,
    previousVerifiedAt: previous?.verifiedAt || null,
    summary,
    old: previous ? { snapshotId: previous.id, verifiedAt: previous.verifiedAt, record: oldRecord } : null,
    new: { snapshotId: current.id, verifiedAt: current.verifiedAt, record: current.normalizedData },
    changes,
  };
};

/* ------------------------------- Monitoring ------------------------------- */

/**
 * Enables/disables recurring verification for a parcel.
 * @param {object} subscription the caller's active subscription (with plan)
 */
const configureMonitoring = async (userId, id, { enabled, frequency }, subscription) => {
  const verification = await findOwned(userId, id);
  if (!enabled) {
    const updated = await prisma.landVerification.update({
      where: { id },
      data: { monitoringEnabled: false, nextVerificationAt: null },
    });
    return publicVerification(updated);
  }

  const plan = subscription.plan;
  if (plan.allowedFrequencies.length > 0 && !plan.allowedFrequencies.includes(frequency)) {
    throw forbidden(`Your plan does not include ${frequency.toLowerCase()} verification`, 'FREQUENCY_NOT_IN_PLAN', {
      allowedFrequencies: plan.allowedFrequencies,
    });
  }
  if (plan.maxMonitoredLands !== null && !verification.monitoringEnabled) {
    const monitored = await prisma.landVerification.count({ where: { userId, monitoringEnabled: true } });
    if (monitored >= plan.maxMonitoredLands) {
      throw forbidden(`Your plan allows monitoring up to ${plan.maxMonitoredLands} land record(s)`, 'MONITORING_LIMIT_REACHED');
    }
  }
  if (!verification.lastVerifiedAt) {
    throw unprocessable('Verify the land record once before enabling monitoring', undefined, 'NOT_VERIFIED_YET');
  }

  const now = new Date();
  const next = nextVerificationDate(frequency, verification.lastVerifiedAt);
  const updated = await prisma.landVerification.update({
    where: { id },
    data: { monitoringEnabled: true, verificationFrequency: frequency, nextVerificationAt: next < now ? now : next, consecutiveFailures: 0 },
  });
  return publicVerification(updated);
};

module.exports = {
  verify,
  reverify,
  listVerifications,
  getVerification,
  getHistory,
  getSnapshot,
  getChanges,
  getComparison,
  configureMonitoring,
  publicVerification,
  __testing: { parcelKeyFor, recordFailure },
};
