/**
 * Direct BNB Smart Chain provider for the LandVerification contract
 * (contracts/LandVerification.sol in the reference project). Adapted from the
 * reference backend's server/blockchainService.js registerOnBlockchain: anchors
 * the snapshot's bytes32 hash with registerLandData(dataHash). Personal identifiers
 * and document metadata are kept off-chain and are never sent in transaction calldata.
 *
 * `ethers` is an optional dependency, loaded only when this provider is used.
 */

const config = require('../../config');
const apiAudit = require('../../utils/apiAudit');
const { ProviderError } = require('../../utils/errors');

const PROVIDER = 'SMART_CONTRACT';

const ABI = [
  'function registerLandData(bytes32 dataHash) external returns (uint256)',
  'function verifyLandData(bytes32 dataHash) view returns (bool exists, bool isValid, uint256 verificationId, address registeredBy, uint256 timestamp)',
  'function isOperator(address account) view returns (bool)',
  'event LandRecordRegistered(uint256 indexed verificationId, bytes32 indexed dataHash, address indexed registeredBy, uint256 timestamp)',
  'error Unauthorized(address caller)',
  'error DuplicateVerification(bytes32 dataHash)',
  'error InvalidDataHash()',
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
    return Boolean(/^0x[0-9a-fA-F]{40}$/.test(contractAddress) && /^[0-9a-fA-F]{64}$/.test(privateKey.replace(/^0x/, '')));
  };

  return {
    name: 'BSC',
    isConfigured,
    async verify({ dataHash }) {
      const { contractAddress, rpcUrl, chainId } = settings();
      if (!contractAddress) {
        throw new ProviderError(503, 'SMART_CONTRACT_NOT_CONFIGURED', 'BSC contract address is not configured', { provider: PROVIDER });
      }
      const { ethers } = loadEthers();
      const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
      try {
        const networkInfo = await provider.getNetwork();
        const actualChainId = Number(networkInfo.chainId);
        if (actualChainId !== Number(chainId)) {
          throw new ProviderError(503, 'SMART_CONTRACT_NETWORK_MISMATCH', 'RPC network does not match configured BSC chain ID', { provider: PROVIDER });
        }
        const contract = new ethers.Contract(contractAddress, ABI, provider);
        const [exists, isValid, verificationId, registeredBy, timestamp] = await contract.verifyLandData(dataHash);
        return {
          exists,
          isValid,
          verificationId: String(verificationId),
          registeredBy,
          timestamp: String(timestamp),
          network: chainId === 56 ? 'bsc-mainnet' : 'bsc-testnet',
          chainId: actualChainId,
          contractAddress,
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(502, 'SMART_CONTRACT_UNAVAILABLE', 'BSC read-only verification failed', {
          provider: PROVIDER,
          retryable: true,
          providerMessage: error?.shortMessage || error?.message,
        });
      }
    },
    async store({ dataHash, transactionHash }) {
      if (!isConfigured()) {
        throw new ProviderError(503, 'SMART_CONTRACT_NOT_CONFIGURED', 'BSC contract or operator key is not configured', { provider: PROVIDER });
      }
      const { ethers } = loadEthers();
      const { rpcUrl, chainId, contractAddress, privateKey, explorerTxUrl } = settings();
      const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
      const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`, provider);
      const contract = new ethers.Contract(contractAddress, ABI, wallet);
      let actualChainId = null;
      try {
        const networkInfo = await provider.getNetwork();
        actualChainId = Number(networkInfo.chainId);
        if (actualChainId !== Number(chainId)) {
          throw new ProviderError(503, 'SMART_CONTRACT_NETWORK_MISMATCH', 'RPC network does not match configured BSC chain ID', { provider: PROVIDER });
        }
        if (!(await contract.isOperator(wallet.address))) {
          throw new ProviderError(422, 'SMART_CONTRACT_SIGNER_UNAUTHORIZED', 'Configured signer is not an authorized contract operator', { provider: PROVIDER });
        }
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(502, 'SMART_CONTRACT_UNAVAILABLE', 'BSC registration preflight failed', {
          provider: PROVIDER,
          retryable: true,
          providerMessage: error?.shortMessage || error?.message,
        });
      }
      const startedAt = Date.now();
      const network = chainId === 56 ? 'bsc-mainnet' : 'bsc-testnet';
      let tx = null;
      let receipt = null;
      let submittedHash = transactionHash || null;

      try {
        if (transactionHash) {
          // A prior attempt may have broadcast successfully but timed out while
          // waiting for confirmation. Recover that exact transaction first.
          receipt = await provider.getTransactionReceipt(transactionHash);
          if (!receipt) {
            tx = await provider.getTransaction(transactionHash);
            if (!tx) {
              const error = new Error('Previously submitted transaction is not available yet');
              error.code = 'TRANSACTION_NOT_FOUND';
              error.transactionHash = transactionHash;
              throw error;
            }
          }
        } else {
          tx = await contract.registerLandData(dataHash);
          submittedHash = tx.hash;
        }

        if (!receipt) receipt = await tx.wait(1, config.smartContract.timeoutMs);
        if (receipt.status !== undefined && BigInt(receipt.status) === 0n) {
          const error = new Error('The submitted transaction was mined but reverted');
          error.code = 'TRANSACTION_REVERTED';
          error.transactionHash = submittedHash;
          throw error;
        }
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
          requestBody: { dataHash },
          responseBody: { transactionHash: submittedHash, blockNumber: receipt.blockNumber, verificationId },
          providerReference: submittedHash,
          success: true,
          durationMs: Date.now() - startedAt,
        });
        return {
          externalReference: verificationId,
          transactionHash: submittedHash,
          network,
          chainId: actualChainId,
          contractAddress,
          signerAddress: wallet.address,
          blockNumber: Number(receipt.blockNumber),
          response: {
            transactionHash: submittedHash,
            explorerUrl: `${explorerTxUrl}${submittedHash}`,
            verificationId,
            gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : null,
          },
        };
      } catch (error) {
        const originalTransactionHash = transactionHash || tx?.hash || error?.transactionHash || null;
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
          requestBody: { dataHash },
          success: false,
          errorCode: decoded || error?.code,
          errorMessage: error?.shortMessage || error?.message,
          durationMs: Date.now() - startedAt,
        });
        if (decoded === 'DuplicateVerification') {
          throw new ProviderError(409, 'SMART_CONTRACT_DUPLICATE', 'Hash already anchored on chain', {
            provider: PROVIDER,
            meta: originalTransactionHash ? { transactionHash: originalTransactionHash, chainId: actualChainId } : undefined,
          });
        }
        if (decoded === 'Unauthorized' || decoded === 'InvalidDataHash') {
          throw new ProviderError(422, 'SMART_CONTRACT_REJECTED', `Contract rejected the call (${decoded})`, { provider: PROVIDER });
        }
        if (error?.code === 'TRANSACTION_REVERTED' || (error?.receipt?.status !== undefined && BigInt(error.receipt.status) === 0n)) {
          throw new ProviderError(422, 'SMART_CONTRACT_TX_REVERTED', 'The submitted transaction was mined but reverted', {
            provider: PROVIDER,
            meta: originalTransactionHash ? { transactionHash: originalTransactionHash, chainId: actualChainId } : undefined,
          });
        }
        if (error?.code === 'INSUFFICIENT_FUNDS') {
          throw new ProviderError(503, 'SMART_CONTRACT_INSUFFICIENT_FUNDS', 'Operator wallet has insufficient gas funds', { provider: PROVIDER, retryable: true });
        }
        if (originalTransactionHash) {
          throw new ProviderError(503, 'SMART_CONTRACT_TX_PENDING', 'Transaction was submitted and is still awaiting a receipt', {
            provider: PROVIDER,
            retryable: true,
            providerMessage: error?.shortMessage || error?.message,
            meta: { transactionHash: originalTransactionHash, chainId: actualChainId },
          });
        }
        throw new ProviderError(502, 'SMART_CONTRACT_UNAVAILABLE', 'Blockchain call failed', {
          provider: PROVIDER,
          retryable: true,
          providerMessage: error?.shortMessage || error?.message,
          meta: originalTransactionHash ? { transactionHash: originalTransactionHash } : undefined,
        });
      }
    },
  };
};

module.exports = { createBscSmartContractProvider };
