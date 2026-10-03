/**
 * Short-lived cache for provider metadata (district / tehsil / village / year /
 * khasra lists). Uses Redis when REDIS_URL is set, otherwise an in-process TTL
 * map. Never used as a source of truth: land-record history lives in PostgreSQL.
 *
 * Cache failures degrade to a cache miss; they never fail the request.
 */

const config = require('../config');
const logger = require('./logger');

const MEMORY_MAX_ENTRIES = 5000;

const createMemoryStore = () => {
  const entries = new Map();
  return {
    kind: 'memory',
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      if (entries.size >= MEMORY_MAX_ENTRIES) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      entries.delete(key);
    },
    async clear() {
      entries.clear();
    },
    async close() {},
  };
};

const createRedisStore = (url) => {
  // ioredis is an optional dependency; only loaded when REDIS_URL is configured.
  // eslint-disable-next-line global-require
  const Redis = require('ioredis');
  const client = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  client.on('error', (error) => logger.warn({ err: error.message }, 'redis error'));
  return {
    kind: 'redis',
    async get(key) {
      const text = await client.get(key);
      return text ? JSON.parse(text) : null;
    },
    async set(key, value, ttlSeconds) {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    },
    async del(key) {
      await client.del(key);
    },
    async clear() {},
    async close() {
      await client.quit().catch(() => {});
    },
  };
};

let store;
const getStore = () => {
  if (!store) {
    try {
      store = config.redisUrl ? createRedisStore(config.redisUrl) : createMemoryStore();
    } catch (error) {
      logger.warn({ err: error.message }, 'redis unavailable, using in-memory cache');
      store = createMemoryStore();
    }
  }
  return store;
};

const PREFIX = 'bhoomiscan:';

const get = async (key) => {
  try {
    return await getStore().get(PREFIX + key);
  } catch (error) {
    logger.warn({ err: error.message, key }, 'cache get failed');
    return null;
  }
};

const set = async (key, value, ttlSeconds = config.metadataCacheTtlSeconds) => {
  if (ttlSeconds <= 0) return;
  try {
    await getStore().set(PREFIX + key, value, ttlSeconds);
  } catch (error) {
    logger.warn({ err: error.message, key }, 'cache set failed');
  }
};

/** Returns the cached value or computes, caches and returns it. */
const wrap = async (key, ttlSeconds, compute) => {
  const cached = await get(key);
  if (cached !== null && cached !== undefined) {
    return { value: cached, cached: true };
  }
  const value = await compute();
  await set(key, value, ttlSeconds);
  return { value, cached: false };
};

const clear = async () => getStore().clear();
const close = async () => {
  if (store) {
    await store.close();
    store = null;
  }
};

module.exports = { get, set, wrap, clear, close };
