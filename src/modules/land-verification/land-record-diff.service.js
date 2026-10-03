/**
 * Difference engine: compares two normalized land records and lists every
 * meaningful change as
 *
 *   { type: "ADD" | "REMOVE" | "UPDATE", field, oldValue, newValue, isCritical }
 *
 * - nested objects:  recursive, paths like "owner_details.father_name"
 * - arrays:
 *     keyed     (options.arrayKeys["owners"] = ["name"]) -> items matched by identity,
 *                then compared field by field: "owners[name=abc].share"
 *     ordered   (options.orderedArrays includes path)      -> index by index: "rows[2].area"
 *     otherwise set semantics (order ignored)             -> whole items ADD / REMOVE: "owners[]"
 * - ignored fields (key names or dotted paths) are skipped even if present in
 *   old snapshots that were normalized before the ignore list changed
 * - isCritical: field path matches one of options.criticalFields (regex sources)
 *
 * Pure function, no I/O. Intended input is normalizer output, but raw objects work.
 */

const { canonicalStringify } = require('../../utils/canonicalJson');
const { buildIgnoreMatcher, pathKey } = require('./land-record-ignore');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const equal = (a, b) => canonicalStringify(a) === canonicalStringify(b);

const join = (path, key) => (path ? `${path}.${key}` : key);

const identityOf = (item, keys) => {
  if (!isPlainObject(item)) return null;
  const parts = keys.map((key) => item[key]);
  if (parts.some((part) => part === undefined || part === null)) return null;
  return parts.map((part) => (typeof part === 'object' ? canonicalStringify(part) : String(part))).join('|');
};

/**
 * @param {object} previous normalized previous record (null/undefined = nothing before)
 * @param {object} current  normalized current record
 * @param {object} [options]
 * @param {string[]} [options.ignoredFields]
 * @param {Object<string,string[]>} [options.arrayKeys]   dotted array path -> identity keys
 * @param {string[]} [options.orderedArrays]
 * @param {string[]} [options.criticalFields]            regex sources tested against the field path
 * @returns {Array<{type:string, field:string, oldValue:*, newValue:*, isCritical:boolean}>}
 */
const diffRecords = (previous, current, options = {}) => {
  const isIgnored = buildIgnoreMatcher(options.ignoredFields || []);
  const arrayKeys = options.arrayKeys || {};
  const ordered = new Set(options.orderedArrays || []);
  const critical = (options.criticalFields || []).map((source) => new RegExp(source, 'i'));
  const changes = [];

  const push = (type, field, oldValue, newValue) => {
    changes.push({
      type,
      field,
      oldValue: oldValue === undefined ? null : oldValue,
      newValue: newValue === undefined ? null : newValue,
      isCritical: critical.some((pattern) => pattern.test(pathKey(field))),
    });
  };

  const compareArrays = (a, b, path) => {
    const plain = pathKey(path);
    const keys = arrayKeys[plain];

    if (keys && keys.length) {
      const index = (list) => {
        const map = new Map();
        const unkeyed = [];
        list.forEach((item) => {
          const id = identityOf(item, keys);
          if (id === null || map.has(id)) unkeyed.push(item);
          else map.set(id, item);
        });
        return { map, unkeyed };
      };
      const left = index(a);
      const right = index(b);
      const label = (item) => keys.map((key) => `${key}=${item[key]}`).join(',');
      for (const [id, item] of left.map) {
        if (right.map.has(id)) walk(item, right.map.get(id), `${path}[${label(item)}]`);
        else push('REMOVE', `${path}[${label(item)}]`, item, null);
      }
      for (const [id, item] of right.map) {
        if (!left.map.has(id)) push('ADD', `${path}[${label(item)}]`, null, item);
      }
      compareAsSets(left.unkeyed, right.unkeyed, path);
      return;
    }

    if (ordered.has(plain)) {
      const length = Math.max(a.length, b.length);
      for (let i = 0; i < length; i += 1) {
        if (i >= b.length) push('REMOVE', `${path}[${i}]`, a[i], null);
        else if (i >= a.length) push('ADD', `${path}[${i}]`, null, b[i]);
        else walk(a[i], b[i], `${path}[${i}]`);
      }
      return;
    }

    compareAsSets(a, b, path);
  };

  // Multiset comparison: duplicates count, order never does.
  const compareAsSets = (a, b, path) => {
    const counts = new Map();
    b.forEach((item) => {
      const key = canonicalStringify(item);
      const entry = counts.get(key) || { item, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    });
    a.forEach((item) => {
      const key = canonicalStringify(item);
      const entry = counts.get(key);
      if (entry && entry.count > 0) entry.count -= 1;
      else push('REMOVE', `${path}[]`, item, null);
    });
    for (const { item, count } of counts.values()) {
      for (let i = 0; i < count; i += 1) push('ADD', `${path}[]`, null, item);
    }
  };

  const walk = (a, b, path) => {
    if (equal(a, b)) return;

    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const childPath = join(path, key);
        if (isIgnored(key, childPath)) continue;
        const inA = a[key] !== undefined && a[key] !== null;
        const inB = b[key] !== undefined && b[key] !== null;
        if (inA && !inB) push('REMOVE', childPath, a[key], null);
        else if (!inA && inB) push('ADD', childPath, null, b[key]);
        else if (inA && inB) walk(a[key], b[key], childPath);
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      compareArrays(a, b, path);
      return;
    }

    // Scalars, or a type change (e.g. string -> object).
    push('UPDATE', path || '(root)', a, b);
  };

  walk(isPlainObject(previous) ? previous : {}, isPlainObject(current) ? current : {}, '');
  return changes;
};

const summarize = (changes) => ({
  total: changes.length,
  added: changes.filter((change) => change.type === 'ADD').length,
  removed: changes.filter((change) => change.type === 'REMOVE').length,
  updated: changes.filter((change) => change.type === 'UPDATE').length,
  critical: changes.filter((change) => change.isCritical).length,
});

module.exports = { diffRecords, summarize };
