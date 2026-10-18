jest.mock('../../src/config', () => ({
  smartContract: { provider: 'bsc', maxAttempts: 4, bsc: { chainId: 97, contractAddress: `0x${'1'.repeat(40)}` } },
  jobs: { batchSize: 20 },
  jwt: { secret: 'focused-unit-test-jwt-secret-at-least-32-characters', issuer: 'bhoomiscan-api', expiresIn: '7d', isConfigured: true },
  stratus: {
    bucketName: 'bhoomiscan-documents', bucketUrl: 'https://bhoomiscan-documents-development.zohostratus.in',
    oauthClientId: 'mock-client', oauthClientSecret: 'mock-secret', oauthRefreshToken: 'mock-refresh',
    accountsUrl: 'https://accounts.zoho.in', timeoutMs: 1000, maxFileBytes: 10 * 1024 * 1024,
  },
}));
jest.mock('../../src/database/prisma', () => ({
  prisma: { user: { findUnique: jest.fn() }, uploadedDocument: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() } },
}));
jest.mock('../../src/integrations/smart-contract', () => ({ getSmartContractProvider: jest.fn() }));
jest.mock('../../src/integrations/stratus/stratus.client', () => ({
  upload: jest.fn(), download: jest.fn(), deleteUnreferenced: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { prisma } = require('../../src/database/prisma');
const { getSmartContractProvider } = require('../../src/integrations/smart-contract');
const stratus = require('../../src/integrations/stratus/stratus.client');
const config = require('../../src/config');
const service = require('../../src/modules/documents/documents.service');
const { router, __testing } = require('../../src/modules/documents/documents.routes');
const { errorHandler } = require('../../src/middleware/errorHandler');
const { ProviderError } = require('../../src/utils/errors');

const owner = 'owner-1';
const txHash = `0x${'4'.repeat(64)}`;
const ownerId = '11111111-1111-4111-8111-111111111111';
const doc = (overrides = {}) => ({
  id: 'doc-1', userId: owner, fileName: 'title.pdf', contentType: 'application/pdf', sizeBytes: 12,
  documentSeriesId: 'series-1', versionNumber: 1, previousVersionId: null, chainId: null,
  dataHash: service.hashFile(Buffer.from('%PDF-example')), status: 'PENDING', transactionHash: null,
  storageObjectKey: 'documents/owner-1/doc-1',
  network: null, contractAddress: null, signerAddress: null, blockNumber: null, verificationId: null,
  attempts: 0, maxAttempts: 4, nextRetryAt: new Date(), createdAt: new Date(), ...overrides,
});

describe('uploaded document registration', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    service.__testing.resetPendingReceipts();
    stratus.upload.mockResolvedValue({ objectKey: 'documents/owner-1/doc-1' });
    stratus.deleteUnreferenced.mockResolvedValue(true);
    prisma.uploadedDocument.updateMany.mockResolvedValue({ count: 1 });
    getSmartContractProvider.mockReturnValue({ name: 'BSC', isConfigured: () => true, store: jest.fn(), verify: jest.fn() });
  });

  test('hashes actual uploaded bytes as SHA-256', () => {
    expect(service.hashFile(Buffer.from('%PDF-example'))).toBe('0x6b081077b62ba46e09c937ea190244f530db1e421f63cabe1508f8af6f183b31');
    expect(service.hashFile(Buffer.from('%PDF-example changed'))).not.toBe(service.hashFile(Buffer.from('%PDF-example')));
  });

  test('stores metadata and hash only, then records a successful registration', async () => {
    const bytes = Buffer.from('%PDF-example');
    prisma.uploadedDocument.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(doc());
    prisma.uploadedDocument.create.mockResolvedValue(doc());
    prisma.uploadedDocument.update.mockResolvedValue(doc({ status: 'STORED', transactionHash: txHash }));
    const provider = getSmartContractProvider();
    provider.store.mockResolvedValue({ transactionHash: txHash, network: 'bsc-testnet', chainId: 97, contractAddress: `0x${'1'.repeat(40)}`, signerAddress: `0x${'2'.repeat(40)}`, blockNumber: 12, externalReference: '5' });

    await service.register(owner, { bytes, fileName: 'title.pdf', contentType: 'application/pdf' });

    expect(stratus.upload).toHaveBeenCalledWith(expect.objectContaining({ bytes, contentType: 'application/pdf', key: expect.stringMatching(/^documents\/owner-1\//) }));
    expect(prisma.uploadedDocument.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: owner, dataHash: service.hashFile(bytes), sizeBytes: bytes.length, storageObjectKey: expect.stringMatching(/^documents\/owner-1\//) }) });
    expect(prisma.uploadedDocument.create.mock.calls[0][0].data).not.toHaveProperty('bytes');
    expect(provider.store).toHaveBeenCalledWith(expect.objectContaining({ dataHash: service.hashFile(bytes) }));
    expect(prisma.uploadedDocument.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'STORED', transactionHash: txHash, chainId: 97 }) }));
  });

  test('returns an existing same-owner hash without submitting a second transaction', async () => {
    const existing = doc({ status: 'STORED' });
    prisma.uploadedDocument.findUnique.mockResolvedValue(existing);
    await service.register(owner, { bytes: Buffer.from('%PDF-example'), fileName: 'copy.pdf', contentType: 'application/pdf' });
    expect(prisma.uploadedDocument.create).not.toHaveBeenCalled();
    expect(stratus.upload).not.toHaveBeenCalled();
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
  });

  test('does not create a document or register a hash when Stratus upload fails', async () => {
    prisma.uploadedDocument.findUnique.mockReset().mockResolvedValue(null);
    prisma.uploadedDocument.create.mockReset();
    stratus.upload.mockRejectedValue(new Error('storage unavailable'));
    await expect(service.register(owner, {
      bytes: Buffer.from('%PDF-storage-failure'), fileName: 'failed.pdf', contentType: 'application/pdf',
    })).rejects.toThrow('storage unavailable');
    expect(prisma.uploadedDocument.create).not.toHaveBeenCalled();
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
    expect(stratus.deleteUnreferenced).toHaveBeenCalledWith(expect.stringMatching(/^documents\/owner-1\//));
  });

  test('preserves the upload error when best-effort cleanup also fails', async () => {
    prisma.uploadedDocument.findUnique.mockReset().mockResolvedValue(null);
    const uploadError = new Error('storage upload unavailable');
    stratus.upload.mockRejectedValue(uploadError);
    stratus.deleteUnreferenced.mockRejectedValue(new Error('cleanup unavailable'));

    await expect(service.register(owner, {
      bytes: Buffer.from('%PDF-upload-cleanup-failure'), fileName: 'failed.pdf', contentType: 'application/pdf',
    })).rejects.toBe(uploadError);
    expect(prisma.uploadedDocument.create).not.toHaveBeenCalled();
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
  });

  test('removes only the just-uploaded unique object after a definite foreign-key rejection', async () => {
    prisma.uploadedDocument.findUnique.mockResolvedValue(null);
    prisma.uploadedDocument.create.mockRejectedValue(Object.assign(new Error('foreign key rejected'), { code: 'P2003' }));
    await expect(service.register(owner, {
      bytes: Buffer.from('%PDF-db-failure'), fileName: 'failed.pdf', contentType: 'application/pdf',
    })).rejects.toThrow('foreign key rejected');
    expect(stratus.deleteUnreferenced).toHaveBeenCalledWith(expect.stringMatching(/^documents\/owner-1\//));
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
  });

  test('preserves the database error when best-effort object cleanup fails', async () => {
    prisma.uploadedDocument.findUnique.mockResolvedValue(null);
    const databaseError = Object.assign(new Error('foreign key rejected'), { code: 'P2003' });
    prisma.uploadedDocument.create.mockRejectedValue(databaseError);
    stratus.deleteUnreferenced.mockRejectedValue(new Error('cleanup unavailable'));

    await expect(service.register(owner, {
      bytes: Buffer.from('%PDF-db-cleanup-failure'), fileName: 'failed.pdf', contentType: 'application/pdf',
    })).rejects.toBe(databaseError);
    expect(stratus.deleteUnreferenced).toHaveBeenCalledWith(expect.stringMatching(/^documents\/owner-1\//));
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
  });

  test('creates a version linked to the latest owner-scoped document and persists its chain id', async () => {
    const previous = doc({ id: 'doc-previous', documentSeriesId: 'series-1', versionNumber: 2 });
    const next = doc({ id: 'doc-next', documentSeriesId: 'series-1', versionNumber: 3, previousVersionId: previous.id });
    prisma.uploadedDocument.findFirst.mockResolvedValueOnce(previous).mockResolvedValueOnce(previous);
    prisma.uploadedDocument.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(next);
    prisma.uploadedDocument.create.mockResolvedValue(next);
    prisma.uploadedDocument.update.mockResolvedValue({ ...next, status: 'STORED', chainId: 97 });
    getSmartContractProvider().store.mockResolvedValue({ transactionHash: txHash, network: 'bsc-testnet', chainId: 97 });

    const result = await service.registerVersion(owner, previous.id, {
      bytes: Buffer.from('%PDF-new-version'), fileName: 'title-v3.pdf', contentType: 'application/pdf',
    });

    expect(prisma.uploadedDocument.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: owner, documentSeriesId: 'series-1', versionNumber: 3, previousVersionId: previous.id,
    }) });
    expect(result).toMatchObject({ documentSeriesId: 'series-1', versionNumber: 3, previousVersionId: previous.id, chainId: 97 });
  });

  test('rejects version bytes belonging to another series before uploading', async () => {
    const previous = doc({ id: 'previous', documentSeriesId: 'target-series' });
    prisma.uploadedDocument.findFirst.mockResolvedValue(previous);
    prisma.uploadedDocument.findUnique.mockResolvedValue(doc({ documentSeriesId: 'another-series' }));

    await expect(service.registerVersion(owner, previous.id, {
      bytes: Buffer.from('%PDF-another-series'), fileName: 'version.pdf', contentType: 'application/pdf',
    })).rejects.toMatchObject({ code: 'DOCUMENT_VERSION_CONFLICT' });
    expect(stratus.upload).not.toHaveBeenCalled();
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
  });

  test('rejects a concurrent duplicate belonging to another series and cleans only the attempted key', async () => {
    const previous = doc({ id: 'previous', documentSeriesId: 'target-series' });
    prisma.uploadedDocument.findFirst.mockResolvedValue(previous);
    prisma.uploadedDocument.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(doc({ documentSeriesId: 'another-series' }));
    prisma.uploadedDocument.create.mockRejectedValue(Object.assign(new Error('duplicate hash'), { code: 'P2002' }));

    await expect(service.registerVersion(owner, previous.id, {
      bytes: Buffer.from('%PDF-concurrent-duplicate'), fileName: 'version.pdf', contentType: 'application/pdf',
    })).rejects.toMatchObject({ code: 'DOCUMENT_VERSION_CONFLICT' });
    expect(stratus.deleteUnreferenced).toHaveBeenCalledWith(stratus.upload.mock.calls[0][0].key);
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
  });

  test('recovers a committed insert after a lost database response without deleting its file', async () => {
    let persisted;
    prisma.uploadedDocument.findUnique.mockImplementation(async () => persisted || null);
    prisma.uploadedDocument.create.mockImplementation(async ({ data }) => {
      persisted = doc(data);
      throw Object.assign(new Error('database response lost'), { code: 'P1001' });
    });
    prisma.uploadedDocument.update.mockImplementation(async ({ data }) => ({ ...persisted, ...data }));
    getSmartContractProvider().store.mockResolvedValue({ transactionHash: txHash, chainId: 97 });

    const result = await service.register(owner, {
      bytes: Buffer.from('%PDF-committed'), fileName: 'committed.pdf', contentType: 'application/pdf',
    });
    expect(result).toMatchObject({ id: persisted.id, status: 'STORED', chainId: 97 });
    expect(stratus.deleteUnreferenced).not.toHaveBeenCalled();
    expect(getSmartContractProvider().store).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('retains an uploaded object when database commit is uncertain (lookup fails: %p)', async (lookupFails) => {
    const databaseError = Object.assign(new Error('database response lost'), { code: 'P1001' });
    prisma.uploadedDocument.findUnique.mockResolvedValueOnce(null);
    if (lookupFails) prisma.uploadedDocument.findUnique.mockRejectedValueOnce(new Error('lookup unavailable'));
    else prisma.uploadedDocument.findUnique.mockResolvedValueOnce(null);
    prisma.uploadedDocument.create.mockRejectedValue(databaseError);

    await expect(service.register(owner, {
      bytes: Buffer.from('%PDF-uncertain'), fileName: 'uncertain.pdf', contentType: 'application/pdf',
    })).rejects.toBe(databaseError);
    expect(stratus.deleteUnreferenced).not.toHaveBeenCalled();
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
  });

  test('fails safely for a legacy document without an original-file reference', async () => {
    prisma.uploadedDocument.findFirst.mockResolvedValue(doc({ storageObjectKey: null }));
    await expect(service.retrieveFile(owner, 'doc-1')).rejects.toMatchObject({ code: 'DOCUMENT_FILE_UNAVAILABLE' });
    expect(stratus.download).not.toHaveBeenCalled();
  });

  test('maps a concurrent version-number uniqueness conflict and does not submit a second transaction', async () => {
    const previous = doc({ id: 'doc-previous', versionNumber: 2 });
    const winner = doc({ id: 'doc-winner', versionNumber: 3, previousVersionId: previous.id });
    let createCalls = 0;
    prisma.uploadedDocument.findFirst.mockImplementation(async () => previous);
    prisma.uploadedDocument.findUnique.mockImplementation(async ({ where }) => {
      if (where.userId_dataHash) return null;
      return winner;
    });
    prisma.uploadedDocument.create.mockImplementation(async () => {
      createCalls += 1;
      if (createCalls === 1) return winner;
      throw Object.assign(new Error('unique version constraint'), { code: 'P2002' });
    });
    prisma.uploadedDocument.update.mockResolvedValue({ ...winner, status: 'STORED' });
    getSmartContractProvider().store.mockResolvedValue({ transactionHash: txHash, network: 'bsc-testnet', chainId: 97 });

    const fileA = { bytes: Buffer.from('%PDF-concurrent-v3a'), fileName: 'v3a.pdf', contentType: 'application/pdf' };
    const fileB = { bytes: Buffer.from('%PDF-concurrent-v3b'), fileName: 'v3b.pdf', contentType: 'application/pdf' };
    const results = await Promise.allSettled([
      service.registerVersion(owner, previous.id, fileA),
      service.registerVersion(owner, previous.id, fileB),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason).toMatchObject({ code: 'DOCUMENT_VERSION_CONFLICT' });
    expect(getSmartContractProvider().store).toHaveBeenCalledTimes(1);
  });

  test('prevents creating a version from another users document or a superseded version', async () => {
    prisma.uploadedDocument.findFirst.mockResolvedValueOnce(null);
    await expect(service.registerVersion('other-user', 'foreign-id', { bytes: Buffer.from('x'), fileName: 'x.pdf', contentType: 'application/pdf' }))
      .rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });

    const oldVersion = doc({ id: 'old', versionNumber: 1 });
    prisma.uploadedDocument.findFirst.mockResolvedValueOnce(oldVersion).mockResolvedValueOnce(doc({ id: 'newer', versionNumber: 2 }));
    await expect(service.registerVersion(owner, oldVersion.id, { bytes: Buffer.from('x'), fileName: 'x.pdf', contentType: 'application/pdf' }))
      .rejects.toMatchObject({ code: 'DOCUMENT_VERSION_CONFLICT' });
    expect(prisma.uploadedDocument.create).not.toHaveBeenCalled();
  });

  test('lists a document series only after confirming ownership', async () => {
    prisma.uploadedDocument.findFirst.mockResolvedValueOnce(doc());
    prisma.uploadedDocument.findMany.mockResolvedValue([doc(), doc({ id: 'doc-2', versionNumber: 2, previousVersionId: 'doc-1' })]);
    await expect(service.listVersions(owner, 'doc-1')).resolves.toMatchObject([
      { versionNumber: 1 }, { versionNumber: 2, previousVersionId: 'doc-1' },
    ]);
    expect(prisma.uploadedDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: owner, documentSeriesId: 'series-1' }, orderBy: { versionNumber: 'asc' },
    }));
  });

  test('keeps an awaiting transaction pending and retries the same transaction hash', async () => {
    const pending = doc({ status: 'PROCESSING', transactionHash: txHash, attempts: 1 });
    prisma.uploadedDocument.findUnique.mockResolvedValue(pending);
    prisma.uploadedDocument.update.mockResolvedValue(doc({ status: 'PENDING', transactionHash: txHash, attempts: 2 }));
    getSmartContractProvider().store.mockRejectedValue(new ProviderError(503, 'SMART_CONTRACT_TX_PENDING', 'Awaiting receipt', {
      provider: 'SMART_CONTRACT', retryable: true, meta: { transactionHash: txHash, chainId: 97 },
    }));

    const result = await service.processDocument(pending.id);

    expect(getSmartContractProvider().store).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: txHash }));
    expect(result).toMatchObject({ status: 'PENDING', transactionHash: txHash });
    expect(prisma.uploadedDocument.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING', transactionHash: txHash, chainId: 97, nextRetryAt: expect.any(Date), lockedUntil: null }),
    }));
  });

  test('recovers a pending registration to success with the same transaction hash', async () => {
    const pending = doc({ status: 'PROCESSING', transactionHash: txHash, attempts: 2 });
    prisma.uploadedDocument.findUnique.mockResolvedValue(pending);
    prisma.uploadedDocument.update.mockResolvedValue(doc({ status: 'STORED', transactionHash: txHash, verificationId: '14', attempts: 3 }));
    getSmartContractProvider().store.mockResolvedValue({ transactionHash: txHash, network: 'bsc-testnet', externalReference: '14', blockNumber: 123 });

    const result = await service.processDocument(pending.id);

    expect(getSmartContractProvider().store).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: txHash }));
    expect(result).toMatchObject({ status: 'STORED', transactionHash: txHash, verificationId: '14' });
  });

  test.each([1, 8])('checkpoints a successful receipt after its final save fails, then finalizes without resubmitting (attempt %p)', async (attempts) => {
    let row = doc({ id: `receipt-checkpoint-${attempts}`, status: 'PROCESSING', attempts, maxAttempts: 8 });
    prisma.uploadedDocument.findUnique.mockImplementation(async () => row);
    prisma.uploadedDocument.update.mockRejectedValueOnce(new Error('synthetic receipt save failure'))
      .mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; });
    const provider = getSmartContractProvider();
    provider.store.mockResolvedValue({ transactionHash: txHash, chainId: 97, externalReference: '42', blockNumber: 123 });

    const pending = await service.processDocument(row.id);
    expect(pending).toMatchObject({ status: 'PENDING', transactionHash: txHash, chainId: 97, errorCode: 'DOCUMENT_RECEIPT_PERSIST_FAILED' });
    expect(pending.nextRetryAt).toBeInstanceOf(Date);
    expect(pending.lockedUntil).toBeNull();
    row.nextRetryAt = new Date(0); // Simulate a subsequent eligible worker claim.
    const result = await service.processDocument(row.id);
    expect(result).toMatchObject({ status: 'STORED', transactionHash: txHash, chainId: 97, verificationId: '42', blockNumber: 123, errorCode: null });
    expect(provider.store).toHaveBeenCalledTimes(1);
    expect(stratus.upload).not.toHaveBeenCalled();
  });

  test('retains the receipt in process when both persistence writes fail and retries only persistence', async () => {
    let row = doc({ id: 'receipt-total-db-failure', status: 'PROCESSING', attempts: 1 });
    prisma.uploadedDocument.findUnique.mockImplementation(async () => row);
    prisma.uploadedDocument.update.mockRejectedValueOnce(new Error('synthetic final write failure'))
      .mockRejectedValueOnce(new Error('synthetic checkpoint failure'))
      .mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; });
    const provider = getSmartContractProvider();
    provider.store.mockResolvedValue({ transactionHash: txHash, chainId: 97, externalReference: '43' });

    await expect(service.processDocument(row.id)).rejects.toMatchObject({
      code: 'DOCUMENT_RECEIPT_PERSIST_FAILED', retryable: true, meta: { transactionHash: txHash, chainId: 97 },
    });
    expect(row.transactionHash).toBeNull();
    const result = await service.processDocument(row.id);
    expect(result).toMatchObject({ status: 'STORED', transactionHash: txHash, verificationId: '43' });
    expect(provider.store).toHaveBeenCalledTimes(1);
  });

  test('recovers by the checkpointed original transaction hash after process memory is lost', async () => {
    let row = doc({ id: 'receipt-checkpoint-restart', status: 'PROCESSING', attempts: 1 });
    prisma.uploadedDocument.findUnique.mockImplementation(async () => row);
    prisma.uploadedDocument.update.mockRejectedValueOnce(new Error('synthetic final save failure'))
      .mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; });
    const provider = getSmartContractProvider();
    provider.store.mockResolvedValue({ transactionHash: txHash, chainId: 97, externalReference: '45' });

    expect(await service.processDocument(row.id)).toMatchObject({ status: 'PENDING', transactionHash: txHash });
    service.__testing.resetPendingReceipts(); // Simulate restart after a successful DB checkpoint.
    row.nextRetryAt = new Date(0);
    const recovered = await service.processDocument(row.id);
    expect(recovered).toMatchObject({ status: 'STORED', transactionHash: txHash, verificationId: '45' });
    expect(provider.store.mock.calls[1][0]).toEqual({ dataHash: row.dataHash, transactionHash: txHash });
    expect(provider.store).toHaveBeenCalledTimes(2); // Second call recovers a receipt using the existing hash.
    expect(stratus.upload).not.toHaveBeenCalled();
  });

  test('recognizes a committed receipt whose database response was lost without downgrading its status', async () => {
    let row = doc({ id: 'receipt-committed-response-lost', status: 'PROCESSING', attempts: 1 });
    prisma.uploadedDocument.findUnique.mockImplementation(async () => row);
    prisma.uploadedDocument.update.mockImplementationOnce(async ({ data }) => {
      row = { ...row, ...data };
      throw new Error('synthetic response loss after commit');
    });
    getSmartContractProvider().store.mockResolvedValue({ transactionHash: txHash, chainId: 97 });

    const result = await service.processDocument(row.id);
    expect(result).toMatchObject({ status: 'STORED', transactionHash: txHash });
    expect(prisma.uploadedDocument.update).toHaveBeenCalledTimes(1);
  });

  test('retries duplicate verification persistence without another registration or chain read', async () => {
    let row = doc({ id: 'receipt-duplicate-save', status: 'PROCESSING', transactionHash: txHash, attempts: 1 });
    prisma.uploadedDocument.findUnique.mockImplementation(async () => row);
    prisma.uploadedDocument.update.mockRejectedValueOnce(new Error('synthetic duplicate save failure'))
      .mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; });
    const provider = getSmartContractProvider();
    provider.store.mockRejectedValue(new ProviderError(409, 'SMART_CONTRACT_DUPLICATE', 'Synthetic duplicate'));
    provider.verify.mockResolvedValue({ exists: true, isValid: true, chainId: 97, verificationId: '44' });

    expect(await service.processDocument(row.id)).toMatchObject({ status: 'PENDING', transactionHash: txHash });
    expect(await service.processDocument(row.id)).toMatchObject({ status: 'ALREADY_STORED', transactionHash: txHash, verificationId: '44' });
    expect(provider.store).toHaveBeenCalledTimes(1);
    expect(provider.verify).toHaveBeenCalledTimes(1);
  });

  test('treats a mined revert as terminal and preserves its transaction hash', async () => {
    const pending = doc({ status: 'PROCESSING', transactionHash: txHash, attempts: 1 });
    prisma.uploadedDocument.findUnique.mockResolvedValue(pending);
    prisma.uploadedDocument.update.mockResolvedValue(doc({ status: 'PERMANENTLY_FAILED', transactionHash: txHash }));
    getSmartContractProvider().store.mockRejectedValue(new ProviderError(422, 'SMART_CONTRACT_TX_REVERTED', 'Mined revert', {
      provider: 'SMART_CONTRACT', retryable: false, meta: { transactionHash: txHash },
    }));

    const result = await service.processDocument(pending.id);
    expect(result.status).toBe('PERMANENTLY_FAILED');
    expect(prisma.uploadedDocument.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PERMANENTLY_FAILED', transactionHash: txHash, nextRetryAt: null }),
    }));
  });

  test('refuses document writes when configured for BSC mainnet', async () => {
    const pending = doc({ status: 'PROCESSING' });
    config.smartContract.bsc.chainId = 56;
    prisma.uploadedDocument.findUnique.mockResolvedValue(pending);
    prisma.uploadedDocument.update.mockResolvedValue(doc({ status: 'PERMANENTLY_FAILED', errorCode: 'SMART_CONTRACT_TESTNET_ONLY' }));

    const result = await service.processDocument(pending.id);
    expect(result.errorCode).toBe('SMART_CONTRACT_TESTNET_ONLY');
    expect(getSmartContractProvider().store).not.toHaveBeenCalled();
    config.smartContract.bsc.chainId = 97;
  });

  test('rejects cross-owner history access before calling the chain', async () => {
    prisma.uploadedDocument.findFirst.mockResolvedValue(null);
    await expect(service.verify('another-user', 'doc-1')).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    expect(prisma.uploadedDocument.findFirst).toHaveBeenCalledWith({ where: { id: 'doc-1', userId: 'another-user' } });
    expect(getSmartContractProvider().verify).not.toHaveBeenCalled();
  });

  test('retrieves the original file only after checking document ownership', async () => {
    const bytes = Buffer.from('%PDF-private');
    prisma.uploadedDocument.findFirst.mockResolvedValue(doc({ storageObjectKey: 'documents/owner-1/doc-1', sizeBytes: bytes.length, dataHash: service.hashFile(bytes) }));
    stratus.download.mockResolvedValue(bytes);
    await expect(service.retrieveFile(owner, 'doc-1')).resolves.toMatchObject({ bytes, fileName: 'title.pdf', contentType: 'application/pdf' });
    expect(stratus.download).toHaveBeenCalledWith({ key: 'documents/owner-1/doc-1', expectedSize: bytes.length });

    prisma.uploadedDocument.findFirst.mockResolvedValue(null);
    await expect(service.retrieveFile('another-user', 'doc-1')).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    expect(stratus.download).toHaveBeenCalledTimes(1);
  });

  test('rejects a retrieved object whose bytes do not match the stored SHA-256', async () => {
    const bytes = Buffer.from('%PDF-tampered');
    prisma.uploadedDocument.findFirst.mockResolvedValue(doc({ storageObjectKey: 'documents/owner-1/doc-1', sizeBytes: bytes.length }));
    stratus.download.mockResolvedValue(bytes);
    await expect(service.retrieveFile(owner, 'doc-1')).rejects.toMatchObject({ code: 'DOCUMENT_FILE_HASH_MISMATCH' });
  });

  test('hashes and verifies uploaded bytes read-only', async () => {
    const provider = getSmartContractProvider();
    provider.verify.mockResolvedValue({ exists: true, isValid: true, verificationId: '8' });
    const bytes = Buffer.from('%PDF-verified');
    await expect(service.verifyBytes(bytes)).resolves.toMatchObject({ dataHash: service.hashFile(bytes), onChain: { exists: true, isValid: true } });
    expect(provider.verify).toHaveBeenCalledWith({ dataHash: service.hashFile(bytes) });
    expect(provider.store).not.toHaveBeenCalled();
  });

  test('persists the verified chain id for a stored document without changing its status', async () => {
    const stored = doc({ status: 'STORED', chainId: null });
    prisma.uploadedDocument.findFirst.mockResolvedValue(stored);
    prisma.uploadedDocument.update.mockResolvedValue({ ...stored, chainId: 97 });
    getSmartContractProvider().verify.mockResolvedValue({ exists: true, isValid: true, chainId: 97 });

    const result = await service.verify(owner, stored.id);

    expect(prisma.uploadedDocument.update).toHaveBeenCalledWith({ where: { id: stored.id }, data: { chainId: 97 } });
    expect(result.document).toMatchObject({ status: 'STORED', chainId: 97 });
  });

  test('accepts matching PDF/image signatures and sanitizes file names', () => {
    const details = __testing.fileDetails({ body: Buffer.from('%PDF-1.7'), uploadContentType: 'application/pdf', headers: { 'x-file-name': '..\\folder\\title.pdf' } });
    expect(details.fileName).toBe('title.pdf');
    expect(() => __testing.fileDetails({ body: Buffer.from('not a PDF'), uploadContentType: 'application/pdf', headers: {} }))
      .toThrow(expect.objectContaining({ code: 'FILE_TYPE_MISMATCH' }));
  });

  test('requires authentication on document routes', async () => {
    const app = express();
    app.use('/documents', router);
    app.use(errorHandler);
    const response = await request(app).get('/documents');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_REQUIRED');
    const fileResponse = await request(app).get('/documents/11111111-1111-4111-8111-111111111111/file');
    expect(fileResponse.status).toBe(401);
  });

  test('serves an authenticated owned file with private response headers', async () => {
    const bytes = Buffer.from('%PDF-route');
    prisma.user.findUnique.mockResolvedValue({ id: ownerId, mobile: null, role: 'USER', status: 'ACTIVE' });
    prisma.uploadedDocument.findFirst.mockResolvedValue(doc({ userId: ownerId, sizeBytes: bytes.length, dataHash: service.hashFile(bytes) }));
    stratus.download.mockResolvedValue(bytes);
    const token = jwt.sign({ role: 'USER' }, config.jwt.secret, { subject: ownerId, issuer: config.jwt.issuer, expiresIn: '5m' });
    const app = express();
    app.use('/documents', router);
    app.use(errorHandler);

    const response = await request(app).get('/documents/11111111-1111-4111-8111-111111111111/file')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toEqual(bytes);
  });

  test('routes an authenticated version upload to the owner-scoped version service', async () => {
    const previousId = '22222222-2222-4222-8222-222222222222';
    prisma.user.findUnique.mockResolvedValue({ id: ownerId, mobile: null, role: 'USER', status: 'ACTIVE' });
    const token = jwt.sign({ role: 'USER' }, config.jwt.secret, { subject: ownerId, issuer: config.jwt.issuer, expiresIn: '5m' });
    const registerVersion = jest.spyOn(service, 'registerVersion').mockResolvedValue({
      id: 'new-doc', previousVersionId: previousId, versionNumber: 2,
    });
    const app = express();
    app.use('/documents', router);
    app.use(errorHandler);

    const response = await request(app)
      .post(`/documents/${previousId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-version'));

    expect(response.status).toBe(201);
    expect(registerVersion).toHaveBeenCalledWith(ownerId, previousId, expect.objectContaining({
      contentType: 'application/pdf', bytes: Buffer.from('%PDF-version'),
    }));
    registerVersion.mockRestore();
  });

  test('accepts an authenticated raw PDF upload and records its computed hash', async () => {
    const bytes = Buffer.from('%PDF-1.7 focused upload');
    const provider = getSmartContractProvider();
    prisma.user.findUnique.mockResolvedValue({ id: ownerId, mobile: null, role: 'USER', status: 'ACTIVE' });
    prisma.uploadedDocument.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(doc({ userId: ownerId, dataHash: service.hashFile(bytes) }));
    prisma.uploadedDocument.create.mockResolvedValue(doc({ userId: ownerId, dataHash: service.hashFile(bytes) }));
    prisma.uploadedDocument.update.mockResolvedValue(doc({ userId: ownerId, dataHash: service.hashFile(bytes), status: 'STORED' }));
    provider.store.mockResolvedValue({ network: 'bsc-testnet', contractAddress: `0x${'1'.repeat(40)}`, transactionHash: txHash });
    const token = jwt.sign({ role: 'USER' }, config.jwt.secret, { subject: ownerId, issuer: config.jwt.issuer, expiresIn: '5m' });
    const app = express();
    app.use('/documents', router);
    app.use(errorHandler);

    const response = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', 'uploaded.pdf')
      .send(bytes);

    expect(response.status).toBe(201);
    expect(response.body.data.document.dataHash).toBe(service.hashFile(bytes));
    expect(prisma.uploadedDocument.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: ownerId, dataHash: service.hashFile(bytes) }) });
  });

  test.each([
    ['PDF', 'application/pdf', Buffer.from('%PDF-mocked-storage-roundtrip')],
    ['PNG', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')],
  ])('round-trips %s through real routes, hashing and Stratus client with mocked database/HTTP', async (_, contentType, bytes) => {
    const actualStratus = jest.requireActual('../../src/integrations/stratus/stratus.client');
    actualStratus.__testing.resetTokenCache();
    let storedBytes;
    let objectUrl;
    let row;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (String(url) === 'https://accounts.zoho.in/oauth/v2/token') {
        return new Response(JSON.stringify({ access_token: 'mock-access', expires_in: 3600 }), { status: 200 });
      }
      expect(options.headers.authorization).toBe('Zoho-oauthtoken mock-access');
      if (options.method === 'PUT') {
        objectUrl = String(url);
        storedBytes = Buffer.from(options.body);
        return new Response(null, { status: 200 });
      }
      if (options.method === 'GET' && String(url) === objectUrl) {
        return new Response(storedBytes, { status: 200, headers: { 'content-length': String(storedBytes.length) } });
      }
      throw new Error('Unexpected mocked HTTP request');
    });
    stratus.upload.mockImplementation(actualStratus.upload);
    stratus.download.mockImplementation(actualStratus.download);
    prisma.user.findUnique.mockResolvedValue({ id: ownerId, role: 'USER', status: 'ACTIVE' });
    prisma.uploadedDocument.findUnique.mockImplementation(async () => row || null);
    prisma.uploadedDocument.findFirst.mockImplementation(async ({ where }) =>
      row && row.id === where.id && row.userId === where.userId ? row : null);
    prisma.uploadedDocument.create.mockImplementation(async ({ data }) => { row = doc(data); return row; });
    prisma.uploadedDocument.update.mockImplementation(async ({ data }) => { row = { ...row, ...data }; return row; });
    getSmartContractProvider().store.mockResolvedValue({ transactionHash: txHash, chainId: 97 });
    const token = jwt.sign({}, config.jwt.secret, { subject: ownerId, issuer: config.jwt.issuer, expiresIn: '5m' });
    const app = express();
    app.use('/documents', router);
    app.use(errorHandler);

    try {
      const uploaded = await request(app).post('/documents').set('Authorization', `Bearer ${token}`)
        .set('Content-Type', contentType).send(bytes);
      expect(uploaded.status).toBe(201);
      expect(uploaded.body.data.document).toMatchObject({ dataHash: service.hashFile(bytes), status: 'STORED', chainId: 97 });
      expect(uploaded.body.data.document).not.toHaveProperty('storageObjectKey');
      expect(row.storageObjectKey).toMatch(new RegExp(`^documents/${ownerId}/`));
      expect(storedBytes).toEqual(bytes);
      expect(prisma.uploadedDocument.create.mock.calls[0][0].data).not.toHaveProperty('bytes');

      const downloaded = await request(app).get(`/documents/${row.id}/file`).set('Authorization', `Bearer ${token}`);
      expect(downloaded.status).toBe(200);
      expect(downloaded.body).toEqual(bytes);
      expect(downloaded.headers['cache-control']).toBe('private, no-store');
      expect(downloaded.headers['content-type']).toContain(contentType);
      expect(fetchMock).toHaveBeenCalledTimes(3); // OAuth, PUT, GET; all intercepted locally.
      expect(stratus.deleteUnreferenced).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      actualStratus.__testing.resetTokenCache();
    }
  });

  test('rejects an upload larger than the configured request limit', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: ownerId, mobile: null, role: 'USER', status: 'ACTIVE' });
    const token = jwt.sign({ role: 'USER' }, config.jwt.secret, { subject: ownerId, issuer: config.jwt.issuer, expiresIn: '5m' });
    const app = express();
    app.use('/documents', router);
    app.use(errorHandler);
    const bytes = Buffer.alloc(__testing.MAX_FILE_BYTES + 1);
    bytes.write('%PDF-', 0, 'ascii');

    const response = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/pdf')
      .send(bytes);

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(prisma.uploadedDocument.create).not.toHaveBeenCalled();
  });
});
