/**
 * Hardhat project for the LandVerification contract.
 *
 * Reads the API's own ../.env, so the deployer is the same OPERATOR_PRIVATE_KEY the
 * API's bsc provider (src/integrations/smart-contract/bsc.provider.js) signs with.
 * The deployer becomes the contract owner and an authorized operator.
 */

require('@nomicfoundation/hardhat-toolbox');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const privateKey = (process.env.OPERATOR_PRIVATE_KEY || '').trim();
const accounts = privateKey ? [privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: { chainId: 1337 },
    bscTestnet: {
      url: process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/',
      chainId: 97,
      accounts,
    },
    bscMainnet: {
      url: 'https://bsc-dataseed1.binance.org/',
      chainId: 56,
      accounts,
    },
  },
};
