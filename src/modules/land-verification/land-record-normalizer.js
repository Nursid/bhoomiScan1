/**
 * Turns a provider's land record into a canonical "comparison form", so that two
 * fetches of an unchanged record produce identical output (and the same hash):
 *
 *   - key names unified:   "ownerName" / "Owner Name" / "owner-name" -> "owner_name"
 *   - strings:             Unicode NFC, whitespace collapsed, trimmed, lower-cased
 *   - numbers:             stringified (5 and "5" are equal); "1.50" -> "1.5"
 *   - empty values:        "", "-", "NA", "N/A", null, {}, []  -> dropped
 *                          (a field that disappears and a field that becomes empty are the same)
 *   - ignored fields:      request ids, timestamps... removed (configurable)
 *   - arrays:              sorted canonically unless listed in `orderedArrays`
 *                          (providers reorder owner lists between calls)
 *   - key order:           irrelevant (canonical JSON when hashing)
 *
 * The normalizer is provider-agnostic; provider adapters pass options.
 */

const { canonicalStringify, hashCanonical } = require('../../utils/canonicalJson');
const { buildIgnoreMatcher, pathKey } = require('./land-record-ignore');

const DEFAULT_NULL_PLACEHOLDERS = ['', '-', '--', '---', 'na', 'n/a', 'n.a.', 'nil', 'null', 'none', 'undefined'];

const normalizeKey = (key) =>
  String(key)
    .normalize('NFC')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s\-./]+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();

const DECIMAL = /^-?\d+\.\d+$/;

const normalizeScalar = (value, nullPlaceholders) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  let text = String(value).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (nullPlaceholders.has(text)) return null;
  if (DECIMAL.test(text)) {
    text = text.replace(/0+$/, '').replace(/\.$/, '');
  }
  return text;
};

const isEmpty = (value) =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

/**
 * @param {*} record provider record (object)
 * @param {object} [options]
 * @param {string[]} [options.ignoredFields]   key names (any depth) or dotted paths
 * @param {string[]} [options.orderedArrays]   dotted paths whose order is meaningful
 * @param {string[]} [options.nullPlaceholders]
 * @returns {object} canonical comparison form
 */
const normalizeRecord = (record, options = {}) => {
  const isIgnored = buildIgnoreMatcher(options.ignoredFields || []);
  const ordered = new Set(options.orderedArrays || []);
  const nullPlaceholders = new Set((options.nullPlaceholders || DEFAULT_NULL_PLACEHOLDERS).map((item) => item.toLowerCase()));

  const walk = (value, path) => {
    if (Array.isArray(value)) {
      const items = value.map((item) => walk(item, path)).filter((item) => !isEmpty(item));
      if (!ordered.has(pathKey(path))) {
        items.sort((a, b) => {
          const left = canonicalStringify(a);
          const right = canonicalStringify(b);
          return left < right ? -1 : left > right ? 1 : 0;
        });
      }
      return items;
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [rawKey, child] of Object.entries(value)) {
        const key = normalizeKey(rawKey);
        if (!key) continue;
        const childPath = path ? `${path}.${key}` : key;
        if (isIgnored(key, childPath)) continue;
        const normalized = walk(child, childPath);
        if (!isEmpty(normalized)) {
          // Two raw keys collapsing to one name: keep a deterministic winner.
          out[key] = key in out && canonicalStringify(out[key]) > canonicalStringify(normalized) ? out[key] : normalized;
        }
      }
      return out;
    }
    return normalizeScalar(value, nullPlaceholders);
  };

  const result = walk(record ?? {}, '');
  return result && typeof result === 'object' && !Array.isArray(result) ? result : { value: result };
};

const hashRecord = (normalized) => hashCanonical(normalized);

module.exports = { normalizeRecord, hashRecord, normalizeKey, normalizeScalar, DEFAULT_NULL_PLACEHOLDERS };
