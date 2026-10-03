/**
 * SmartContractProvider factory (SMART_CONTRACT_PROVIDER = http | bsc | disabled).
 * Every provider exposes: name, isConfigured(), store({ referenceId, dataHash, propertyId, record, metadata })
 *   -> { externalReference, transactionHash, network, contractAddress, blockNumber, response }
 */

const config = require('../../config');
const { createHttpSmartContractProvider } = require('./http.provider');
const { createBscSmartContractProvider } = require('./bsc.provider');

const disabledProvider = {
  name: 'DISABLED',
  isConfigured: () => false,
  async store() {
    throw new Error('Smart contract provider is disabled');
  },
};

let override = null;

const getSmartContractProvider = () => {
  if (override) return override;
  switch (config.smartContract.provider) {
    case 'http':
      return createHttpSmartContractProvider();
    case 'bsc':
      return createBscSmartContractProvider();
    default:
      return disabledProvider;
  }
};

/** Test hook. */
const setSmartContractProvider = (provider) => {
  override = provider;
};

module.exports = { getSmartContractProvider, setSmartContractProvider };
