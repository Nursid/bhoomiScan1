const mockContract = {
  registerLandData: jest.fn(),
  verifyLandData: jest.fn(),
  isOperator: jest.fn(),
  interface: {
    parseLog: jest.fn(),
    parseError: jest.fn(),
  },
};
const mockRpcProvider = {
  getTransactionReceipt: jest.fn(),
  getTransaction: jest.fn(),
  getNetwork: jest.fn(),
};

jest.mock('../../src/config', () => ({
  smartContract: {
    timeoutMs: 1000,
    bsc: {
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 97,
      contractAddress: `0x${'1'.repeat(40)}`,
      privateKey: `0x${'2'.repeat(64)}`,
      explorerTxUrl: 'http://localhost/tx/',
    },
  },
}));

jest.mock('../../src/utils/apiAudit', () => ({ record: jest.fn() }));

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn(() => mockRpcProvider),
    Wallet: jest.fn(() => ({})),
    Contract: jest.fn(() => mockContract),
  },
}));

const { ethers } = require('ethers');
const config = require('../../src/config');
const apiAudit = require('../../src/utils/apiAudit');
const { ProviderError } = require('../../src/utils/errors');
const { createBscSmartContractProvider } = require('../../src/integrations/smart-contract/bsc.provider');

const HASH = `0x${'a'.repeat(64)}`;

describe('BSC smart-contract provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpcProvider.getTransactionReceipt.mockReset();
    mockRpcProvider.getTransaction.mockReset();
    mockRpcProvider.getNetwork.mockReset().mockResolvedValue({ chainId: 97n });
    mockContract.isOperator.mockReset().mockResolvedValue(true);
    config.smartContract.bsc.contractAddress = `0x${'1'.repeat(40)}`;
    config.smartContract.bsc.privateKey = `0x${'2'.repeat(64)}`;
  });

  test('submits and records only the hash, then returns mined transaction details', async () => {
    const tx = {
      hash: `0x${'3'.repeat(64)}`,
      wait: jest.fn().mockResolvedValue({
        blockNumber: 123,
        gasUsed: 456n,
        logs: [{ data: 'event-log' }],
      }),
    };
    mockContract.registerLandData.mockResolvedValue(tx);
    mockContract.interface.parseLog.mockReturnValue({ name: 'LandRecordRegistered', args: { verificationId: 9n } });

    const provider = createBscSmartContractProvider();
    const result = await provider.store({ dataHash: HASH, propertyId: 'private-property-id' });

    expect(ethers.Contract).toHaveBeenCalledWith(
      config.smartContract.bsc.contractAddress,
      expect.arrayContaining([expect.stringContaining('registerLandData(bytes32 dataHash)')]),
      expect.anything(),
    );
    expect(mockContract.registerLandData).toHaveBeenCalledWith(HASH);
    expect(mockContract.registerLandData.mock.calls[0]).toHaveLength(1);
    expect(apiAudit.record).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: { dataHash: HASH },
      responseBody: expect.objectContaining({ transactionHash: tx.hash, blockNumber: 123, verificationId: '9' }),
      success: true,
    }));
    expect(result).toMatchObject({
      transactionHash: tx.hash,
      network: 'bsc-testnet',
      chainId: 97,
      contractAddress: config.smartContract.bsc.contractAddress,
      blockNumber: 123,
      externalReference: '9',
      response: { verificationId: '9', gasUsed: '456' },
    });
    expect(tx.wait).toHaveBeenCalledWith(1, 1000);
  });

  test('does not construct a provider or submit when credentials are missing', async () => {
    config.smartContract.bsc.privateKey = '';
    const provider = createBscSmartContractProvider();

    expect(provider.isConfigured()).toBe(false);
    await expect(provider.store({ dataHash: HASH })).rejects.toMatchObject({
      code: 'SMART_CONTRACT_NOT_CONFIGURED',
      statusCode: 503,
    });
    expect(ethers.JsonRpcProvider).not.toHaveBeenCalled();
    expect(mockContract.registerLandData).not.toHaveBeenCalled();
  });

  test('verifies a hash with a read-only contract connection and no wallet', async () => {
    mockContract.verifyLandData.mockResolvedValue([true, true, 21n, `0x${'3'.repeat(40)}`, 1720000000n]);
    const result = await createBscSmartContractProvider().verify({ dataHash: HASH });
    expect(ethers.Contract).toHaveBeenCalledWith(
      config.smartContract.bsc.contractAddress,
      expect.arrayContaining([expect.stringContaining('verifyLandData(bytes32 dataHash)')]),
      mockRpcProvider,
    );
    expect(ethers.Wallet).not.toHaveBeenCalled();
    expect(mockContract.verifyLandData).toHaveBeenCalledWith(HASH);
    expect(result).toMatchObject({ exists: true, isValid: true, chainId: 97, verificationId: '21', timestamp: '1720000000' });
  });

  test('rejects a configured RPC that reports a different chain id', async () => {
    mockRpcProvider.getNetwork.mockResolvedValue({ chainId: 56n });
    await expect(createBscSmartContractProvider().store({ dataHash: HASH })).rejects.toMatchObject({
      code: 'SMART_CONTRACT_NETWORK_MISMATCH',
    });
    expect(mockContract.registerLandData).not.toHaveBeenCalled();
  });

  test('checks the signer is an authorized contract operator before registration', async () => {
    mockContract.isOperator.mockResolvedValue(false);
    await expect(createBscSmartContractProvider().store({ dataHash: HASH })).rejects.toMatchObject({
      code: 'SMART_CONTRACT_SIGNER_UNAUTHORIZED',
    });
    expect(mockContract.registerLandData).not.toHaveBeenCalled();
  });

  test('maps duplicate contract errors to the existing conflict error', async () => {
    const error = Object.assign(new Error('duplicate hash'), { data: '0xdead' });
    mockContract.registerLandData.mockRejectedValue(error);
    mockContract.interface.parseError.mockReturnValue({ name: 'DuplicateVerification' });

    const provider = createBscSmartContractProvider();
    await expect(provider.store({ dataHash: HASH })).rejects.toMatchObject({
      code: 'SMART_CONTRACT_DUPLICATE',
      statusCode: 409,
    });
    expect(apiAudit.record).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test('keeps the broadcast transaction hash when receipt waiting times out', async () => {
    const txHash = `0x${'4'.repeat(64)}`;
    mockContract.registerLandData.mockResolvedValue({
      hash: txHash,
      wait: jest.fn().mockRejectedValue(Object.assign(new Error('receipt wait timed out'), { code: 'TIMEOUT' })),
    });

    const provider = createBscSmartContractProvider();
    await expect(provider.store({ dataHash: HASH })).rejects.toMatchObject({
      code: 'SMART_CONTRACT_TX_PENDING',
      retryable: true,
      meta: { transactionHash: txHash, chainId: 97 },
    });
  });

  test('recovers an existing transaction receipt without registering the hash again', async () => {
    const txHash = `0x${'5'.repeat(64)}`;
    const receipt = { blockNumber: 456, gasUsed: 789n, logs: [{ data: 'original-event' }] };
    mockRpcProvider.getTransactionReceipt.mockResolvedValue(receipt);
    mockContract.interface.parseLog.mockReturnValue({ name: 'LandRecordRegistered', args: { verificationId: 12n } });

    const result = await createBscSmartContractProvider().store({ dataHash: HASH, transactionHash: txHash });

    expect(mockRpcProvider.getTransactionReceipt).toHaveBeenCalledWith(txHash);
    expect(mockContract.registerLandData).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      transactionHash: txHash,
      blockNumber: 456,
      externalReference: '12',
      response: { verificationId: '12', gasUsed: '789' },
    });
  });

  test('waits on the original pending transaction instead of submitting a replacement', async () => {
    const txHash = `0x${'6'.repeat(64)}`;
    const receipt = { blockNumber: 789, gasUsed: 321n, logs: [{ data: 'pending-event' }] };
    const originalTx = { hash: txHash, wait: jest.fn().mockResolvedValue(receipt) };
    mockRpcProvider.getTransactionReceipt.mockResolvedValue(null);
    mockRpcProvider.getTransaction.mockResolvedValue(originalTx);
    mockContract.interface.parseLog.mockReturnValue({ name: 'LandRecordRegistered', args: { verificationId: 13n } });

    const result = await createBscSmartContractProvider().store({ dataHash: HASH, transactionHash: txHash });

    expect(mockRpcProvider.getTransactionReceipt).toHaveBeenCalledWith(txHash);
    expect(mockRpcProvider.getTransaction).toHaveBeenCalledWith(txHash);
    expect(originalTx.wait).toHaveBeenCalledWith(1, 1000);
    expect(mockContract.registerLandData).not.toHaveBeenCalled();
    expect(result).toMatchObject({ transactionHash: txHash, blockNumber: 789, externalReference: '13' });
  });

  test('reports a recovered mined revert as a final transaction failure', async () => {
    const txHash = `0x${'7'.repeat(64)}`;
    mockRpcProvider.getTransactionReceipt.mockResolvedValue({ status: 0, blockNumber: 900, logs: [] });

    await expect(createBscSmartContractProvider().store({ dataHash: HASH, transactionHash: txHash })).rejects.toMatchObject({
      code: 'SMART_CONTRACT_TX_REVERTED',
      retryable: false,
      meta: { transactionHash: txHash, chainId: 97 },
    });
    expect(mockContract.registerLandData).not.toHaveBeenCalled();
  });
});
