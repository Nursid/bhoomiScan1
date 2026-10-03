/**
 * Smart contract anchoring of land-record snapshots.
 *
 *   LandVerificationService -> SmartContractService -> SmartContractProvider -> external API / chain
 *
 * Resilient by design: the land verification and snapshot are committed first and
 * a SmartContractRecord is created PENDING in the same transaction. Submission
 * happens afterwards (inline once, then by the retry job), so a smart-contract
 * outage never loses or fails a land verification.
 *
 * Status flow
 *   PENDING -> PROCESSING -> STORED
 *                         -> ALREADY_STORED       (hash already anchored; reference reused)
 *                         -> FAILED (nextRetryAt) -> PROCESSING ...
 *                         -> PERMANENTLY_FAILED   (non-retryable or attempts exhausted; alert raised)
 *   SKIPPED when the provider is disabled.
 *
 * Multi-instance safe: a record is claimed with a conditional update + lease
 * (lockedUntil) before the provider is called.
 */

const config = require('../../config');
const { prisma } = require('../../database/prisma');
const logger = require('../../utils/logger');
const { addSeconds } = require('../../utils/dates');
const { notFound, conflict } = require('../../utils/errors');
const { getSmartContractProvider } = require('../../integrations/smart-contract');
const alertsService = require('../alerts/alerts.service');

const LEASE_SECONDS = 180;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;

const backoffSeconds = (attempts) => Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_SECONDS);

const publicRecord = (record) =>
  record
    ? {
        id: record.id,
        snapshotId: record.snapshotId,
        provider: record.provider,
        status: record.status,
        dataHash: record.dataHash,
        propertyId: record.propertyId,
        reference: record.externalReference || record.transactionHash || null,
        externalReference: record.externalReference,
        transactionHash: record.transactionHash,
        network: record.network,
        contractAddress: record.contractAddress,
        blockNumber: record.blockNumber,
        attempts: record.attempts,
        nextRetryAt: record.nextRetryAt,
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
        storedAt: record.storedAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }
    : null;

/** Called inside the land-verification transaction. */
const createPendingRecord = async (tx, { landVerificationId, snapshotId, dataHash, propertyId }) => {
  const provider = getSmartContractProvider();
  const enabled = provider.name !== 'DISABLED';
  return tx.smartContractRecord.create({
    data: {
      landVerificationId,
      snapshotId,
      provider: provider.name,
      dataHash,
      propertyId,
      status: enabled ? 'PENDING' : 'SKIPPED',
      requestReference: snapshotId,
      maxAttempts: config.smartContract.maxAttempts,
      nextRetryAt: enabled ? new Date() : null,
    },
  });
};

const claim = async (recordId) => {
  const now = new Date();
  const { count } = await prisma.smartContractRecord.updateMany({
    where: {
      id: recordId,
      OR: [
        { status: { in: ['PENDING', 'FAILED'] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        // A worker died mid-call: its lease has expired.
        { status: 'PROCESSING', lockedUntil: { lt: now } },
      ],
    },
    data: { status: 'PROCESSING', lockedUntil: addSeconds(now, LEASE_SECONDS), attempts: { increment: 1 }, lastAttemptAt: now },
  });
  return count === 1;
};

const markFailure = async (record, error) => {
  const retryable = Boolean(error?.retryable);
  const exhausted = record.attempts >= record.maxAttempts;
  const permanent = !retryable || exhausted;
  const updated = await prisma.smartContractRecord.update({
    where: { id: record.id },
    data: {
      status: permanent ? 'PERMANENTLY_FAILED' : 'FAILED',
      errorCode: error?.code || 'SMART_CONTRACT_ERROR',
      errorMessage: String(error?.providerMessage || error?.message || 'Unknown error').slice(0, 1000),
      nextRetryAt: permanent ? null : addSeconds(new Date(), backoffSeconds(record.attempts)),
      lockedUntil: null,
    },
  });
  logger.warn({ recordId: record.id, attempts: record.attempts, code: updated.errorCode, permanent }, 'smart contract submission failed');

  if (permanent) {
    const verification = await prisma.landVerification.findUnique({ where: { id: record.landVerificationId }, select: { userId: true } });
    await alertsService.createAlert({
      userId: verification.userId,
      landVerificationId: record.landVerificationId,
      snapshotId: record.snapshotId,
      type: 'SMART_CONTRACT_FAILED',
      severity: 'WARNING',
      title: 'Record could not be anchored',
      message: 'The land record was verified and saved, but storing it on the smart contract failed. It can be retried.',
      data: { smartContractRecordId: record.id, errorCode: updated.errorCode },
    });
  }
  return updated;
};

/**
 * Claims and submits one record. Returns the record's latest state. Never throws
 * for provider failures (they are recorded on the row).
 */
const processRecord = async (recordId) => {
  if (!(await claim(recordId))) {
    return prisma.smartContractRecord.findUnique({ where: { id: recordId } });
  }
  const record = await prisma.smartContractRecord.findUnique({ where: { id: recordId }, include: { snapshot: true } });
  const provider = getSmartContractProvider();

  // Identical content anchored before (any parcel): reuse instead of paying again.
  const existing = await prisma.smartContractRecord.findFirst({
    where: { dataHash: record.dataHash, provider: record.provider, status: 'STORED', id: { not: record.id } },
    orderBy: { storedAt: 'asc' },
  });
  if (existing) {
    return prisma.smartContractRecord.update({
      where: { id: record.id },
      data: {
        status: 'ALREADY_STORED',
        externalReference: existing.externalReference,
        transactionHash: existing.transactionHash,
        network: existing.network,
        contractAddress: existing.contractAddress,
        blockNumber: existing.blockNumber,
        response: { reusedFromRecordId: existing.id },
        storedAt: existing.storedAt,
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
        lockedUntil: null,
      },
    });
  }

  try {
    const result = await provider.store({
      referenceId: record.snapshotId,
      dataHash: record.dataHash,
      propertyId: record.propertyId,
      record: record.snapshot.normalizedData,
      metadata: {
        landVerificationId: record.landVerificationId,
        snapshotId: record.snapshotId,
        sequence: record.snapshot.sequence,
        verifiedAt: record.snapshot.verifiedAt,
        provider: record.snapshot.provider,
        normalizerVersion: record.snapshot.normalizerVersion,
      },
    });
    const stored = await prisma.smartContractRecord.update({
      where: { id: record.id },
      data: {
        status: 'STORED',
        externalReference: result.externalReference ? String(result.externalReference) : null,
        transactionHash: result.transactionHash || null,
        network: result.network || null,
        contractAddress: result.contractAddress || null,
        blockNumber: result.blockNumber || null,
        response: result.response ?? undefined,
        storedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
        lockedUntil: null,
      },
    });
    logger.info({ recordId: record.id, tx: stored.transactionHash, ref: stored.externalReference }, 'smart contract record stored');
    return stored;
  } catch (error) {
    if (error?.code === 'SMART_CONTRACT_DUPLICATE') {
      return prisma.smartContractRecord.update({
        where: { id: record.id },
        data: { status: 'ALREADY_STORED', storedAt: new Date(), errorCode: null, errorMessage: null, nextRetryAt: null, lockedUntil: null },
      });
    }
    return markFailure(record, error);
  }
};

/** Retry job: due PENDING/FAILED records and PROCESSING ones whose lease expired. */
const processDueRecords = async (limit = config.jobs.batchSize) => {
  const now = new Date();
  const due = await prisma.smartContractRecord.findMany({
    where: {
      OR: [
        { status: { in: ['PENDING', 'FAILED'] }, nextRetryAt: { lte: now } },
        { status: 'PROCESSING', lockedUntil: { lt: now } },
      ],
    },
    select: { id: true },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
  });
  let stored = 0;
  for (const { id } of due) {
    const result = await processRecord(id);
    if (result && ['STORED', 'ALREADY_STORED'].includes(result.status)) stored += 1;
  }
  return { processed: due.length, stored };
};

const findOwnedRecord = async (userId, recordId) => {
  const record = await prisma.smartContractRecord.findFirst({ where: { id: recordId, landVerification: { userId } } });
  if (!record) throw notFound('Smart contract record not found', 'SMART_CONTRACT_RECORD_NOT_FOUND');
  return record;
};

/** Manual retry by the owner (e.g. after credentials were fixed). */
const retryRecord = async (userId, recordId) => {
  const record = await findOwnedRecord(userId, recordId);
  if (!['FAILED', 'PERMANENTLY_FAILED'].includes(record.status)) {
    throw conflict('Only failed records can be retried', { status: record.status }, 'SMART_CONTRACT_NOT_RETRYABLE');
  }
  await prisma.smartContractRecord.update({
    where: { id: record.id },
    data: { status: 'PENDING', attempts: 0, nextRetryAt: new Date(), lockedUntil: null },
  });
  return publicRecord(await processRecord(record.id));
};

const listForVerification = async (userId, landVerificationId) => {
  const verification = await prisma.landVerification.findFirst({ where: { id: landVerificationId, userId }, select: { id: true } });
  if (!verification) throw notFound('Land verification not found', 'LAND_VERIFICATION_NOT_FOUND');
  const records = await prisma.smartContractRecord.findMany({ where: { landVerificationId }, orderBy: { createdAt: 'desc' } });
  return records.map(publicRecord);
};

const getRecord = async (userId, recordId) => publicRecord(await findOwnedRecord(userId, recordId));

module.exports = {
  createPendingRecord,
  processRecord,
  processDueRecords,
  retryRecord,
  listForVerification,
  getRecord,
  publicRecord,
  __testing: { backoffSeconds },
};
