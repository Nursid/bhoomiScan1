const { createHash, randomUUID } = require('crypto');
const config = require('../../config');
const { prisma } = require('../../database/prisma');
const { getSmartContractProvider } = require('../../integrations/smart-contract');
const stratus = require('../../integrations/stratus/stratus.client');
const { ProviderError, notFound, conflict, serviceUnavailable } = require('../../utils/errors');
const { addSeconds } = require('../../utils/dates');

const LEASE_SECONDS = 180;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;
// Retain known results during a database outage so this process retries only
// persistence. Once the hash checkpoint is saved, recovery also survives restart.
const pendingReceipts = new Map();
const hashFile = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const backoffSeconds = (attempts) => Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_SECONDS);

const assertDuplicateSeries = (document, lineage) => {
  if (lineage.documentSeriesId && document.documentSeriesId !== lineage.documentSeriesId) {
    throw conflict('These file bytes already belong to a different document series', undefined, 'DOCUMENT_VERSION_CONFLICT');
  }
};

const toPublic = (document) => ({
  id: document.id,
  documentSeriesId: document.documentSeriesId,
  versionNumber: document.versionNumber,
  previousVersionId: document.previousVersionId,
  fileName: document.fileName,
  contentType: document.contentType,
  sizeBytes: document.sizeBytes,
  dataHash: document.dataHash,
  status: document.status,
  transactionHash: document.transactionHash,
  network: document.network,
  chainId: document.chainId,
  contractAddress: document.contractAddress,
  signerAddress: document.signerAddress,
  blockNumber: document.blockNumber,
  verificationId: document.verificationId,
  attempts: document.attempts,
  nextRetryAt: document.nextRetryAt,
  errorCode: document.errorCode,
  createdAt: document.createdAt,
});

const assertTestnetProvider = (provider, { write = false } = {}) => {
  const { bsc } = config.smartContract;
  if (config.smartContract.provider !== 'bsc' || provider.name !== 'BSC' || bsc.chainId !== 97) {
    throw new ProviderError(503, 'SMART_CONTRACT_TESTNET_ONLY', 'Document blockchain operations require the configured BSC testnet provider', { provider: 'SMART_CONTRACT' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(bsc.contractAddress)) {
    throw new ProviderError(503, 'SMART_CONTRACT_NOT_CONFIGURED', 'A deployed BSC testnet contract address is required', { provider: 'SMART_CONTRACT' });
  }
  if (write && !provider.isConfigured()) {
    throw new ProviderError(503, 'SMART_CONTRACT_NOT_CONFIGURED', 'A valid authorized testnet operator key is required for registration', { provider: 'SMART_CONTRACT' });
  }
};

const markStored = async (document, result, status = 'STORED') => prisma.uploadedDocument.update({
  where: { id: document.id },
  data: {
    status,
    transactionHash: result.transactionHash || document.transactionHash || null,
    network: result.network || 'bsc-testnet',
    chainId: result.chainId ?? document.chainId ?? null,
    contractAddress: result.contractAddress || config.smartContract.bsc.contractAddress,
    signerAddress: result.signerAddress || null,
    blockNumber: result.blockNumber || null,
    verificationId: result.externalReference ? String(result.externalReference) : null,
    errorCode: null,
    nextRetryAt: null,
    lockedUntil: null,
  },
});

const persistReceipt = async (document, result, status = 'STORED') => {
  pendingReceipts.set(document.id, { result, status });
  const transactionHash = result.transactionHash || document.transactionHash || null;
  const chainId = result.chainId ?? document.chainId ?? null;
  try {
    const stored = await markStored(document, result, status);
    pendingReceipts.delete(document.id);
    return stored;
  } catch {
    // The final write may have committed even if its response was lost.
    const stored = await prisma.uploadedDocument.findUnique({ where: { id: document.id } }).catch(() => null);
    if (stored?.status === status && stored.dataHash === document.dataHash
      && stored.transactionHash === transactionHash && stored.chainId === chainId) {
      pendingReceipts.delete(document.id);
      return stored;
    }
    try {
      // Never classify an already-successful chain call as a failed registration.
      return await prisma.uploadedDocument.update({
        where: { id: document.id },
        data: {
          status: 'PENDING', transactionHash, chainId,
          network: result.network || document.network || 'bsc-testnet',
          contractAddress: result.contractAddress || document.contractAddress || config.smartContract.bsc.contractAddress,
          errorCode: 'DOCUMENT_RECEIPT_PERSIST_FAILED',
          nextRetryAt: addSeconds(new Date(), backoffSeconds(document.attempts)), lockedUntil: null,
        },
      });
    } catch {
      // Keep the receipt in memory even when the checkpoint cannot be saved.
      throw new ProviderError(503, 'DOCUMENT_RECEIPT_PERSIST_FAILED', 'Registration succeeded; receipt persistence will be retried', {
        provider: 'SMART_CONTRACT', retryable: true, meta: { transactionHash, chainId },
      });
    }
  }
};

const processDocument = async (documentId) => {
  const now = new Date();
  const claimResult = await prisma.uploadedDocument.updateMany({
    where: {
      id: documentId,
      OR: [
        { status: { in: ['PENDING', 'FAILED'] }, AND: [{ OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] }, { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] }] },
        { status: 'PROCESSING', lockedUntil: { lt: now } },
      ],
    },
    data: { status: 'PROCESSING', lockedUntil: addSeconds(now, LEASE_SECONDS), lastAttemptAt: now, attempts: { increment: 1 } },
  });
  if (claimResult.count !== 1) {
    const existing = await prisma.uploadedDocument.findUnique({ where: { id: documentId } });
    if (existing && ['STORED', 'ALREADY_STORED', 'REVOKED'].includes(existing.status)) pendingReceipts.delete(documentId);
    return existing;
  }

  const document = await prisma.uploadedDocument.findUnique({ where: { id: documentId } });
  const pendingReceipt = pendingReceipts.get(documentId);
  if (pendingReceipt) return persistReceipt(document, pendingReceipt.result, pendingReceipt.status);
  const provider = getSmartContractProvider();
  try {
    assertTestnetProvider(provider, { write: true });
    const result = await provider.store({ dataHash: document.dataHash, transactionHash: document.transactionHash || undefined });
    return persistReceipt(document, result);
  } catch (error) {
    if (error?.code === 'SMART_CONTRACT_DUPLICATE' && typeof provider.verify === 'function') {
      try {
        const verified = await provider.verify({ dataHash: document.dataHash });
        if (verified.exists) {
          return persistReceipt(document, {
            network: verified.network,
            chainId: verified.chainId,
            contractAddress: verified.contractAddress,
            externalReference: verified.verificationId,
          }, verified.isValid ? 'ALREADY_STORED' : 'REVOKED');
        }
      } catch {
        // Preserve the provider failure below; the read-only fallback is best-effort.
      }
    }

    const awaitingReceipt = error?.code === 'SMART_CONTRACT_TX_PENDING';
    const reverted = error?.code === 'SMART_CONTRACT_TX_REVERTED' || (error?.receipt?.status !== undefined && BigInt(error.receipt.status) === 0n);
    const exhausted = document.attempts >= document.maxAttempts;
    const permanent = reverted || !error?.retryable || exhausted;
    const retryAt = permanent && !awaitingReceipt ? null : addSeconds(new Date(), backoffSeconds(document.attempts));
    return prisma.uploadedDocument.update({
      where: { id: document.id },
      data: {
        status: awaitingReceipt ? 'PENDING' : permanent ? 'PERMANENTLY_FAILED' : 'FAILED',
        transactionHash: error?.meta?.transactionHash || document.transactionHash || null,
        chainId: error?.meta?.chainId ?? document.chainId ?? null,
        errorCode: error?.code || 'SMART_CONTRACT_ERROR',
        nextRetryAt: retryAt,
        lockedUntil: null,
      },
    });
  }
};

const registerDocument = async (userId, { bytes, fileName, contentType }, lineage = {}) => {
  const dataHash = hashFile(bytes);
  let document = await prisma.uploadedDocument.findUnique({ where: { userId_dataHash: { userId, dataHash } } });
  if (document) {
    assertDuplicateSeries(document, lineage);
    return toPublic(document);
  }

  const documentId = randomUUID();
  const storageObjectKey = `documents/${userId}/${documentId}`;
  try {
    await stratus.upload({ key: storageObjectKey, bytes, contentType });
  } catch (error) {
    // A timed-out PUT may have reached Stratus; this key is unique to this attempt.
    await stratus.deleteUnreferenced(storageObjectKey).catch(() => {});
    throw error;
  }

  try {
    document = await prisma.uploadedDocument.create({
      data: {
        id: documentId,
        userId,
        documentSeriesId: lineage.documentSeriesId || randomUUID(),
        versionNumber: lineage.versionNumber || 1,
        previousVersionId: lineage.previousVersionId || null,
        fileName,
        contentType,
        sizeBytes: bytes.length,
        dataHash,
        storageObjectKey,
        status: 'PENDING',
        nextRetryAt: new Date(),
      },
    });
  } catch (error) {
    if (!['P2002', 'P2003'].includes(error?.code)) {
      // A lost response does not prove the INSERT rolled back. Never delete a
      // possibly referenced object; even a negative lookup may precede commit.
      const persisted = await prisma.uploadedDocument.findUnique({ where: { id: documentId } }).catch(() => null);
      if (persisted) return toPublic(await processDocument(persisted.id));
      throw error;
    }
    // Unique/FK constraint rejection means this attempt did not insert a row.
    await stratus.deleteUnreferenced(storageObjectKey).catch(() => {});
    if (error?.code !== 'P2002') throw error;
    document = await prisma.uploadedDocument.findUnique({ where: { userId_dataHash: { userId, dataHash } } });
    if (!document && lineage.previousVersionId) {
      throw conflict('A newer version already exists for this document', undefined, 'DOCUMENT_VERSION_CONFLICT');
    }
    if (!document) throw error;
    assertDuplicateSeries(document, lineage);
    return toPublic(document);
  }
  return toPublic(await processDocument(document.id));
};

const register = (userId, file) => registerDocument(userId, file);

const registerVersion = async (userId, previousVersionId, file) => {
  const previous = await prisma.uploadedDocument.findFirst({ where: { id: previousVersionId, userId } });
  if (!previous) throw notFound('Document version not found', 'DOCUMENT_NOT_FOUND');

  const latest = await prisma.uploadedDocument.findFirst({
    where: { userId, documentSeriesId: previous.documentSeriesId },
    orderBy: { versionNumber: 'desc' },
  });
  if (!latest || latest.id !== previous.id) {
    throw conflict('A new version must be based on the latest version', undefined, 'DOCUMENT_VERSION_CONFLICT');
  }

  return registerDocument(userId, file, {
    documentSeriesId: previous.documentSeriesId,
    versionNumber: previous.versionNumber + 1,
    previousVersionId: previous.id,
  });
};

const listVersions = async (userId, documentId) => {
  const document = await prisma.uploadedDocument.findFirst({ where: { id: documentId, userId } });
  if (!document) throw notFound('Document version not found', 'DOCUMENT_NOT_FOUND');
  const versions = await prisma.uploadedDocument.findMany({
    where: { userId, documentSeriesId: document.documentSeriesId },
    orderBy: { versionNumber: 'asc' },
  });
  return versions.map(toPublic);
};

const list = async (userId) => {
  const documents = await prisma.uploadedDocument.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  return documents.map(toPublic);
};

const retrieveFile = async (userId, id) => {
  const document = await prisma.uploadedDocument.findFirst({ where: { id, userId } });
  if (!document) throw notFound('Document file not found', 'DOCUMENT_NOT_FOUND');
  if (!document.storageObjectKey) throw serviceUnavailable('Original document file is unavailable', 'DOCUMENT_FILE_UNAVAILABLE');
  const bytes = await stratus.download({ key: document.storageObjectKey, expectedSize: document.sizeBytes });
  if (hashFile(bytes) !== document.dataHash) throw serviceUnavailable('Stored document integrity check failed', 'DOCUMENT_FILE_HASH_MISMATCH');
  return { bytes, fileName: document.fileName, contentType: document.contentType, sizeBytes: document.sizeBytes };
};

const verifyBytes = async (bytes) => {
  const provider = getSmartContractProvider();
  assertTestnetProvider(provider);
  if (typeof provider.verify !== 'function') throw serviceUnavailable('Read-only on-chain verification is unavailable', 'SMART_CONTRACT_VERIFY_UNAVAILABLE');
  const dataHash = hashFile(bytes);
  return { dataHash, onChain: await provider.verify({ dataHash }) };
};

const verify = async (userId, id) => {
  const document = await prisma.uploadedDocument.findFirst({ where: { id, userId } });
  if (!document) throw notFound('Document registration not found', 'DOCUMENT_NOT_FOUND');
  const provider = getSmartContractProvider();
  assertTestnetProvider(provider);
  if (typeof provider.verify !== 'function') throw serviceUnavailable('Read-only on-chain verification is unavailable', 'SMART_CONTRACT_VERIFY_UNAVAILABLE');
  const onChain = await provider.verify({ dataHash: document.dataHash });
  const alreadyFinal = document.status === 'STORED' || document.status === 'ALREADY_STORED';
  if (onChain.exists && alreadyFinal) {
    if (onChain.chainId != null && document.chainId !== onChain.chainId) {
      const updated = await prisma.uploadedDocument.update({
        where: { id: document.id },
        data: { chainId: onChain.chainId },
      });
      return { document: toPublic(updated), onChain };
    }
    return { document: toPublic(document), onChain };
  }
  if (onChain.exists && document.status !== 'STORED' && document.status !== 'ALREADY_STORED') {
    const updated = await prisma.uploadedDocument.update({
      where: { id: document.id },
      data: {
        status: onChain.isValid ? 'STORED' : 'REVOKED',
        network: onChain.network,
        contractAddress: onChain.contractAddress,
        verificationId: onChain.verificationId,
        signerAddress: onChain.registeredBy,
        chainId: onChain.chainId ?? document.chainId ?? null,
        errorCode: null,
        nextRetryAt: null,
        lockedUntil: null,
      },
    });
    return { document: toPublic(updated), onChain };
  }
  return { document: toPublic(document), onChain };
};

const processDueDocuments = async (limit = config.jobs.batchSize) => {
  const now = new Date();
  const due = await prisma.uploadedDocument.findMany({
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
  let completed = 0;
  for (const { id } of due) {
    const result = await processDocument(id);
    if (result && ['STORED', 'ALREADY_STORED'].includes(result.status)) completed += 1;
  }
  return { processed: due.length, completed };
};

module.exports = { hashFile, register, registerVersion, list, listVersions, retrieveFile, verify, verifyBytes, processDocument, processDueDocuments, __testing: { toPublic, backoffSeconds, assertTestnetProvider, resetPendingReceipts: () => pendingReceipts.clear() } };
