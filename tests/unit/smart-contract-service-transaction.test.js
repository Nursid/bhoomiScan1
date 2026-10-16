const mockPrisma = {
  smartContractRecord: {
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  landVerification: { findUnique: jest.fn() },
};
const mockProvider = { store: jest.fn() };

jest.mock('../../src/config', () => ({
  smartContract: { maxAttempts: 8 },
  jobs: { batchSize: 20 },
}));
jest.mock('../../src/database/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../../src/integrations/smart-contract', () => ({ getSmartContractProvider: () => mockProvider }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/modules/alerts/alerts.service', () => ({ createAlert: jest.fn() }));

const { ProviderError } = require('../../src/utils/errors');
const service = require('../../src/modules/smart-contract/smart-contract.service');

const TX_HASH = `0x${'4'.repeat(64)}`;
const RECORD_ID = 'record-1';
const baseRecord = (transactionHash = null) => ({
  id: RECORD_ID,
  snapshotId: 'snapshot-1',
  landVerificationId: 'verification-1',
  provider: 'BSC',
  dataHash: `0x${'a'.repeat(64)}`,
  propertyId: 'off-chain-property-id',
  status: 'PROCESSING',
  attempts: 8,
  maxAttempts: 8,
  transactionHash,
  snapshot: { normalizedData: { owner_name: 'private' }, sequence: 1 },
});

describe('smart-contract service transaction recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.smartContractRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.smartContractRecord.findFirst.mockResolvedValue(null);
  });

  test('keeps a broadcast transaction pending, schedules recovery, and stores it after receipt recovery', async () => {
    const firstAttempt = baseRecord();
    mockPrisma.smartContractRecord.findUnique.mockResolvedValueOnce(firstAttempt);
    mockPrisma.smartContractRecord.update.mockResolvedValueOnce({
      ...firstAttempt,
      status: 'PENDING',
      transactionHash: TX_HASH,
      attempts: 8,
      maxAttempts: 8,
      errorCode: 'SMART_CONTRACT_TX_PENDING',
    });
    mockProvider.store.mockRejectedValueOnce(new ProviderError(
      502,
      'SMART_CONTRACT_TX_PENDING',
      'Receipt wait timed out',
      { provider: 'SMART_CONTRACT', retryable: true, meta: { transactionHash: TX_HASH } },
    ));

    const pending = await service.processRecord(RECORD_ID);

    expect(pending).toMatchObject({ status: 'PENDING', transactionHash: TX_HASH, errorCode: 'SMART_CONTRACT_TX_PENDING' });
    const pendingUpdate = mockPrisma.smartContractRecord.update.mock.calls[0][0];
    expect(pendingUpdate).toEqual(expect.objectContaining({
      where: { id: RECORD_ID },
      data: expect.objectContaining({ transactionHash: TX_HASH, status: 'PENDING' }),
    }));
    expect(pendingUpdate.data.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
    expect(pendingUpdate.data.lockedUntil).toBeNull();

    mockPrisma.smartContractRecord.findUnique.mockResolvedValueOnce(baseRecord(TX_HASH));
    mockPrisma.smartContractRecord.update.mockResolvedValueOnce({
      ...baseRecord(TX_HASH),
      status: 'STORED',
      blockNumber: 456,
      externalReference: '12',
      attempts: 2,
    });
    mockProvider.store.mockResolvedValueOnce({
      transactionHash: TX_HASH,
      network: 'bsc-testnet',
      contractAddress: `0x${'1'.repeat(40)}`,
      blockNumber: 456,
      externalReference: '12',
      response: { transactionHash: TX_HASH, verificationId: '12' },
    });

    const stored = await service.processRecord(RECORD_ID);

    expect(mockProvider.store).toHaveBeenLastCalledWith(expect.objectContaining({ transactionHash: TX_HASH }));
    expect(stored).toMatchObject({ status: 'STORED', transactionHash: TX_HASH, blockNumber: 456 });
  });

  test('marks a mined reverted transaction as permanently failed, not pending', async () => {
    const record = baseRecord(TX_HASH);
    mockPrisma.smartContractRecord.findUnique.mockResolvedValueOnce(record);
    mockPrisma.smartContractRecord.update.mockResolvedValueOnce({
      ...record,
      status: 'PERMANENTLY_FAILED',
      errorCode: 'SMART_CONTRACT_TX_REVERTED',
    });
    mockPrisma.landVerification.findUnique.mockResolvedValue({ userId: 'user-1' });
    mockProvider.store.mockRejectedValueOnce(new ProviderError(
      422,
      'SMART_CONTRACT_TX_REVERTED',
      'The submitted transaction was mined but reverted',
      { provider: 'SMART_CONTRACT', retryable: false, meta: { transactionHash: TX_HASH } },
    ));

    const failed = await service.processRecord(RECORD_ID);

    expect(failed).toMatchObject({ status: 'PERMANENTLY_FAILED', transactionHash: TX_HASH });
    expect(mockPrisma.smartContractRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PERMANENTLY_FAILED', transactionHash: TX_HASH, nextRetryAt: null }),
    }));
  });
});
