// Real Prisma/database integration; Stratus and blockchain are mocked at their boundaries.
// Run only through the guarded integration project, after disposable-database approval.
jest.mock('../../src/integrations/stratus/stratus.client', () => ({
  upload: jest.fn(), download: jest.fn(), deleteUnreferenced: jest.fn(),
}));
jest.mock('../../src/integrations/smart-contract', () => ({ getSmartContractProvider: jest.fn() }));
jest.mock('../../src/config', () => {
  const actual = jest.requireActual('../../src/config');
  return {
    ...actual,
    smartContract: {
      ...actual.smartContract,
      provider: 'bsc',
      bsc: { ...actual.smartContract.bsc, chainId: 97, contractAddress: `0x${'1'.repeat(40)}`, privateKey: '' },
    },
  };
});

const { createHash } = require('crypto');
const { prisma, resetDb, api, settle } = require('./helpers');
const { generateToken } = require('../../src/modules/auth/token.service');
const stratus = require('../../src/integrations/stratus/stratus.client');
const { getSmartContractProvider } = require('../../src/integrations/smart-contract');
const documents = require('../../src/modules/documents/documents.service');
const { ProviderError } = require('../../src/utils/errors');

jest.setTimeout(30_000);

const pdf = Buffer.from('%PDF-1.7\nsynthetic integration fixture\n%%EOF');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
const hash = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const txHash = `0x${'4'.repeat(64)}`;
const registered = { transactionHash: txHash, chainId: 97, network: 'bsc-testnet', externalReference: '1', blockNumber: 12 };
const objects = new Map();
let owner;
let other;
let auth;
let otherAuth;
let provider;
let fetchGuard;

beforeAll(() => {
  fetchGuard = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External HTTP disabled in document integration tests'));
});

beforeEach(async () => {
  await resetDb();
  objects.clear();
  stratus.upload.mockReset().mockImplementation(async ({ key, bytes }) => {
    objects.set(key, Buffer.from(bytes));
    return { objectKey: key };
  });
  stratus.download.mockReset().mockImplementation(async ({ key }) => Buffer.from(objects.get(key)));
  stratus.deleteUnreferenced.mockReset().mockImplementation(async (key) => objects.delete(key));
  provider = {
    name: 'BSC', isConfigured: () => true,
    store: jest.fn().mockResolvedValue(registered),
    verify: jest.fn().mockResolvedValue({ exists: true, isValid: true, chainId: 97, verificationId: '1' }),
  };
  getSmartContractProvider.mockReturnValue(provider);
  owner = await prisma.user.create({ data: { name: 'Synthetic owner', status: 'ACTIVE' } });
  other = await prisma.user.create({ data: { name: 'Synthetic other user', status: 'ACTIVE' } });
  auth = { Authorization: `Bearer ${generateToken(owner).token}` };
  otherAuth = { Authorization: `Bearer ${generateToken(other).token}` };
});

afterEach(() => { expect(fetchGuard).not.toHaveBeenCalled(); });

afterAll(async () => {
  fetchGuard.mockRestore();
  await settle();
  await prisma.$disconnect();
});

const upload = (bytes = pdf, headers = auth, path = '/api/v1/documents', type = 'application/pdf') =>
  api().post(path).set(headers).set('Content-Type', type).set('X-File-Name', type === 'image/png' ? 'fixture.png' : 'fixture.pdf').send(bytes);

test.each([['PDF', pdf, 'application/pdf'], ['PNG', png, 'image/png']])('persists %s metadata and original-byte hash, then privately downloads identical bytes', async (_, bytes, type) => {
  const response = await upload(bytes, auth, undefined, type);
  expect(response.status).toBe(201);
  const document = response.body.data.document;
  expect(document).toMatchObject({ dataHash: hash(bytes), status: 'STORED', chainId: 97, sizeBytes: bytes.length });
  expect(document).not.toHaveProperty('storageObjectKey');
  const row = await prisma.uploadedDocument.findUniqueOrThrow({ where: { id: document.id } });
  expect(row).toMatchObject({ userId: owner.id, dataHash: hash(bytes), sizeBytes: bytes.length, contentType: type });
  expect(row.storageObjectKey).toMatch(new RegExp(`^documents/${owner.id}/`));
  expect(objects.get(row.storageObjectKey)).toEqual(bytes);
  expect(row).not.toHaveProperty('bytes');
  expect(provider.store).toHaveBeenCalledWith({ dataHash: hash(bytes), transactionHash: undefined });

  const download = await api().get(`/api/v1/documents/${row.id}/file`).set(auth);
  expect(download.status).toBe(200);
  expect(download.body).toEqual(bytes);
  expect(download.headers['cache-control']).toBe('private, no-store');
  expect(download.headers['x-content-type-options']).toBe('nosniff');
  expect(download.headers['content-disposition']).toContain('attachment;');
});

test('requires authentication and enforces ownership before storage access or version creation', async () => {
  expect((await upload(pdf, {})).status).toBe(401);
  expect(stratus.upload).not.toHaveBeenCalled();
  const response = await upload();
  const id = response.body.data.document.id;
  for (const suffix of ['file', 'versions', 'verify']) {
    expect((await api().get(`/api/v1/documents/${id}/${suffix}`).set(otherAuth)).status).toBe(404);
  }
  expect((await upload(Buffer.from('%PDF-new'), otherAuth, `/api/v1/documents/${id}/versions`)).status).toBe(404);
  expect(stratus.download).not.toHaveBeenCalled();
  expect(stratus.upload).toHaveBeenCalledTimes(1);
  expect(provider.verify).not.toHaveBeenCalled();
});

test('reuses the same-owner duplicate row without reuploading or resubmitting', async () => {
  const first = await upload();
  const second = await upload();
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(second.body.data.document.id).toBe(first.body.data.document.id);
  expect(await prisma.uploadedDocument.count({ where: { userId: owner.id } })).toBe(1);
  expect(stratus.upload).toHaveBeenCalledTimes(1);
  expect(provider.store).toHaveBeenCalledTimes(1);
});

test('isolates object references and document lists between owners of identical bytes', async () => {
  provider.store.mockResolvedValueOnce(registered).mockRejectedValueOnce(new ProviderError(409, 'SMART_CONTRACT_DUPLICATE', 'Synthetic duplicate hash'));
  const first = await upload();
  const second = await upload(pdf, otherAuth);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(second.body.data.document.status).toBe('ALREADY_STORED');
  const rows = await prisma.uploadedDocument.findMany();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.storageObjectKey)).size).toBe(2);
  const history = await api().get('/api/v1/documents').set(otherAuth);
  expect(history.body.data.documents.map((row) => row.id)).toEqual([second.body.data.document.id]);
});

test('rejects cross-series duplicate version bytes without changing either history', async () => {
  const first = (await upload()).body.data.document;
  const differentBytes = Buffer.from('%PDF-another-series');
  const secondResponse = await upload(differentBytes);
  expect(secondResponse.status).toBe(201);
  const response = await upload(differentBytes, auth, `/api/v1/documents/${first.id}/versions`);
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('DOCUMENT_VERSION_CONFLICT');
  expect(await prisma.uploadedDocument.count()).toBe(2);
  expect(stratus.upload).toHaveBeenCalledTimes(2);
  expect(provider.store).toHaveBeenCalledTimes(2);
});

test('keeps version history and rejects a version based on an outdated parent', async () => {
  const first = (await upload()).body.data.document;
  const secondResponse = await upload(Buffer.from('%PDF-version-two'), auth, `/api/v1/documents/${first.id}/versions`);
  expect(secondResponse.status).toBe(201);
  const second = secondResponse.body.data.document;
  expect(second).toMatchObject({ documentSeriesId: first.documentSeriesId, previousVersionId: first.id, versionNumber: 2 });
  const stale = await upload(Buffer.from('%PDF-version-three'), auth, `/api/v1/documents/${first.id}/versions`);
  expect(stale.status).toBe(409);
  const history = await api().get(`/api/v1/documents/${first.id}/versions`).set(auth);
  expect(history.body.data.versions.map((row) => row.id)).toEqual([first.id, second.id]);
  expect(stratus.upload).toHaveBeenCalledTimes(2);
});

test('allows only one concurrent successor using the real database version constraints', async () => {
  const first = (await upload()).body.data.document;
  const responses = await Promise.all([
    upload(Buffer.from('%PDF-concurrent-one'), auth, `/api/v1/documents/${first.id}/versions`),
    upload(Buffer.from('%PDF-concurrent-two'), auth, `/api/v1/documents/${first.id}/versions`),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  const rows = await prisma.uploadedDocument.findMany({ where: { documentSeriesId: first.documentSeriesId } });
  expect(rows).toHaveLength(2);
  expect(rows.filter((row) => row.previousVersionId === first.id)).toHaveLength(1);
  expect(objects.size).toBe(2);
  for (const row of rows) expect(objects.has(row.storageObjectKey)).toBe(true);
  expect(provider.store).toHaveBeenCalledTimes(2);
});

test('rejects same-size stored-byte corruption before returning a document', async () => {
  const response = await upload();
  const row = await prisma.uploadedDocument.findUniqueOrThrow({ where: { id: response.body.data.document.id } });
  objects.set(row.storageObjectKey, Buffer.alloc(pdf.length, 120));
  const download = await api().get(`/api/v1/documents/${row.id}/file`).set(auth);
  expect(download.status).toBe(503);
  expect(download.body.error.code).toBe('DOCUMENT_FILE_HASH_MISMATCH');
});

test('reports a missing legacy file reference without contacting storage', async () => {
  const response = await upload();
  const id = response.body.data.document.id;
  await prisma.uploadedDocument.update({ where: { id }, data: { storageObjectKey: null } });
  const download = await api().get(`/api/v1/documents/${id}/file`).set(auth);
  expect(download.status).toBe(503);
  expect(download.body.error.code).toBe('DOCUMENT_FILE_UNAVAILABLE');
  expect(stratus.download).not.toHaveBeenCalled();
});

test('rejects bytes that do not match the declared file type before upload or insertion', async () => {
  const response = await upload(Buffer.from('not-a-pdf'));
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('FILE_TYPE_MISMATCH');
  expect(await prisma.uploadedDocument.count()).toBe(0);
  expect(stratus.upload).not.toHaveBeenCalled();
  expect(provider.store).not.toHaveBeenCalled();
});

test('creates no database row or registration when storage fails and cleans only that attempt', async () => {
  stratus.upload.mockRejectedValueOnce(new ProviderError(503, 'STRATUS_UPLOAD_FAILED', 'Synthetic upload failure'));
  const response = await upload();
  expect(response.status).toBe(503);
  expect(await prisma.uploadedDocument.count()).toBe(0);
  expect(provider.store).not.toHaveBeenCalled();
  expect(stratus.deleteUnreferenced).toHaveBeenCalledWith(stratus.upload.mock.calls[0][0].key);
});

test('cleans the attempted object after a real foreign-key insert rejection', async () => {
  stratus.upload.mockImplementationOnce(async ({ key, bytes }) => {
    objects.set(key, Buffer.from(bytes));
    // Simulate the user being removed after authentication but before insertion.
    await prisma.user.delete({ where: { id: owner.id } });
    return { objectKey: key };
  });
  const response = await upload();
  expect(response.status).toBe(500);
  expect(await prisma.uploadedDocument.count()).toBe(0);
  expect(stratus.deleteUnreferenced).toHaveBeenCalledWith(stratus.upload.mock.calls[0][0].key);
  expect(objects.size).toBe(0);
  expect(provider.store).not.toHaveBeenCalled();
});

test('recovers a committed row after a simulated lost insert response without deleting its object', async () => {
  const originalCreate = prisma.uploadedDocument.create.bind(prisma.uploadedDocument);
  const createSpy = jest.spyOn(prisma.uploadedDocument, 'create').mockImplementationOnce(async (args) => {
    await originalCreate(args);
    throw Object.assign(new Error('Synthetic lost insert response'), { code: 'P1001' });
  });
  try {
    const response = await upload();
    expect(response.status).toBe(201);
    expect(response.body.data.document.status).toBe('STORED');
    expect(await prisma.uploadedDocument.count()).toBe(1);
    expect(stratus.deleteUnreferenced).not.toHaveBeenCalled();
    const download = await api().get(`/api/v1/documents/${response.body.data.document.id}/file`).set(auth);
    expect(download.status).toBe(200);
    expect(download.body).toEqual(pdf);
    expect(provider.store).toHaveBeenCalledTimes(1);
  } finally {
    createSpy.mockRestore();
  }
});

test('recovers a pending transaction through the database-backed retry worker without reuploading', async () => {
  provider.store.mockRejectedValueOnce(new ProviderError(503, 'SMART_CONTRACT_TX_PENDING', 'Synthetic pending receipt', {
    retryable: true, meta: { transactionHash: txHash, chainId: 97 },
  }));
  const response = await upload();
  expect(response.status).toBe(201);
  const pending = response.body.data.document;
  expect(pending).toMatchObject({ status: 'PENDING', transactionHash: txHash, chainId: 97 });
  await prisma.uploadedDocument.update({ where: { id: pending.id }, data: { nextRetryAt: new Date(0) } });
  expect(await documents.processDueDocuments()).toMatchObject({ processed: 1, completed: 1 });
  const recovered = await prisma.uploadedDocument.findUniqueOrThrow({ where: { id: pending.id } });
  expect(recovered).toMatchObject({ status: 'STORED', transactionHash: txHash, chainId: 97, attempts: 2 });
  expect(provider.store).toHaveBeenLastCalledWith({ dataHash: hash(pdf), transactionHash: txHash });
  expect(stratus.upload).toHaveBeenCalledTimes(1);
});

test('stops retrying a recovered reverted transaction while preserving its file and transaction hash', async () => {
  provider.store.mockRejectedValueOnce(new ProviderError(503, 'SMART_CONTRACT_TX_PENDING', 'Synthetic pending receipt', {
    retryable: true, meta: { transactionHash: txHash, chainId: 97 },
  })).mockRejectedValueOnce(new ProviderError(422, 'SMART_CONTRACT_TX_REVERTED', 'Synthetic mined revert', {
    meta: { transactionHash: txHash, chainId: 97 },
  }));
  const response = await upload();
  const id = response.body.data.document.id;
  await prisma.uploadedDocument.update({ where: { id }, data: { nextRetryAt: new Date(0) } });
  await documents.processDueDocuments();
  const row = await prisma.uploadedDocument.findUniqueOrThrow({ where: { id } });
  expect(row).toMatchObject({ status: 'PERMANENTLY_FAILED', transactionHash: txHash, nextRetryAt: null });
  expect(await documents.processDueDocuments()).toEqual({ processed: 0, completed: 0 });
  expect(stratus.upload).toHaveBeenCalledTimes(1);
  expect(stratus.deleteUnreferenced).not.toHaveBeenCalled();
  expect(objects.has(row.storageObjectKey)).toBe(true);
  expect(provider.store).toHaveBeenCalledTimes(2);
});

test('verifies stored metadata and supplied bytes through read-only provider calls', async () => {
  const response = await upload();
  const id = response.body.data.document.id;
  const stored = await api().get(`/api/v1/documents/${id}/verify`).set(auth);
  const supplied = await upload(pdf, auth, '/api/v1/documents/verify');
  expect(stored.status).toBe(200);
  expect(supplied.status).toBe(200);
  expect(supplied.body.data).toMatchObject({ dataHash: hash(pdf), onChain: { exists: true, isValid: true } });
  expect(provider.verify).toHaveBeenCalledTimes(2);
  expect(provider.verify).toHaveBeenLastCalledWith({ dataHash: hash(pdf) });
  expect(provider.store).toHaveBeenCalledTimes(1);
  expect(stratus.upload).toHaveBeenCalledTimes(1);
});
