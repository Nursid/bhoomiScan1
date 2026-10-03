/**
 * Direct BNB Smart Chain provider for the LandVerification contract
 * (contracts/LandVerification.sol in the reference project). Adapted from the
 * reference backend's server/blockchainService.js registerOnBlockchain: anchors
 * the snapshot's bytes32 hash with registerLandData(dataHash, propertyId, ipfsCid).
 *
 * `ethers` is an optional dependency, loaded only when this provider is used.
 */

const config = require('../../config');
const apiAudit = require('../../utils/apiAudit');
const { ProviderError } = require('../../utils/errors');

const PROVIDER = 'SMART_CONTRACT';

const ABI = [
  'function registerLandData(bytes32 dataHash, string calldata propertyId, string calldata ipfsCid) external returns (uint256)',
  'event LandRecordRegistered(uint256 indexed verificationId, bytes32 indexed dataHash, string propertyId, string ipfsCid, address indexed registeredBy, uint256 timestamp)',
  'error Unauthorized(address caller)',
  'error DuplicateVerification(bytes32 dataHash)',
  'error InvalidDataHash()',
  'error InvalidPropertyId()',
];

const loadEthers = () => {
  try {
    // eslint-disable-next-line global-require
    return require('ethers');
  } catch {
    throw new ProviderError(503, 'SMART_CONTRACT_NOT_CONFIGURED', 'ethers is not installed', { provider: PROVIDER });
  }
};

const createBscSmartContractProvider = () => {
  const settings = () => config.smartContract.bsc;

  const isConfigured = () => {
    const { contractAddress, privateKey } = settings();
    return Boolean(contractAddress && privateKey && privateKey.replace(/^0x/, '').length === 64);
  };

  return {
    name: 'BSC',
    isConfigured,
    async store({ dataHash, propertyId }) {
      if (!isConfigured()) {
        throw new ProviderError(503, 'SMART_CONTRACT_NOT_CONFIGURED', 'BSC contract or operator key is not configured', { provider: PROVIDER });
      }
      const { ethers } = loadEthers();
      const { rpcUrl, chainId, contractAddress, privateKey, explorerTxUrl } = settings();
      const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
      const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`, provider);
      const contract = new ethers.Contract(contractAddress, ABI, wallet);
      const startedAt = Date.now();
      const network = chainId === 56 ? 'bsc-mainnet' : 'bsc-testnet';

      try {
        const tx = await contract.registerLandData(dataHash, propertyId, '');
        const receipt = await tx.wait(1, config.smartContract.timeoutMs);
        let verificationId = null;
        for (const log of receipt.logs || []) {
          try {
            const parsed = contract.interface.parseLog(log);
            if (parsed?.name === 'LandRecordRegistered') {
              verificationId = String(parsed.args.verificationId);
              break;
            }
          } catch {
            // log from another contract
          }
        }
        apiAudit.record({
          provider: PROVIDER,
          operation: 'bsc.registerLandData',
          method: 'RPC',
          endpoint: `contract:${contractAddress}`,
          requestBody: { dataHash, propertyId },
          responseBody: { transactionHash: tx.hash, blockNumber: receipt.blockNumber, verificationId },
          providerReference: tx.hash,
          success: true,
          durationMs: Date.now() - startedAt,
        });
        return {
          externalReference: verificationId,
          transactionHash: tx.hash,
          network,
          contractAddress,
          blockNumber: Number(receipt.blockNumber),
          response: {
            transactionHash: tx.hash,
            explorerUrl: `${explorerTxUrl}${tx.hash}`,
            verificationId,
            gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : null,
          },
        };
      } catch (error) {
        let decoded = null;
        try {
          decoded = error?.data ? contract.interface.parseError(error.data)?.name : null;
        } catch {
          decoded = null;
        }
        apiAudit.record({
          provider: PROVIDER,
          operation: 'bsc.registerLandData',
          method: 'RPC',
          endpoint: `contract:${contractAddress}`,
          requestBody: { dataHash, propertyId },
          success: false,
          errorCode: decoded || error?.code,
          errorMessage: error?.shortMessage || error?.message,
          durationMs: Date.now() - startedAt,
        });
        if (decoded === 'DuplicateVerification') {
          throw new ProviderError(409, 'SMART_CONTRACT_DUPLICATE', 'Hash already anchored on chain', { provider: PROVIDER });
        }
        if (decoded === 'Unauthorized' || decoded === 'InvalidDataHash' || decoded === 'InvalidPropertyId') {
          throw new ProviderError(422, 'SMART_CONTRACT_REJECTED', `Contract rejected the call (${decoded})`, { provider: PROVIDER });
        }
        if (error?.code === 'INSUFFICIENT_FUNDS') {
          throw new ProviderError(503, 'SMART_CONTRACT_INSUFFICIENT_FUNDS', 'Operator wallet has insufficient gas funds', { provider: PROVIDER, retryable: true });
        }
        throw new ProviderError(502, 'SMART_CONTRACT_UNAVAILABLE', 'Blockchain call failed', {
          provider: PROVIDER,
          retryable: true,
          providerMessage: error?.shortMessage || error?.message,
        });
      }
    },
  };
};

module.exports = { createBscSmartContractProvider };
