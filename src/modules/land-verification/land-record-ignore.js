/**
 * Ignored-field configuration shared by the normalizer and the diff engine.
 *
 * An entry is either
 *   - a key name ("request_id")   -> ignored at any depth
 *   - a dotted path ("meta.source") -> ignored at exactly that path (and below)
 * Paths use normalized key names with array selectors removed:
 *   owners[name=abc].updated_at -> owners.updated_at
 */

const config = require('../../config');

// Noise that changes on every call and says nothing about the land.
const DEFAULT_IGNORED_FIELDS = [
  'client_id',
  'request_id',
  'requestid',
  'reference_id',
  'transaction_id',
  'txn_id',
  'trace_id',
  'timestamp',
  'created_at',
  'updated_at',
  'fetched_at',
  'generated_at',
  'generated_on',
  'response_time',
  'status_code',
  'message_code',
  'success',
];

const normalizeEntry = (entry) =>
  String(entry)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();

/** Defaults (unless disabled) + LAND_DIFF_IGNORED_FIELDS + provider-specific extras. */
const resolveIgnoredFields = (providerExtras = []) => {
  const base = config.landDiff.useDefaultIgnores ? DEFAULT_IGNORED_FIELDS : [];
  return [...new Set([...base, ...config.landDiff.ignoredFields, ...providerExtras].map(normalizeEntry).filter(Boolean))];
};

const pathKey = (path) => String(path || '').replace(/\[[^\]]*\]/g, '');

const buildIgnoreMatcher = (entries) => {
  const names = new Set();
  const paths = [];
  entries.map(normalizeEntry).forEach((entry) => (entry.includes('.') ? paths.push(entry) : names.add(entry)));
  return (key, path) => {
    if (names.has(key)) return true;
    const plain = pathKey(path);
    return paths.some((p) => plain === p || plain.startsWith(`${p}.`));
  };
};

module.exports = { DEFAULT_IGNORED_FIELDS, resolveIgnoredFields, buildIgnoreMatcher, pathKey };
