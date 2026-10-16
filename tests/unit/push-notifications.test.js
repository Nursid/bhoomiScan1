// FCM client (batching, dead-token classification, string data), push wording and field labels.
const mockSend = jest.fn();
jest.mock('firebase-admin/messaging', () => ({ getMessaging: () => ({ sendEachForMulticast: mockSend }) }));
jest.mock('../../src/integrations/firebase/firebase-admin.client', () => ({ getFirebaseApp: () => ({ name: 'test' }) }));

const messaging = require('../../src/integrations/firebase/firebase-messaging.client');
const { landVerificationMessage } = require('../../src/modules/notifications/notifications.service');
const { describeField } = require('../../src/modules/land-verification/land-record-labels');

beforeEach(() => mockSend.mockReset());

describe('firebase-messaging.client', () => {
  test('sends notification + string-only data; counts delivered, dead and transient tokens', async () => {
    mockSend.mockResolvedValue({
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/invalid-registration-token' } },
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    });
    const result = await messaging.sendToTokens(['t1', 't2', 't3', 't4'], {
      title: 'Everything is good ✅',
      body: 'Abu Said: no changes.',
      data: { changes: 0, verificationId: 'v1', skip: null, nested: { a: 1 } },
    });
    expect(result).toEqual({ delivered: 1, deadTokens: ['t2', 't3'], transientErrors: ['messaging/internal-error'] });
    const message = mockSend.mock.calls[0][0];
    expect(message).toMatchObject({ tokens: ['t1', 't2', 't3', 't4'], notification: { title: 'Everything is good ✅', body: 'Abu Said: no changes.' } });
    expect(message.data).toEqual({ changes: '0', verificationId: 'v1', nested: '{"a":1}' });
    expect(message.android.priority).toBe('high');
  });

  test('splits more than 500 tokens into FCM-sized batches', async () => {
    mockSend.mockImplementation(async ({ tokens }) => ({ responses: tokens.map(() => ({ success: true })) }));
    const tokens = Array.from({ length: 1201 }, (_, i) => `t${i}`);
    expect((await messaging.sendToTokens(tokens, { title: 't', body: 'b' })).delivered).toBe(1201);
    expect(mockSend.mock.calls.map(([m]) => m.tokens.length)).toEqual([500, 500, 201]);
  });
});

describe('landVerificationMessage', () => {
  const at = new Date('2026-10-12T06:00:00Z');
  test.each([
    ['INITIAL', { total: 0, critical: 0 }, 'LAND_VERIFIED', 'Land record verified', "Abu Said: record saved. We'll notify you if anything changes."],
    ['UNCHANGED', { total: 0, critical: 0 }, 'LAND_UNCHANGED', 'Everything is good ✅', 'Abu Said: no changes since 12 Oct 2026.'],
    ['CHANGED', { total: 2, critical: 0 }, 'LAND_CHANGED', 'Your land record has changed', 'Abu Said: 2 change(s) found. Tap to see old vs new.'],
    ['CHANGED', { total: 3, critical: 1 }, 'LAND_CHANGED', '⚠️ Important change in your land record', 'Abu Said: 3 change(s) found (1 important). Tap to see old vs new.'],
  ])('%s %j', (snapshotStatus, summary, type, title, body) => {
    expect(landVerificationMessage({ snapshotStatus, displayName: 'Abu Said', summary, previousVerifiedAt: at })).toEqual({ type, title, body });
  });

  test('falls back when the parcel has no display name', () => {
    expect(landVerificationMessage({ snapshotStatus: 'UNCHANGED', displayName: null, summary: { total: 0, critical: 0 }, previousVerifiedAt: null }).body).toBe('Your land: no changes.');
  });
});

describe('describeField', () => {
  test.each([
    ['owners[name=Ram Singh].share', 'Owners', 'Owners (Ram Singh) › Share'],
    ['rows[2].area', 'Rows', 'Rows #3 › Area'],
    ['owner_details.father_name', 'Owner details', 'Owner details › Father name'],
    ['owner_details[]', 'Owner details', 'Owner details'],
    ['khataNumber', 'Khata number', 'Khata number'],
    ['plot[khasra=12/3.5].area', 'Plot', 'Plot (12/3.5) › Area'],
    ['(root)', 'Record', 'Record'],
  ])('%s', (field, section, label) => {
    expect(describeField(field)).toMatchObject({ section, label });
  });

  test('keeps machine-readable path parts', () => {
    expect(describeField('owners[name=Ram].share').path).toEqual([{ key: 'owners' }, { match: 'Ram' }, { key: 'share' }]);
  });
});
