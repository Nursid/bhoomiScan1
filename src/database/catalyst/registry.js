/**
 * Claim registry: atomic "first writer wins" keys, backed by the Catalyst NoSQL table
 * `bhoomi_locks` (partition key `lock_key`). This is the ONLY uniqueness / idempotency /
 * locking primitive the application relies on, because it is the only Catalyst operation
 * verified to be atomic under concurrency (20 simultaneous claimants -> exactly one
 * winner, repeated rounds; Data Store unique columns and conditional UPDATEs are not).
 *
 *   const { claim } = require('../database/catalyst/registry');
 *   const { won, current } = await claim('user:mobile:+919876543210', newUserId);
 *   // won    -> this caller owns the key (and must now write its row)
 *   // !won   -> current.value is the owner's value (e.g. the existing user id)
 *
 * Keys are permanent by default. Keys that should expire carry `expiresAt`, used only for
 * Catalyst TTL clean-up; correctness never depends on an expired key disappearing
 * (callers use attempt-scoped keys instead of taking over stale locks).
 *
 * A Catalyst 500 / timeout on a claim means "outcome unknown": the key is read back and
 * the caller won only if the stored value is its own.
 */

const logger = require('../../utils/logger');

let backend = null;
const getBackend = () => {
  if (!backend) {
    backend = process.env.DATA_BACKEND === 'memory' ? require('./backends/memory').registry : require('./backends/catalyst').registry;
  }
  return backend;
};
const setBackend = (next) => {
  backend = next;
};

const KEY_PATTERN = /^[A-Za-z0-9:_.+@|\-]{1,512}$/;

const assertKey = (key) => {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new Error(`Invalid claim key: ${String(key).slice(0, 80)}`);
};

/**
 * @param {string} key
 * @param {string} value     what the winner stores (usually the id of the row it creates)
 * @param {object} [options]
 * @param {Date}   [options.expiresAt]  TTL clean-up only
 * @param {object} [options.data]       small JSON payload stored with the claim
 * @returns {Promise<{ won: boolean, current: { value: string, expiresAt: Date|null, data: object|null } }>}
 */
const claim = async (key, value, options = {}) => {
  assertKey(key);
  const result = await getBackend().claim(key, String(value), options);
  if (!result.won) logger.debug?.({ key }, 'claim already taken');
  return result;
};

const get = async (key) => {
  assertKey(key);
  return getBackend().get(key);
};

/** Removes the key only if it is still owned by `value`. */
const release = async (key, value) => {
  assertKey(key);
  return getBackend().release(key, String(value));
};

module.exports = { claim, get, release, setBackend };
