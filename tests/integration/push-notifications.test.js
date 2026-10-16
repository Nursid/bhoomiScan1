// Push notifications after land verification + the old/new/changes comparison API.
// FCM is mocked at the client boundary; everything else (DB outbox, job, routes) is real.
jest.mock('../../src/integrations/firebase/firebase-messaging.client', () => {
  const actual = jest.requireActual('../../src/integrations/firebase/firebase-messaging.client');
  return { ...actual, isConfigured: jest.fn(() => true), sendToTokens: jest.fn() };
});

const messaging = require('../../src/integrations/firebase/firebase-messaging.client');
const notifications = require('../../src/modules/notifications/notifications.service');
const landVerification = require('../../src/modules/land-verification/land-verification.service');
const { prisma, resetDb, installFetch, api, login, giveActiveSubscription, settle } = require('./helpers');

const SP = 'https://sandbox\\.surepass\\.test/api/v1/land-verification/punjab';
const LOCATOR = { district: 'amritsar', tehsil: 'ajnala', village: 'abu said', year: '2020 - 2021', khasra_number: '14//6/2---1' };
const TOKEN_A = `fcm-token-android-${'a'.repeat(40)}`;
const TOKEN_B = `fcm-token-ios-${'b'.repeat(40)}`;

let landData;
const baseRecord = () => ({
  district: 'Amritsar',
  tehsil: 'Ajnala',
  village: 'Abu Said',
  year: '2020 - 2021',
  khasra_number: '14//6/2---1',
  khewat_no: '45',
  owner_details: [
    { owner_name: 'Gurpreet Singh', father_name: 'Harbans Singh', share: '1/2' },
    { owner_name: 'Manjit Kaur', father_name: 'Harbans Singh', share: '1/2' },
  ],
  area: '0-12-5',
});

let fake;
let app;
let owner;

const waitFor = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Waits until the immediate send settled the notification created by a verify call. */
const settled = (notificationId) =>
  waitFor(async () => {
    const n = await prisma.notification.findUnique({ where: { id: notificationId } });
    return n && (n.status !== 'PENDING' || n.attempts > 0) && !n.lockedUntil ? n : null;
  });

const verify = () => app.post('/api/v1/land-verification/punjab/verify').set(owner.auth).send(LOCATOR);

beforeAll(async () => {
  await resetDb();
  fake = installFetch();
  fake.on('POST', new RegExp(`${SP}$`), (url, init, body) =>
    body.khasra_number === '99/9'
      ? { status: 422, body: { success: false, status_code: 422, message: 'No record found' } }
      : { body: { success: true, status_code: 200, data: { ...landData, client_id: `land_${Math.random()}` } } },
  );
  fake.on('POST', /^https:\/\/contracts\.test\/records$/, () => ({ status: 201, body: { id: `sc_${Math.random()}`, transactionHash: `0x${'1'.repeat(64)}` } }));
  app = api();
  owner = await login(app, '9822222222');
  await giveActiveSubscription(owner.user.id, 'quarterly');
});

beforeEach(() => {
  messaging.isConfigured.mockReturnValue(true);
  messaging.sendToTokens.mockReset();
  messaging.sendToTokens.mockImplementation(async (tokens) => ({ delivered: tokens.length, deadTokens: [], transientErrors: [] }));
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

describe('device registration', () => {
  test('register, refresh, move between accounts, remove, validate', async () => {
    const res = await app.post('/api/v1/devices').set(owner.auth).send({ token: TOKEN_A, platform: 'android' });
    expect(res.status).toBe(201);
    expect(res.body.data.device).toMatchObject({ platform: 'ANDROID' });
    expect((await app.post('/api/v1/devices').set(owner.auth).send({ token: TOKEN_A, platform: 'ANDROID' })).status).toBe(201);
    expect(await prisma.deviceToken.count({ where: { token: TOKEN_A } })).toBe(1);

    // Same phone, another account logs in: the token moves.
    const other = await login(app, '9833333333');
    await app.post('/api/v1/devices').set(other.auth).send({ token: TOKEN_A, platform: 'android' });
    expect((await prisma.deviceToken.findUnique({ where: { token: TOKEN_A } })).userId).toBe(other.user.id);
    // Removing someone else's token does nothing.
    expect((await app.delete('/api/v1/devices').set(owner.auth).send({ token: TOKEN_A })).body.data.removed).toBe(0);
    expect((await app.delete('/api/v1/devices').set(other.auth).send({ token: TOKEN_A })).body.data.removed).toBe(1);

    for (const body of [{ token: 'short', platform: 'android' }, { token: TOKEN_A, platform: 'windows' }, { token: `${TOKEN_A} x`, platform: 'ios' }, { token: TOKEN_A }]) {
      expect((await app.post('/api/v1/devices').set(owner.auth).send(body)).status).toBe(422);
    }
    expect((await app.post('/api/v1/devices').send({ token: TOKEN_A, platform: 'android' })).status).toBe(401);

    await app.post('/api/v1/devices').set(owner.auth).send({ token: TOKEN_A, platform: 'android' });
    await app.post('/api/v1/devices').set(owner.auth).send({ token: TOKEN_B, platform: 'ios' });
  });
});

describe('push after verification + comparison', () => {
  let verificationId;
  let unchangedSnapshotId;

  test('first verification -> "Land record verified" push to every device; inbox entry', async () => {
    landData = baseRecord();
    const res = await verify();
    expect(res.status).toBe(200);
    verificationId = res.body.data.verificationId;
    const n = await settled(res.body.data.notificationId);

    expect(n).toMatchObject({ type: 'LAND_VERIFIED', title: 'Land record verified', status: 'SENT', deliveredCount: 2, attempts: 1 });
    const [tokens, message] = messaging.sendToTokens.mock.calls[0];
    expect(tokens.sort()).toEqual([TOKEN_A, TOKEN_B].sort());
    expect(message.data).toMatchObject({ screen: 'LAND_COMPARISON', verificationId, status: 'INITIAL', changes: 0, type: 'LAND_VERIFIED', notificationId: n.id });

    const inbox = await app.get('/api/v1/notifications').set(owner.auth);
    expect(inbox.body.data.notifications[0]).toMatchObject({ id: n.id, title: 'Land record verified', delivery: 'SENT', landVerificationId: verificationId });
  });

  test('no change -> "Everything is good ✅"; comparison shows identical old/new and no changes', async () => {
    const res = await verify();
    expect(res.body.data.status).toBe('UNCHANGED');
    unchangedSnapshotId = res.body.data.currentVerification;
    const n = await settled(res.body.data.notificationId);
    expect(n).toMatchObject({ type: 'LAND_UNCHANGED', title: 'Everything is good ✅', status: 'SENT' });
    expect(n.body).toMatch(/no changes since \d{1,2} \w{3} \d{4}\./);

    const cmp = await app.get(`/api/v1/land-verification/${verificationId}/comparison`).set(owner.auth);
    expect(cmp.status).toBe(200);
    expect(cmp.body.data).toMatchObject({ status: 'UNCHANGED', hasChanges: false, changes: [], headline: { title: 'Everything is good ✅' }, summary: { total: 0 } });
    expect(cmp.body.data.old.record).toEqual(cmp.body.data.new.record);
  });

  test('owner change -> change push; comparison returns old, new and labelled differences', async () => {
    landData = baseRecord();
    landData.owner_details[1] = { owner_name: 'Simran Kaur', father_name: 'Harbans Singh', share: '1/2' };
    landData.remarks = 'Mutation 1234 sanctioned';
    const res = await verify();
    expect(res.body.data.status).toBe('CHANGED');
    const n = await settled(res.body.data.notificationId);
    expect(n).toMatchObject({ type: 'LAND_CHANGED', status: 'SENT' });
    expect(n.title).toBe('⚠️ Important change in your land record');
    expect(n.body).toMatch(/3 change\(s\) found \(\d+ important\)\. Tap to see old vs new\./);
    expect(messaging.sendToTokens.mock.calls[0][1].data).toMatchObject({ status: 'CHANGED', changes: 3 });

    const cmp = (await app.get(`/api/v1/land-verification/${verificationId}/comparison`).set(owner.auth)).body.data;
    expect(cmp).toMatchObject({
      verificationId,
      status: 'CHANGED',
      hasChanges: true,
      headline: { title: n.title, body: n.body },
      summary: { total: 3, added: 2, removed: 1 },
      land: { state: 'PUNJAB' },
    });
    expect(cmp.old.record.owner_details.map((o) => o.owner_name)).toContain('manjit kaur');
    expect(cmp.new.record.owner_details.map((o) => o.owner_name)).toContain('simran kaur');
    expect(cmp.old.record.remarks).toBeUndefined();
    expect(cmp.new.record.remarks).toBe('mutation 1234 sanctioned');
    expect(cmp.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'REMOVE', field: 'owner_details[]', section: 'Owner details', label: 'Owner details', oldValue: expect.objectContaining({ owner_name: 'manjit kaur' }), newValue: null }),
        expect.objectContaining({ type: 'ADD', field: 'owner_details[]', newValue: expect.objectContaining({ owner_name: 'simran kaur' }), oldValue: null }),
        expect.objectContaining({ type: 'ADD', field: 'remarks', label: 'Remarks', oldValue: null, newValue: 'mutation 1234 sanctioned', isCritical: true }),
      ]),
    );
    // Critical changes come first.
    const flags = cmp.changes.map((c) => c.isCritical);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));

    // An earlier result is still reachable by snapshotId.
    const earlier = (await app.get(`/api/v1/land-verification/${verificationId}/comparison?snapshotId=${unchangedSnapshotId}`).set(owner.auth)).body.data;
    expect(earlier).toMatchObject({ snapshotId: unchangedSnapshotId, status: 'UNCHANGED', hasChanges: false });
  });

  test('comparison is private and validated', async () => {
    const stranger = await login(app, '9844444444');
    expect((await app.get(`/api/v1/land-verification/${verificationId}/comparison`).set(stranger.auth)).status).toBe(404);
    expect((await app.get(`/api/v1/land-verification/${verificationId}/comparison?snapshotId=nope`).set(owner.auth)).status).toBe(422);
  });

  test('scheduled (background) verification notifies too', async () => {
    const result = await landVerification.reverify(verificationId, 'SCHEDULED');
    const n = await settled(result.notificationId);
    expect(n).toMatchObject({ type: 'LAND_UNCHANGED', status: 'SENT', userId: owner.user.id });
  });

  test('failed verification creates no notification (outbox is part of the transaction)', async () => {
    const before = await prisma.notification.count();
    const res = await app.post('/api/v1/land-verification/punjab/verify').set(owner.auth).send({ ...LOCATOR, khasra_number: '99/9' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.notification.count()).toBe(before);
  });
});

describe('delivery outcomes', () => {
  test('push not configured -> SKIPPED, nothing sent', async () => {
    messaging.isConfigured.mockReturnValue(false);
    const n = await settled((await verify()).body.data.notificationId);
    expect(n).toMatchObject({ status: 'SKIPPED', lastError: 'PUSH_NOT_CONFIGURED' });
    expect(messaging.sendToTokens).not.toHaveBeenCalled();
  });

  test('dead tokens are removed; if none are left the notification is SKIPPED', async () => {
    messaging.sendToTokens.mockResolvedValueOnce({ delivered: 0, deadTokens: [TOKEN_A, TOKEN_B], transientErrors: [] });
    const n = await settled((await verify()).body.data.notificationId);
    expect(n).toMatchObject({ status: 'SKIPPED', lastError: 'NO_VALID_DEVICES' });
    expect(await prisma.deviceToken.count({ where: { userId: owner.user.id } })).toBe(0);

    const none = await settled((await verify()).body.data.notificationId);
    expect(none).toMatchObject({ status: 'SKIPPED', lastError: 'NO_DEVICES' });
  });

  test('FCM outage -> retried with backoff by the job, then SENT; gives up as FAILED after max attempts', async () => {
    await app.post('/api/v1/devices').set(owner.auth).send({ token: TOKEN_A, platform: 'android' });
    messaging.sendToTokens.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'messaging/server-unavailable' }));
    const first = await settled((await verify()).body.data.notificationId);
    expect(first).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'messaging/server-unavailable' });
    expect(first.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Not due yet: the job leaves it alone.
    expect((await notifications.processDue()).claimed).toBe(0);
    await prisma.notification.update({ where: { id: first.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const summary = await notifications.processDue();
    expect(summary).toMatchObject({ claimed: 1, sent: 1 });
    expect(await prisma.notification.findUnique({ where: { id: first.id } })).toMatchObject({ status: 'SENT', attempts: 2 });

    // Always failing: stops at PUSH_MAX_ATTEMPTS.
    messaging.sendToTokens.mockResolvedValue({ delivered: 0, deadTokens: [], transientErrors: ['messaging/internal-error'] });
    const failing = await settled((await verify()).body.data.notificationId);
    for (let i = 0; i < 10 && (await prisma.notification.findUnique({ where: { id: failing.id } })).status === 'PENDING'; i += 1) {
      await prisma.notification.update({ where: { id: failing.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await notifications.processDue();
    }
    expect(await prisma.notification.findUnique({ where: { id: failing.id } })).toMatchObject({ status: 'FAILED', attempts: 5, lastError: 'messaging/internal-error' });
  });

  test('the job and the immediate send never deliver the same notification twice', async () => {
    let release;
    messaging.sendToTokens.mockImplementation(
      (tokens) => new Promise((resolve) => { release = () => resolve({ delivered: tokens.length, deadTokens: [], transientErrors: [] }); }),
    );
    const res = await verify();
    await waitFor(() => messaging.sendToTokens.mock.calls.length === 1);
    // While the immediate send is in flight, the job finds nothing to claim (lease).
    expect((await notifications.processDue()).claimed).toBe(0);
    release();
    expect(await settled(res.body.data.notificationId)).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(messaging.sendToTokens).toHaveBeenCalledTimes(1);
  });
});
