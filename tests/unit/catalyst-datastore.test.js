// Catalyst data layer: repositories (in-memory backend), ZCQL building, claim registry.
process.env.DATA_BACKEND = 'memory';

const memory = require('../../src/database/catalyst/backends/memory');
const { table, DataStoreError } = require('../../src/database/catalyst/datastore');
const registry = require('../../src/database/catalyst/registry');
const { __testing: zcql } = require('../../src/database/catalyst/backends/catalyst');
const { __testing: ds } = require('../../src/database/catalyst/datastore');

beforeEach(() => memory.reset());

const user = (n, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, mobile: `+9190000000${String(n).padStart(2, '0')}`, role: 'USER', status: 'ACTIVE', ...extra });

describe('repository (memory backend)', () => {
  test('insert -> findById round-trips types (dates with ms, JSON, booleans, null)', async () => {
    const plans = table('subscription_plans');
    const created = await plans.insert({ id: 'p1', code: 'monthly', name: 'Monthly', amount: 99900, currency: 'INR', interval: 'YEARLY', durationMonths: 12, allowedFrequencies: ['MONTHLY'], maxMonitoredLands: 5, features: { a: true }, isActive: true, sortOrder: 1, description: null });
    expect(created.createdAt).toBeInstanceOf(Date);
    const found = await plans.findById('p1');
    expect(found).toMatchObject({ amount: 99900, allowedFrequencies: ['MONTHLY'], features: { a: true }, isActive: true, description: null });
    expect(found.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  test('filters, sorting, pagination, count, OR groups, contains (case-insensitive)', async () => {
    const users = table('users');
    await users.insert([1, 2, 3, 4, 5].map((n) => user(n, { name: n % 2 ? `Ram ${n}` : `Sita ${n}`, email: n === 3 ? null : `u${n}@x.in` })));
    expect((await users.findMany({ orderBy: [['mobile', 'desc']], limit: 2, offset: 1 })).map((u) => u.mobile)).toEqual(['+919000000004', '+919000000003']);
    expect(await users.count({ name: { contains: 'ram' } })).toBe(3);
    expect(await users.count({ email: null })).toBe(1);
    expect(await users.count({ email: { not: null } })).toBe(4);
    expect(await users.count({ mobile: { in: ['+919000000001', '+919000000005', 'x'] } })).toBe(2);
    expect(await users.count({ mobile: { in: [] } })).toBe(0);
    expect(await users.count({ OR: [{ name: { startsWith: 'sita' } }, { email: null }] })).toBe(3);
  });

  test('updateWhere returns updated rows and bumps updatedAt; deleteWhere', async () => {
    const users = table('users');
    const [u] = await users.insert([user(1)]);
    await new Promise((r) => setTimeout(r, 5));
    const [updated] = await users.updateWhere({ id: u.id }, { name: 'Asha', lastLoginAt: new Date('2026-01-01T00:00:00.123Z') });
    expect(updated).toMatchObject({ name: 'Asha', lastLoginAt: new Date('2026-01-01T00:00:00.123Z') });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(u.updatedAt.getTime());
    expect(await users.deleteWhere({ id: u.id })).toBe(1);
    expect(await users.findById(u.id)).toBeNull();
  });

  test('safety: no unconditional update/delete, unknown fields rejected, required fields enforced', async () => {
    const users = table('users');
    await expect(users.updateWhere({}, { name: 'x' })).rejects.toMatchObject({ code: 'UNSAFE_UPDATE' });
    await expect(users.deleteWhere({})).rejects.toMatchObject({ code: 'UNSAFE_DELETE' });
    await expect(users.findMany({ where: { nope: 1 } })).rejects.toBeInstanceOf(DataStoreError);
    await expect(users.insert({ id: 'x', role: 'USER' })).rejects.toMatchObject({ code: 'INVALID_ROW' }); // status missing
    await users.insert(user(1));
    await expect(users.updateWhere({ id: user(1).id }, { role: null })).rejects.toMatchObject({ code: 'REQUIRED_FIELD' });
  });

  test('derived unique keys are filled on insert and cannot be changed by update', async () => {
    const lands = table('land_verifications');
    const row = { id: 'l1', userId: 'u1', stateCode: 'PUNJAB', provider: 'SUREPASS', parcelKey: 'k1', locator: { d: 1 }, status: 'PENDING', verificationCount: 0, changeCount: 0, consecutiveFailures: 0, monitoringEnabled: false };
    await lands.insert(row);
    expect(memory.__testing.tables.get('land_verifications')[0].parcel_uq).toBe('u1|PUNJAB|k1');
    await expect(lands.updateWhere({ id: 'l1' }, { parcelKey: 'k2' })).rejects.toMatchObject({ code: 'IMMUTABLE_KEY' });
  });

  test('reads collapse physical duplicates of one logical row (same id)', async () => {
    memory.__testing.tables.set('alerts', []);
    const alerts = table('alerts');
    const a = { id: 'a1', userId: 'u1', type: 'LAND_RECORD_CHANGED', severity: 'INFO', title: 't', message: 'm', status: 'UNREAD' };
    await alerts.insert(a);
    memory.__testing.tables.get('alerts').push({ ...memory.__testing.tables.get('alerts')[0], ROWID: '999' });
    expect(await alerts.findMany({ where: { userId: 'u1' } })).toHaveLength(1);
    const updated = await alerts.updateWhere({ id: 'a1' }, { status: 'READ' });
    expect(updated).toHaveLength(1);
    expect(memory.__testing.tables.get('alerts').every((r) => r.status === 'READ')).toBe(true); // both copies
  });
});

describe('ZCQL building', () => {
  test('literals escape quotes and never inline raw input', () => {
    expect(zcql.literal("O'Neil")).toBe("'O''Neil'");
    expect(zcql.literal("x' OR '1'='1")).toBe("'x'' OR ''1''=''1'");
    expect(zcql.literal(5)).toBe('5');
    expect(zcql.literal(true)).toBe('true');
    expect(zcql.literal(null)).toBe('NULL');
    expect(() => zcql.literal(Infinity)).toThrow();
    expect(zcql.likeLiteral("a*b'c", 'contains')).toBe("'*ab''c*'");
  });

  test('where clauses, empty IN short-circuits, OR groups', () => {
    const conditions = ds.compileWhere(table('users').spec, { status: 'ACTIVE', email: null, mobile: { in: ['a', 'b'] }, OR: [{ name: { contains: 'x' } }, { role: 'ADMIN' }] });
    expect(zcql.whereSql(conditions, ds.storedValue)).toBe("status = 'ACTIVE' AND email IS NULL AND mobile IN ('a', 'b') AND ((name LIKE '*x*') OR (role = 'ADMIN'))");
    expect(zcql.whereSql(ds.compileWhere(table('users').spec, { mobile: { in: [] } }), ds.storedValue)).toBeNull();
    const dates = ds.compileWhere(table('subscriptions').spec, { endsAt: { gt: new Date(1000) } });
    expect(zcql.whereSql(dates, ds.storedValue)).toBe('ends_at > 1000');
  });

  test('wide tables are split into groups of at most 19 columns (+ ROWID)', () => {
    for (const name of ['land_verifications', 'uploaded_documents', 'smart_contract_records']) {
      const groups = zcql.columnGroups(table(name).spec);
      expect(groups.every((g) => g.length <= 19)).toBe(true);
      expect(groups.flat().sort()).toEqual(table(name).spec.columns.map((c) => c.name).sort());
    }
  });
});

describe('claim registry (memory backend)', () => {
  test('first claim wins; later claims see the owner; release only by owner', async () => {
    expect(await registry.claim('user:mobile:+919000000001', 'u1')).toMatchObject({ won: true });
    expect(await registry.claim('user:mobile:+919000000001', 'u2')).toMatchObject({ won: false, current: { value: 'u1' } });
    expect(await registry.release('user:mobile:+919000000001', 'u2')).toBe(false);
    expect(await registry.release('user:mobile:+919000000001', 'u1')).toBe(true);
    expect(await registry.get('user:mobile:+919000000001')).toBeNull();
  });

  test('concurrent claims: exactly one winner', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => registry.claim('webhook:evt_1', `w${i}`)));
    expect(results.filter((r) => r.won)).toHaveLength(1);
    expect(new Set(results.map((r) => r.current.value)).size).toBe(1);
  });

  test('rejects malformed keys', async () => {
    await expect(registry.claim("bad key'", 'x')).rejects.toThrow('Invalid claim key');
  });
});
