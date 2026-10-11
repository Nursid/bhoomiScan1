// Firebase Admin client: single initialisation, verified-identity mapping and safe error mapping.
const mockVerifyIdToken = jest.fn();
const mockApps = [];

jest.mock('firebase-admin/app', () => ({
  getApps: () => mockApps,
  getApp: (name) => mockApps.find((app) => app.name === name),
  initializeApp: jest.fn((options, name) => {
    const app = { name, options };
    mockApps.push(app);
    return app;
  }),
  cert: jest.fn((serviceAccount) => ({ kind: 'cert', projectId: serviceAccount.project_id })),
  applicationDefault: jest.fn(() => ({ kind: 'adc' })),
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn(() => ({ verifyIdToken: mockVerifyIdToken })) }));

const { initializeApp } = require('firebase-admin/app');
const config = require('../../src/config');
const firebase = require('../../src/integrations/firebase/firebase-admin.client');

const authError = (code, message = 'firebase says no') => Object.assign(new Error(message), { code });

beforeEach(() => {
  mockVerifyIdToken.mockReset();
});

describe('firebase-admin client', () => {
  test('verifies with Firebase Admin and returns only the verified identity fields', async () => {
    mockVerifyIdToken.mockResolvedValue({
      uid: 'uid-1',
      email: 'Asha@Example.com',
      email_verified: true,
      name: 'Asha',
      picture: 'https://x',
      admin: true,
      firebase: { sign_in_provider: 'google.com' },
    });
    await expect(firebase.verifyIdToken('a.b.c')).resolves.toEqual({
      uid: 'uid-1',
      email: 'asha@example.com',
      emailVerified: true,
      name: 'Asha',
      provider: 'google.com',
    });
    expect(mockVerifyIdToken).toHaveBeenCalledWith('a.b.c', config.firebase.checkRevoked);
  });

  test('initialises one named Firebase app and reuses it', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u', firebase: {} });
    await firebase.verifyIdToken('a.b.c');
    await firebase.verifyIdToken('a.b.c');
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(initializeApp).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'bhoomiscan-test' }), firebase.__testing.APP_NAME);
  });

  test('missing email_verified is treated as unverified', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'u', email: 'x@example.com', firebase: { sign_in_provider: 'google.com' } });
    expect((await firebase.verifyIdToken('a.b.c')).emailVerified).toBe(false);
  });

  test.each([
    ['auth/id-token-expired', 401, 'ID_TOKEN_EXPIRED'],
    ['auth/id-token-revoked', 401, 'ID_TOKEN_REVOKED'],
    ['auth/user-disabled', 403, 'FIREBASE_USER_DISABLED'],
    ['auth/user-not-found', 401, 'INVALID_ID_TOKEN'],
    ['auth/argument-error', 401, 'INVALID_ID_TOKEN'],
    ['auth/internal-error', 503, 'GOOGLE_AUTH_UNAVAILABLE'],
    ['app/network-error', 503, 'GOOGLE_AUTH_UNAVAILABLE'],
    ['', 401, 'INVALID_ID_TOKEN'],
  ])('%s -> %i %s with a safe message', async (code, statusCode, appCode) => {
    mockVerifyIdToken.mockRejectedValue(authError(code, 'Firebase ID token has invalid signature. secret-detail'));
    const error = await firebase.verifyIdToken('a.b.c').catch((e) => e);
    expect(error).toBeInstanceOf(firebase.FirebaseAuthError);
    expect(error).toMatchObject({ statusCode, code: appCode });
    expect(error.message).not.toMatch(/secret-detail|signature/);
  });

  test('Google public-key download failures are 503, not "invalid token"', async () => {
    mockVerifyIdToken.mockRejectedValue(authError('auth/argument-error', 'Error fetching public keys for Google certs: ECONNRESET'));
    await expect(firebase.verifyIdToken('a.b.c')).rejects.toMatchObject({ statusCode: 503, code: 'GOOGLE_AUTH_UNAVAILABLE' });
  });

  test('not configured -> 503 GOOGLE_LOGIN_NOT_CONFIGURED without calling Firebase', async () => {
    const original = config.firebase.projectId;
    config.firebase.projectId = '';
    try {
      expect(firebase.isConfigured()).toBe(false);
      await expect(firebase.verifyIdToken('a.b.c')).rejects.toMatchObject({ statusCode: 503, code: 'GOOGLE_LOGIN_NOT_CONFIGURED' });
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    } finally {
      config.firebase.projectId = original;
    }
  });
});

describe('auth.service readIdToken', () => {
  const { readIdToken } = require('../../src/modules/auth/auth.service').__testing;

  test('accepts a compact JWS and trims it', () => {
    expect(readIdToken({ idToken: ' aa.bb.cc ' })).toBe('aa.bb.cc');
  });

  test.each([[undefined], [{}], [{ idToken: null }], [{ idToken: ['a.b.c'] }], [{ idToken: 'a.b' }], [{ idToken: 'a.b.c<script>' }]])(
    'rejects %j with 400 ID_TOKEN_REQUIRED',
    (body) => {
      expect(() => readIdToken(body)).toThrow(expect.objectContaining({ statusCode: 400, code: 'ID_TOKEN_REQUIRED' }));
    },
  );
});
