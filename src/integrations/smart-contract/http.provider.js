/**
 * External Smart Contract REST API provider.
 *
 *   POST {SMART_CONTRACT_API_URL}{SMART_CONTRACT_STORE_PATH}
 *   x-api-key: <SMART_CONTRACT_API_KEY>
 *   Idempotency-Key: <referenceId>     (same snapshot never stored twice)
 *   { referenceId, dataHash, propertyId, record, metadata }
 *
 * The response is read tolerantly (id/reference/referenceId, transactionHash/txHash,
 * at top level or under `data`). 409 is treated as "already stored".
 */

const config = require('../../config');
const { createHttpClient } = require('../../utils/httpClient');
const { ProviderError } = require('../../utils/errors');

const PROVIDER = 'SMART_CONTRACT';

const mapError = ({ status, body, timedOut, networkError }) => {
  if (timedOut) return new ProviderError(504, 'SMART_CONTRACT_TIMEOUT', 'Smart contract API timed out', { provider: PROVIDER, retryable: true });
  if (networkError) {
    return new ProviderError(502, 'SMART_CONTRACT_UNREACHABLE', 'Smart contract API is unreachable', {
      provider: PROVIDER,
      retryable: true,
      providerMessage: networkError.message,
    });
  }
  const providerMessage = body?.message || body?.error?.message || body?.error || `http ${status}`;
  const common = { provider: PROVIDER, providerStatus: status, providerMessage: String(providerMessage), providerBody: body };
  if (status === 409) return new ProviderError(409, 'SMART_CONTRACT_DUPLICATE', 'Record already stored', common);
  if (status === 401 || status === 403) return new ProviderError(503, 'SMART_CONTRACT_AUTH_FAILED', 'Smart contract API credentials rejected', common);
  if (status === 408 || status === 429 || status >= 500) {
    return new ProviderError(502, 'SMART_CONTRACT_UNAVAILABLE', 'Smart contract API is temporarily unavailable', { ...common, retryable: true });
  }
  return new ProviderError(422, 'SMART_CONTRACT_REJECTED', 'Smart contract API rejected the record', common);
};

const pick = (body, ...keys) => {
  for (const source of [body, body?.data, body?.result]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
  }
  return null;
};

const createHttpSmartContractProvider = ({ fetchImpl } = {}) => {
  const client = createHttpClient({
    provider: PROVIDER,
    baseUrl: () => config.smartContract.apiUrl,
    timeoutMs: () => config.smartContract.timeoutMs,
    headers: () => (config.smartContract.apiKey ? { 'x-api-key': config.smartContract.apiKey } : {}),
    mapError,
    extractReference: (body) => pick(body, 'id', 'reference', 'referenceId', 'recordId'),
    fetchImpl,
  });

  return {
    name: 'HTTP',
    isConfigured: () => Boolean(config.smartContract.apiUrl),
    async store({ referenceId, dataHash, propertyId, record, metadata }) {
      const { body } = await client.request({
        method: 'POST',
        path: config.smartContract.storePath,
        body: { referenceId, dataHash, propertyId, record, metadata },
        headers: { 'idempotency-key': referenceId },
        operation: 'record.store',
        // The record itself is already in land_record_snapshots.
        auditRequestBody: { referenceId, dataHash, propertyId },
      });
      return {
        externalReference: pick(body, 'id', 'reference', 'referenceId', 'recordId'),
        transactionHash: pick(body, 'transactionHash', 'txHash', 'transaction_hash', 'hash'),
        network: pick(body, 'network', 'chain'),
        contractAddress: pick(body, 'contractAddress', 'contract_address'),
        blockNumber: Number(pick(body, 'blockNumber', 'block_number')) || null,
        response: body,
      };
    },
  };
};

module.exports = { createHttpSmartContractProvider, __testing: { mapError, pick } };
