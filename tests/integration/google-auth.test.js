// Google login (POST /api/auth/google, /api/auth/google/link) against a real database.
// Firebase Admin is mocked at the client boundary: each fake ID token maps to a verified identity.
jest.mock('../../src/integrations/firebase/firebase-admin.client', () => {
  const actual = jest.requireActual('../../src/integrations/firebase/firebase-admin.client');
  return { ...actual, verifyIdToken: jest.fn() };
});

const firebase = require('../../src/integrations/firebase/firebase-admin.client');
const { FirebaseAuthError } = firebase;
const { prisma, resetDb, installFetch, api, login, settle } = require('./helpers');

const idToken = (name) => `eyJhbGciOiJSUzI1NiJ9.${name}.c2ln`;

const GOOGLE = { provider: 'google.com', emailVerified: true };
const IDENTITIES = {
  [idToken('asha')]: { ...GOOGLE, uid: 'uid-asha', email: 'asha@example.com', name: 'Asha Rao' },
  [idToken('ravi')]: { ...GOOGLE, uid: 'uid-ravi', email: 'ravi@example.com', name: 'Ravi K' },
  [idToken('meera')]: { ...GOOGLE, uid: 'uid-meera', email: 'meera@example.com', name: 'Meera' },
  [idToken('password')]: { uid: 'uid-pw', email: 'pw@example.com', emailVerified: true, name: null, provider: 'password' },
  [idToken('unverified')]: { ...GOOGLE, uid: 'uid-unverified', email: 'u@example.com', emailVerified: false, name: null },
};

const FIREBASE_ERRORS = {
  [idToken('expired')]: new FirebaseAuthError('Google sign-in has expired, please sign in again', { statusCode: 401, code: 'ID_TOKEN_EXPIRED' }),
  [idToken('revoked')]: new FirebaseAuthError('Google sign-in was revoked, please sign in again', { statusCode: 401, code: 'ID_TOKEN_REVOKED' }),
  [idToken('forged')]: new FirebaseAuthError('Invalid Google sign-in token', { statusCode: 401, code: 'INVALID_ID_TOKEN' }),
  [idToken('disabled')]: new FirebaseAuthError('This Google account is disabled', { statusCode: 403, code: 'FIREBASE_USER_DISABLED' }),
  [idToken('outage')]: new FirebaseAuthError('Google sign-in is temporarily unavailable', { statusCode: 503, code: 'GOOGLE_AUTH_UNAVAILABLE' }),
  [idToken('crash')]: new Error('socket hang up at 10.0.0.1 with secret xyz'),
};

const googleLogin = (app, token, extra = {}) => app.post('/api/auth/google').send({ idToken: token, ...extra });

let fake;

beforeAll(() => {
  fake = installFetch();
});

beforeEach(async () => {
  await resetDb();
  firebase.verifyIdToken.mockReset();
  firebase.verifyIdToken.mockImplementation(async (token) => {
    if (FIREBASE_ERRORS[token]) throw FIREBASE_ERRORS[token];
    if (IDENTITIES[token]) return IDENTITIES[token];
    throw new FirebaseAuthError('Invalid Google sign-in token', { statusCode: 401, code: 'INVALID_ID_TOKEN' });
  });
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

describe('POST /api/auth/google', () => {
  test('first login registers a USER account and returns the mobile-login contract { success, token, user }', async () => {
    const app = api();
    const res = await googleLogin(app, idToken('asha'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      token: expect.any(String),
      user: {
        id: expect.any(String),
        mobile: null,
        email: 'asha@example.com',
        name: 'Asha Rao',
        loginMethod: 'google',
        isProfileCompleted: false,
        lastLoginAt: expect.any(String),
      },
      profile: { complete: false, missing: ['mobile'] },
    });
    expect(firebase.verifyIdToken).toHaveBeenCalledWith(idToken('asha'));

    const record = await prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    expect(record).toMatchObject({ firebaseUid: 'uid-asha', mobile: null, role: 'USER', status: 'ACTIVE' });

    // The issued token works on protected APIs exactly like an OTP token.
    const auth = { Authorization: `Bearer ${res.body.token}` };
    const me = await app.get('/api/auth/me').set(auth);
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual({ id: record.id, mobile: null, email: 'asha@example.com', role: 'user', loginMethod: 'google' });
    const profile = await app.get('/api/v1/users/me').set(auth);
    expect(profile.status).toBe(200);
    expect(profile.body.data.user).toMatchObject({ id: record.id, mobile: null, email: 'asha@example.com' });
  });

  test('existing Google user logs into the same account (no duplicate)', async () => {
    const app = api();
    const first = await googleLogin(app, idToken('asha'));
    const second = await googleLogin(app, idToken('asha'));
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(await prisma.user.count({ where: { firebaseUid: 'uid-asha' } })).toBe(1);
  });

  test('concurrent first logins create exactly one user', async () => {
    const app = api();
    const results = await Promise.all(Array.from({ length: 6 }, () => googleLogin(app, idToken('ravi'))));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    // Any loser of the insert race gets a clean 409, never a 500 or a second row.
    results.filter((r) => r.status !== 200).forEach((r) => expect(r.status).toBe(409));
    expect(new Set(ok.map((r) => r.body.user.id)).size).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  test('identity, role and status come only from the verified token and the database', async () => {
    const app = api();
    const res = await googleLogin(app, idToken('asha'), { email: 'admin@bhoomiscan.in', uid: 'uid-admin', role: 'ADMIN', name: 'Root' });
    expect(res.status).toBe(200);
    const record = await prisma.user.findUniqueOrThrow({ where: { id: res.body.user.id } });
    expect(record).toMatchObject({ firebaseUid: 'uid-asha', email: 'asha@example.com', name: 'Asha Rao', role: 'USER' });
  });

  test('existing role is preserved on later Google logins', async () => {
    const app = api();
    const first = await googleLogin(app, idToken('asha'));
    await prisma.user.update({ where: { id: first.body.user.id }, data: { role: 'ADMIN', name: 'Renamed by admin' } });
    const again = await googleLogin(app, idToken('asha'));
    expect(again.status).toBe(200);
    const me = await app.get('/api/auth/me').set({ Authorization: `Bearer ${again.body.token}` });
    expect(me.body.user.role).toBe('admin');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: first.body.user.id } })).name).toBe('Renamed by admin');
  });

  test('blocked accounts are rejected and keep their lastLoginAt', async () => {
    const app = api();
    const first = await googleLogin(app, idToken('asha'));
    const before = await prisma.user.update({ where: { id: first.body.user.id }, data: { status: 'BLOCKED' } });
    const res = await googleLogin(app, idToken('asha'));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, error: { code: 'ACCOUNT_BLOCKED' } });
    expect(res.body.token).toBeUndefined();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: before.id } })).lastLoginAt).toEqual(before.lastLoginAt);
    // The token issued before the block stops working too.
    expect((await app.get('/api/auth/me').set({ Authorization: `Bearer ${first.body.token}` })).status).toBe(403);
  });

  test('missing or malformed idToken -> 400 without calling Firebase', async () => {
    const app = api();
    for (const body of [{}, { idToken: '' }, { idToken: 42 }, { idToken: 'not-a-jwt' }, { idToken: `a.b.${'c'.repeat(9000)}` }]) {
      const res = await app.post('/api/auth/google').send(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, message: 'idToken is required', error: { code: 'ID_TOKEN_REQUIRED' } });
    }
    expect(firebase.verifyIdToken).not.toHaveBeenCalled();
  });

  test.each([
    ['expired', 401, 'ID_TOKEN_EXPIRED'],
    ['revoked', 401, 'ID_TOKEN_REVOKED'],
    ['forged', 401, 'INVALID_ID_TOKEN'],
    ['disabled', 403, 'FIREBASE_USER_DISABLED'],
    ['outage', 503, 'GOOGLE_AUTH_UNAVAILABLE'],
    ['password', 401, 'UNSUPPORTED_SIGN_IN_PROVIDER'],
    ['unverified', 403, 'EMAIL_NOT_VERIFIED'],
  ])('%s token -> %i %s and no user is created', async (name, status, code) => {
    const res = await googleLogin(api(), idToken(name));
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, error: { code } });
    expect(res.body.token).toBeUndefined();
    expect(await prisma.user.count()).toBe(0);
  });

  test('unexpected verifier failures -> generic 500 without internal details', async () => {
    const res = await googleLogin(api(), idToken('crash'));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|10\.0\.0\.1|stack/);
  });

  test('a phone OTP account with the same email is not merged: 409 ACCOUNT_LINK_REQUIRED', async () => {
    const app = api();
    const otp = await login(app, '9876543210');
    await prisma.user.update({ where: { id: otp.user.id }, data: { email: 'Asha@Example.com' } });

    const res = await googleLogin(app, idToken('asha'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, error: { code: 'ACCOUNT_LINK_REQUIRED' } });
    expect(res.body.token).toBeUndefined();
    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otp.user.id } })).firebaseUid).toBeNull();
  });
});

describe('POST /api/auth/google/link', () => {
  test('an OTP user links Google, then Google login reaches the same account with mobile, role and subscriptions intact', async () => {
    const app = api();
    const otp = await login(app, '9876543210');
    await prisma.user.update({ where: { id: otp.user.id }, data: { email: 'asha@example.com', role: 'ADMIN' } });

    const link = await app.post('/api/auth/google/link').set(otp.auth).send({ idToken: idToken('asha') });
    expect(link.status).toBe(200);
    expect(link.body).toEqual({
      success: true,
      user: { id: otp.user.id, mobile: '+919876543210', email: 'asha@example.com', name: 'Asha Rao', googleLinked: true },
    });

    const google = await googleLogin(app, idToken('asha'));
    expect(google.status).toBe(200);
    expect(google.body.user).toMatchObject({ id: otp.user.id, mobile: '+919876543210', loginMethod: 'google' });
    const me = await app.get('/api/auth/me').set({ Authorization: `Bearer ${google.body.token}` });
    expect(me.body.user).toMatchObject({ id: otp.user.id, role: 'admin' });
    expect(await prisma.user.count()).toBe(1);

    // Linking again with the same Google account is idempotent.
    expect((await app.post('/api/auth/google/link').set(otp.auth).send({ idToken: idToken('asha') })).status).toBe(200);
    // Mobile OTP login still reaches the same account.
    expect((await login(app, '9876543210')).user.id).toBe(otp.user.id);
  });

  test('requires a login token', async () => {
    const res = await api().post('/api/auth/google/link').send({ idToken: idToken('asha') });
    expect(res.status).toBe(401);
    expect(firebase.verifyIdToken).not.toHaveBeenCalled();
  });

  test('a Google account already used by another user -> 409 GOOGLE_ACCOUNT_IN_USE', async () => {
    const app = api();
    await googleLogin(app, idToken('asha'));
    const otp = await login(app, '9876543210');
    const res = await app.post('/api/auth/google/link').set(otp.auth).send({ idToken: idToken('asha') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GOOGLE_ACCOUNT_IN_USE');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otp.user.id } })).firebaseUid).toBeNull();
  });

  test('cannot replace a different linked Google account -> 409 GOOGLE_ALREADY_LINKED', async () => {
    const app = api();
    const otp = await login(app, '9876543210');
    expect((await app.post('/api/auth/google/link').set(otp.auth).send({ idToken: idToken('asha') })).status).toBe(200);
    const res = await app.post('/api/auth/google/link').set(otp.auth).send({ idToken: idToken('meera') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GOOGLE_ALREADY_LINKED');
  });

  test('invalid Firebase token is rejected', async () => {
    const app = api();
    const otp = await login(app, '9876543210');
    const res = await app.post('/api/auth/google/link').set(otp.auth).send({ idToken: idToken('expired') });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ID_TOKEN_EXPIRED');
  });
});

describe('mobile OTP login alongside Google accounts', () => {
  test('OTP login and Google-only accounts (mobile = NULL) coexist', async () => {
    const app = api();
    await googleLogin(app, idToken('asha'));
    await googleLogin(app, idToken('ravi'));
    const otp = await login(app, '9876543210');
    expect(otp.user).toEqual({ id: expect.any(String), mobile: '+919876543210', name: null, email: null, loginMethod: 'mobile_otp', isProfileCompleted: false, lastLoginAt: expect.any(String) });
    expect(await prisma.user.count({ where: { mobile: null } })).toBe(2);
    expect(await prisma.user.count()).toBe(3);
  });
});

describe('GET /login', () => {
  test('serves the login page with a CSP for Firebase and a popup-friendly COOP', async () => {
    const res = await api().get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Continue with Google');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    expect(res.headers['content-security-policy']).toContain('https://www.gstatic.com');
    expect(res.headers['content-security-policy']).toContain('https://bhoomiscan-test.firebaseapp.com');
  });
});
