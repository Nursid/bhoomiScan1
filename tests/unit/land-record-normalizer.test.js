const { normalizeRecord, hashRecord, normalizeKey } = require('../../src/modules/land-verification/land-record-normalizer');
const { resolveIgnoredFields } = require('../../src/modules/land-verification/land-record-ignore');

const ignoredFields = resolveIgnoredFields();

describe('normalizeKey', () => {
  test.each([
    ['ownerName', 'owner_name'],
    ['Owner Name', 'owner_name'],
    ['owner-name', 'owner_name'],
    ['OWNER_NAME', 'owner_name'],
    ['khasra.no', 'khasra_no'],
  ])('%s -> %s', (input, expected) => expect(normalizeKey(input)).toBe(expected));
});

describe('normalizeRecord', () => {
  test('key order, whitespace, case and number types do not matter', () => {
    const a = normalizeRecord({ ownerName: '  Ram   Singh ', area: 12, share: '1.50', village: 'Abu Said' }, { ignoredFields });
    const b = normalizeRecord({ village: 'abu said', share: '1.5', area: '12', owner_name: 'RAM SINGH' }, { ignoredFields });
    expect(a).toEqual(b);
    expect(hashRecord(a)).toBe(hashRecord(b));
  });

  test('ignored metadata fields are removed at any depth', () => {
    const result = normalizeRecord(
      { client_id: 'abc', timestamp: '2026-01-01', owner: { name: 'x', updated_at: 'now', request_id: 'r1' } },
      { ignoredFields },
    );
    expect(result).toEqual({ owner: { name: 'x' } });
  });

  test('empty placeholders are dropped (missing == empty)', () => {
    const result = normalizeRecord({ a: '', b: '-', c: 'NA', d: null, e: [], f: {}, g: 'kept' }, { ignoredFields });
    expect(result).toEqual({ g: 'kept' });
  });

  test('array order is ignored by default but kept for ordered paths', () => {
    const one = { owners: [{ name: 'b' }, { name: 'a' }], rows: ['2', '1'] };
    const two = { owners: [{ name: 'a' }, { name: 'b' }], rows: ['1', '2'] };
    expect(normalizeRecord(one, { ignoredFields })).toEqual(normalizeRecord(two, { ignoredFields }));
    expect(normalizeRecord(one, { ignoredFields, orderedArrays: ['rows'] })).not.toEqual(
      normalizeRecord(two, { ignoredFields, orderedArrays: ['rows'] }),
    );
  });

  test('dotted ignore paths only ignore that path', () => {
    const result = normalizeRecord({ meta: { source: 'x', name: 'y' }, source: 'z' }, { ignoredFields: ['meta.source'] });
    expect(result).toEqual({ meta: { name: 'y' }, source: 'z' });
  });

  test('a real value change changes the hash', () => {
    const a = normalizeRecord({ owner_name: 'ABC' }, { ignoredFields });
    const b = normalizeRecord({ owner_name: 'XYZ' }, { ignoredFields });
    expect(hashRecord(a)).not.toBe(hashRecord(b));
    expect(hashRecord(a)).toMatch(/^0x[a-f0-9]{64}$/);
  });
});

describe('resolveIgnoredFields', () => {
  test('includes defaults', () => {
    expect(ignoredFields).toEqual(expect.arrayContaining(['request_id', 'timestamp', 'created_at', 'updated_at', 'transaction_id', 'client_id']));
  });
});
