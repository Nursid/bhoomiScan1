/**
 * Deterministic JSON + hashing. Key order never affects the output, so two
 * records with the same content always produce the same hash.
 * (Adapted from the reference backend's server/landHasher.js canonicalizeJson.)
 */

const { createHash } = require('crypto');

/** Returns a copy with object keys sorted recursively; drops undefined/functions. */
const canonicalize = (value) => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalize(item)));
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const val = value[key];
    if (val !== undefined && typeof val !== 'function' && typeof val !== 'symbol') {
      out[key] = canonicalize(val);
    }
  }
  return out;
};

const canonicalStringify = (value) => JSON.stringify(canonicalize(value));

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** 0x-prefixed sha256 (bytes32 compatible) of the canonical JSON form. */
const hashCanonical = (value) => `0x${sha256Hex(canonicalStringify(value))}`;

module.exports = { canonicalize, canonicalStringify, sha256Hex, hashCanonical };
