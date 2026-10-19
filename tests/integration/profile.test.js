// Profile completion after login: Google sign-ups need name + OTP-verified mobile,
// mobile sign-ups need a name; email is always optional.
jest.mock('../../src/integrations/firebase/firebase-admin.client', () => {
  const actual = jest.requireActual('../../src/integrations/firebase/firebase-admin.client');
  return { ...actual, verifyIdToken: jest.fn() };
});

const firebase = require('../../src/integrations/firebase/firebase-admin.client');
const { prisma, resetDb, installFetch, api, login, settle } = require('./helpers');

const REQ_ID = '36697a704157303534313839';
const GOOD_OTP = '654321'; // accepted by the fake MSG91 in helpers.installFetch
const idToken = (name) => `eyJhbGciOiJSUzI1NiJ9.${name}.c2ln`;
const IDENTITIES = {
  [idToken('asha')]: { uid: 'uid-asha', email: 'asha@example.com', emailVerified: true, name: 'Asha Rao', provider: 'google.com' },
  [idToken('noname')]: { uid: 'uid-noname', email: 'noname@example.com', emailVerified: true, name: null, provider: 'google.com' },
  [idToken('meera')]: { uid: 'uid-meera', email: 'meera@example.com', emailVerified: true, name: 'Meera', provider: 'google.com' },
};

let fake;
let app;

beforeAll(async () => {
  await resetDb();
  fake = installFetch();
  app = api();
  firebase.verifyIdToken.mockImplementation(async (token) => {
    if (IDENTITIES[token]) return IDENTITIES[token];
    throw new firebase.FirebaseAuthError('Invalid Google sign-in token', { statusCode: 401, code: 'INVALID_ID_TOKEN' });
  });
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

const googleLogin = async (name) => {
  const res = await app.post('/api/auth/google').send({ idToken: idToken(name) });
  return { ...res.body, auth: { Authorization: `Bearer ${res.body.token}` } };
};
const putProfile = (auth, body) => app.put('/api/v1/users/me/profile').set(auth).send(body);

describe('mobile OTP sign-up: name required, email optional', () => {
  test('login says what is missing; name alone completes it; email can be added, changed and removed', async () => {
    const res = await app.post('/api/auth/mobile-verify').send({ mobile: '9100000101', otp: GOOD_OTP, reqId: REQ_ID });
    expect(res.body.profile).toEqual({ complete: false, missing: ['name'] });
    const auth = { Authorization: `Bearer ${res.body.token}` };

    const missing = await putProfile(auth, {});
    expect(missing.status).toBe(422);
    expect(missing.body.error.details).toEqual([{ location: 'body', field: 'name', message: 'Name is required' }]);

    const done = await putProfile(auth, { name: '  Ram   Kumar ' });
    expect(done.status).toBe(200);
    expect(done.body.data).toEqual({
      user: { id: res.body.user.id, name: 'Ram Kumar', mobile: '+919100000101', mobileVerified: true, email: null },
      profile: { complete: true, missing: [] },
    });

    expect((await putProfile(auth, { email: 'Ram@Example.COM' })).body.data.user.email).toBe('ram@example.com');
    expect((await putProfile(auth, { email: '' })).body.data.user.email).toBeNull();

    // Cross-device sync: logging in again (e.g. on a new phone) returns the saved profile.
    await putProfile(auth, { email: 'ram@example.com' });
    const newDevice = await app.post('/api/auth/mobile-verify').send({ mobile: '9100000101', otp: GOOD_OTP, reqId: REQ_ID });
    expect(newDevice.body.user).toEqual({
      id: res.body.user.id,
      mobile: '+919100000101',
      mobileVerified: true,
      name: 'Ram Kumar',
      email: 'ram@example.com',
      loginMethod: 'mobile_otp',
      isProfileCompleted: true,
      lastLoginAt: expect.any(String),
    });
    expect(newDevice.body.profile).toEqual({ complete: true, missing: [] });
    await putProfile(auth, { email: '' });

    const me = await app.get('/api/v1/users/me').set(auth);
    expect(me.body.data.profile).toEqual({ complete: true, missing: [] });
    const again = await login(app, '9100000101');
    expect((await app.post('/api/auth/mobile-verify').send({ mobile: '9100000101', otp: GOOD_OTP, reqId: REQ_ID })).body.profile.complete).toBe(true);
    expect(again.user.id).toBe(res.body.user.id);
  });

  test('names in any script; digits, symbols and invalid email are rejected', async () => {
    const { auth } = await login(app, '9100000102');
    for (const name of ['राम कुमार', 'ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ', "D'Souza", 'A. K. Sharma-Rao']) {
      expect((await putProfile(auth, { name })).status).toBe(200);
    }
    for (const body of [{ name: 'R' }, { name: '1234' }, { name: 'Ram2' }, { name: '<b>Ram</b>' }, { name: 'Ram', email: 'not-an-email' }, { name: 'Ram', role: 'ADMIN' }]) {
      const res = await putProfile(auth, body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    const user = await prisma.user.findFirst({ where: { mobile: '+919100000102' } });
    expect(user.role).toBe('USER');
  });

  test('a user who already has a mobile cannot swap it here', async () => {
    const { auth } = await login(app, '9100000103');
    const res = await putProfile(auth, { name: 'Ravi', mobile: '9100000199', otp: GOOD_OTP, reqId: REQ_ID });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOBILE_ALREADY_SET');
    // Sending the same number again is harmless.
    expect((await putProfile(auth, { name: 'Ravi', mobile: '+91 91000 00103' })).status).toBe(200);
  });
});

describe('Google sign-up: complete without a mobile; mobile optional, no OTP needed', () => {
  test('Google user with a name is complete immediately; mobile is never "missing"', async () => {
    const g = await googleLogin('asha');
    expect(g.profile).toEqual({ complete: true, missing: [] });
    expect(g.user).toMatchObject({ mobile: null, mobileVerified: false, isProfileCompleted: true });
    const me = await app.get('/api/v1/users/me').set(g.auth);
    expect(me.body.data.profile).toEqual({ complete: true, missing: [] });
    expect((await putProfile(g.auth, { name: 'Asha Rao' })).status).toBe(200); // no mobile required
  });

  test('mobile without OTP is accepted as the contact number (PUT and PATCH)', async () => {
    const g = await googleLogin('asha');
    const put = await putProfile(g.auth, { mobile: '9100000211' });
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual({
      user: { id: g.user.id, name: 'Asha Rao', mobile: '+919100000211', mobileVerified: false, email: 'asha@example.com' },
      profile: { complete: true, missing: [] },
    });
    const patch = await app.patch('/api/v1/users/me').set(g.auth).send({ mobile: '9100000212', name: 'Asha R' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.user).toMatchObject({ mobile: '+919100000212', mobileVerified: false, name: 'Asha R' });
    expect((await app.get('/api/auth/me').set(g.auth)).body.user).toMatchObject({ mobile: '+919100000212', mobileVerified: false });
    expect((await googleLogin('asha')).user).toMatchObject({ mobile: '+919100000212', mobileVerified: false });
    // invalid number still rejected
    expect((await putProfile(g.auth, { mobile: '12' })).body.error.code).toBe('INVALID_MOBILE');
    await app.patch('/api/v1/users/me').set(g.auth).send({ name: 'Asha Rao' });
  });

  test('SECURITY: a number saved without OTP never opens the Google account via OTP login', async () => {
    const g = await googleLogin('meera');
    await putProfile(g.auth, { mobile: '9100000221' });
    // The real owner of that number logs in with OTP: they get their OWN new account.
    const owner = await login(app, '9100000221');
    expect(owner.user.id).not.toBe(g.user.id);
    const googleRow = await prisma.user.findUnique({ where: { firebaseUid: 'uid-meera' } });
    expect(googleRow).toMatchObject({ mobile: null, contactMobile: '+919100000221' });
    await prisma.user.update({ where: { id: googleRow.id }, data: { contactMobile: null } });
  });

  test('mobile with OTP is verified and becomes a login number (optional path)', async () => {
    const g = await googleLogin('asha');

    const wrongOtp = await putProfile(g.auth, { mobile: '9100000201', otp: '000000', reqId: REQ_ID });
    expect(wrongOtp.status).toBe(401);
    expect(wrongOtp.body.error.code).toBe('INVALID_OTP');
    expect((await prisma.user.findUnique({ where: { firebaseUid: 'uid-asha' } })).mobile).toBeNull();

    const ok = await putProfile(g.auth, { mobile: '9100000201', otp: GOOD_OTP, reqId: REQ_ID });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({
      user: { id: g.user.id, name: 'Asha Rao', mobile: '+919100000201', mobileVerified: true, email: 'asha@example.com' },
      profile: { complete: true, missing: [] },
    });
    expect(fake.callsTo(/verifyOtp$/).pop().body).toMatchObject({ reqId: REQ_ID, otp: GOOD_OTP });

    // The same person can now also log in with that number, into the same account.
    expect((await login(app, '9100000201')).user.id).toBe(g.user.id);
    expect((await googleLogin('asha')).profile).toEqual({ complete: true, missing: [] });
  });

  test('Google account without a name: only "name" is missing, never "mobile"', async () => {
    const g = await googleLogin('noname');
    expect(g.profile).toEqual({ complete: false, missing: ['name'] });
    const res = await putProfile(g.auth, {});
    expect(res.body.error.details.map((d) => d.field)).toEqual(['name']);
    const ok = await putProfile(g.auth, { name: 'Kiran Patel' });
    expect(ok.body.data.profile).toEqual({ complete: true, missing: [] });
  });

  test('a number that already has an account is refused (after OTP), nothing is merged', async () => {
    const existing = await login(app, '9100000203');
    const g = await googleLogin('meera');
    const res = await putProfile(g.auth, { name: 'Meera', mobile: '9100000203', otp: GOOD_OTP, reqId: REQ_ID });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MOBILE_IN_USE');
    expect((await prisma.user.findUnique({ where: { firebaseUid: 'uid-meera' } })).mobile).toBeNull();
    expect((await login(app, '9100000203')).user.id).toBe(existing.user.id);
  });

  test('requires login', async () => {
    expect((await app.put('/api/v1/users/me/profile').send({ name: 'X Y' })).status).toBe(401);
  });
});
