/**
 * In-memory backend for tests (DATA_BACKEND=memory). Mirrors the Catalyst behaviour the
 * application relies on and that was verified live (docs/CATALYST_DATA_STORE_ASSESSMENT.md):
 *   - Catalyst IsUnique columns (only `id`, see schema.js) reject a later duplicate with DUPLICATE_VALUE
 *   - a multi-row insert into one table is all-or-nothing
 *   - SELECT pages are at most 300 rows
 *   - NoSQL conditional insert: exactly one claimant wins a key
 * Being single-threaded it cannot reproduce Catalyst's race on unique columns; the
 * application must therefore never rely on Data Store uniqueness for correctness.
 */

const { CatalystError } = require('../client');

const MAX_PAGE = 300;

const tables = new Map(); // table -> array of records
let rowSeq = 1;

const rows = (name) => {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name);
};

const likeMatch = (haystack, needle, mode) => {
  const h = String(haystack).toLowerCase();
  const n = String(needle).toLowerCase();
  return mode === 'startsWith' ? h.startsWith(n) : h.includes(n);
};

const compare = (a, b) => (a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : a < b ? -1 : 1);

const matches = (record, conditions, storedValue) =>
  conditions.every((condition) => {
    if (condition.or) return condition.or.some((group) => matches(record, group, storedValue));
    const { column, op, value } = condition;
    const actual = record[column.name] ?? null;
    switch (op) {
      case 'isNull':
        return value ? actual === null : actual !== null;
      case 'equals':
        return actual === storedValue(column, value);
      case 'not':
        return actual !== storedValue(column, value);
      case 'in':
        return value.map((v) => storedValue(column, v)).includes(actual);
      case 'notIn':
        return !value.map((v) => storedValue(column, v)).includes(actual);
      case 'gt':
        return actual !== null && actual > storedValue(column, value);
      case 'gte':
        return actual !== null && actual >= storedValue(column, value);
      case 'lt':
        return actual !== null && actual < storedValue(column, value);
      case 'lte':
        return actual !== null && actual <= storedValue(column, value);
      case 'contains':
      case 'startsWith':
        return actual !== null && likeMatch(actual, value, op);
      default:
        throw new Error(`memory backend: unsupported operator ${op}`);
    }
  });

const uniqueColumns = (name) => {
  const { TABLES } = require('../datastore');
  return TABLES[name].columns.filter((column) => column.dbUnique).map((column) => column.name);
};

const datastore = {
  async insert(name, records) {
    const existing = rows(name);
    const uniques = uniqueColumns(name);
    // all-or-nothing: validate the whole batch first
    for (const [index, record] of records.entries()) {
      for (const column of uniques) {
        const value = record[column];
        if (value === null || value === undefined) continue;
        const clash = existing.some((r) => r[column] === value) || records.slice(0, index).some((r) => r[column] === value);
        if (clash) throw new CatalystError(`Catalyst: Duplicate value for ${column}. Please give a different value`, { status: 409, code: 'DUPLICATE_VALUE' });
      }
    }
    const stored = records.map((record) => ({ ...record, ROWID: String(rowSeq++) }));
    existing.push(...stored);
    return stored.map((record) => ({ ...record }));
  },

  async select(name, { conditions, order, limit, offset = 0, storedValue }) {
    const found = rows(name)
      .filter((record) => matches(record, conditions, storedValue))
      .sort((a, b) => {
        for (const { column, direction } of order) {
          const c = compare(a[column.name] ?? null, b[column.name] ?? null);
          if (c !== 0) return direction === 'desc' ? -c : c;
        }
        return compare(Number(a.ROWID), Number(b.ROWID));
      });
    const end = limit === undefined ? found.length : offset + limit;
    return found.slice(offset, end).map((record) => ({ ...record }));
  },

  async count(name, { conditions, storedValue }) {
    return rows(name).filter((record) => matches(record, conditions, storedValue)).length;
  },

  async update(name, { conditions, set, storedValue }) {
    const updated = [];
    for (const record of rows(name)) {
      if (matches(record, conditions, storedValue)) {
        Object.assign(record, set);
        updated.push({ ...record });
      }
    }
    return updated;
  },

  async remove(name, { conditions, storedValue }) {
    const list = rows(name);
    const keep = list.filter((record) => !matches(record, conditions, storedValue));
    const removed = list.length - keep.length;
    tables.set(name, keep);
    return removed;
  },
};

/* ----------------------------- NoSQL registry ----------------------------- */

const claims = new Map(); // key -> { value, expiresAt, data }

const registry = {
  async claim(key, value, { expiresAt = null, data = null } = {}) {
    if (claims.has(key)) return { won: false, current: { ...claims.get(key) } };
    claims.set(key, { value, expiresAt, data });
    return { won: true, current: { value, expiresAt, data } };
  },
  async get(key) {
    return claims.has(key) ? { ...claims.get(key) } : null;
  },
  async release(key, value) {
    const current = claims.get(key);
    if (current && current.value === value) {
      claims.delete(key);
      return true;
    }
    return false;
  },
};

const reset = () => {
  tables.clear();
  claims.clear();
  rowSeq = 1;
};

module.exports = { datastore, registry, reset, MAX_PAGE, __testing: { tables, claims } };
