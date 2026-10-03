const { diffRecords, summarize } = require('../../src/modules/land-verification/land-record-diff.service');

describe('diffRecords', () => {
  test('identical records produce no changes', () => {
    expect(diffRecords({ a: '1', b: { c: '2' } }, { b: { c: '2' }, a: '1' })).toEqual([]);
  });

  test('detects ADD, REMOVE and UPDATE', () => {
    const changes = diffRecords({ owner_name: 'abc', area: '10', old: 'x' }, { owner_name: 'xyz', area: '10', added: 'y' });
    expect(changes).toEqual([
      { type: 'ADD', field: 'added', oldValue: null, newValue: 'y', isCritical: false },
      { type: 'REMOVE', field: 'old', oldValue: 'x', newValue: null, isCritical: false },
      { type: 'UPDATE', field: 'owner_name', oldValue: 'abc', newValue: 'xyz', isCritical: false },
    ]);
  });

  test('nested objects produce dotted paths', () => {
    const changes = diffRecords({ details: { owner: { father: 'a' } } }, { details: { owner: { father: 'b' } } });
    expect(changes).toEqual([expect.objectContaining({ type: 'UPDATE', field: 'details.owner.father', oldValue: 'a', newValue: 'b' })]);
  });

  test('unkeyed arrays compare as multisets (order ignored)', () => {
    expect(diffRecords({ list: ['a', 'b'] }, { list: ['b', 'a'] })).toEqual([]);
    const changes = diffRecords({ list: ['a', 'b', 'b'] }, { list: ['b', 'c'] });
    expect(changes.map((c) => [c.type, c.field, c.oldValue ?? c.newValue])).toEqual([
      ['REMOVE', 'list[]', 'a'],
      ['REMOVE', 'list[]', 'b'],
      ['ADD', 'list[]', 'c'],
    ]);
  });

  test('keyed arrays match items by identity and diff their fields', () => {
    const previous = { owners: [{ name: 'ram', share: '1/2' }, { name: 'sham', share: '1/2' }] };
    const current = { owners: [{ name: 'sham', share: '1/3' }, { name: 'ram', share: '1/2' }, { name: 'geeta', share: '1/6' }] };
    const changes = diffRecords(previous, current, { arrayKeys: { owners: ['name'] } });
    expect(changes).toEqual([
      expect.objectContaining({ type: 'UPDATE', field: 'owners[name=sham].share', oldValue: '1/2', newValue: '1/3' }),
      expect.objectContaining({ type: 'ADD', field: 'owners[name=geeta]', newValue: { name: 'geeta', share: '1/6' } }),
    ]);
  });

  test('ordered arrays compare by index', () => {
    const changes = diffRecords({ rows: ['a', 'b'] }, { rows: ['b', 'a', 'c'] }, { orderedArrays: ['rows'] });
    expect(changes.map((c) => `${c.type}:${c.field}`)).toEqual(['UPDATE:rows[0]', 'UPDATE:rows[1]', 'ADD:rows[2]']);
  });

  test('configured ignored fields are skipped (names and paths)', () => {
    const changes = diffRecords(
      { request_id: '1', meta: { fetched: 'a' }, owner: 'x' },
      { request_id: '2', meta: { fetched: 'b' }, owner: 'x' },
      { ignoredFields: ['request_id', 'meta.fetched'] },
    );
    expect(changes).toEqual([]);
  });

  test('critical fields are flagged', () => {
    const changes = diffRecords({ owner_name: 'a', colour: 'red' }, { owner_name: 'b', colour: 'blue' }, { criticalFields: ['owner'] });
    expect(changes.find((c) => c.field === 'owner_name').isCritical).toBe(true);
    expect(changes.find((c) => c.field === 'colour').isCritical).toBe(false);
  });

  test('type change is an UPDATE', () => {
    expect(diffRecords({ a: 'x' }, { a: { b: 'x' } })).toEqual([expect.objectContaining({ type: 'UPDATE', field: 'a', oldValue: 'x', newValue: { b: 'x' } })]);
  });

  test('no previous record: everything is ADD', () => {
    expect(diffRecords(null, { a: '1' })).toEqual([expect.objectContaining({ type: 'ADD', field: 'a' })]);
  });

  test('summarize counts', () => {
    const changes = diffRecords({ a: '1', b: '2' }, { a: '2', c: '3' }, { criticalFields: ['^a$'] });
    expect(summarize(changes)).toEqual({ total: 3, added: 1, removed: 1, updated: 1, critical: 1 });
  });
});
