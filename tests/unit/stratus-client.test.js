jest.mock('../../src/config', () => ({
  stratus: {
    bucketName: 'bhoomiscan-documents',
    bucketUrl: 'https://bhoomiscan-documents-development.zohostratus.in',
    projectId: '81575000000055001',
    oauthClientId: 'test-client-id',
    oauthClientSecret: 'test-client-secret',
    oauthRefreshToken: 'test-refresh-token',
    accountsUrl: 'https://accounts.zoho.in',
    apiUrl: 'https://api.catalyst.zoho.in',
    timeoutMs: 30000,
    maxFileBytes: 10 * 1024 * 1024,
  },
}));

const stratus = require('../../src/integrations/stratus/stratus.client');
const originalFetch = global.fetch;
const tokenResponse = (token = 'mock-access-token') => new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });

describe('Zoho Catalyst Stratus REST client', () => {
  beforeEach(() => {
    stratus.__testing.resetTokenCache();
    global.fetch = jest.fn();
  });

  afterAll(() => { global.fetch = originalFetch; });

  test('refreshes an India-region OAuth token and uploads to the configured private bucket object URL', async () => {
    global.fetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(null, { status: 200 }));
    const bytes = Buffer.from('%PDF-stratus');
    await expect(stratus.upload({ key: 'documents/user/doc-id', bytes, contentType: 'application/pdf' }))
      .resolves.toEqual({ objectKey: 'documents/user/doc-id' });

    expect(global.fetch.mock.calls[0][0]).toBe('https://accounts.zoho.in/oauth/v2/token');
    const form = global.fetch.mock.calls[0][1].body;
    expect(form).toBeInstanceOf(URLSearchParams);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('test-refresh-token');
    expect(form.get('client_id')).toBe('test-client-id');
    expect(form.get('client_secret')).toBe('test-client-secret');
    expect(global.fetch.mock.calls[1][0]).toBe('https://bhoomiscan-documents-development.zohostratus.in/documents/user/doc-id');
    expect(global.fetch.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: bytes, redirect: 'error' });
    expect(global.fetch.mock.calls[1][1].headers.authorization).toBe('Zoho-oauthtoken mock-access-token');
    expect(global.fetch.mock.calls[1][1].headers['content-type']).toBe('application/pdf');
  });

  test('retrieves authenticated raw bytes and rejects a stored-size mismatch', async () => {
    const bytes = Buffer.from('%PDF-read');
    global.fetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(bytes, {
      status: 200, headers: { 'content-length': String(bytes.length) },
    }));
    await expect(stratus.download({ key: 'documents/user/doc-id', expectedSize: bytes.length })).resolves.toEqual(bytes);

    global.fetch.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    await expect(stratus.download({ key: 'documents/user/doc-id', expectedSize: bytes.length + 1 }))
      .rejects.toMatchObject({ code: 'STRATUS_FILE_SIZE_MISMATCH' });
  });

  test('refreshes once after an expired access token response', async () => {
    global.fetch.mockResolvedValueOnce(tokenResponse('expired-token'))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(tokenResponse('fresh-token'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await stratus.upload({ key: 'documents/user/doc-id', bytes: Buffer.from('x'), contentType: 'image/png' });
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://accounts.zoho.in/oauth/v2/token',
      'https://bhoomiscan-documents-development.zohostratus.in/documents/user/doc-id',
      'https://accounts.zoho.in/oauth/v2/token',
      'https://bhoomiscan-documents-development.zohostratus.in/documents/user/doc-id',
    ]);
    expect(global.fetch.mock.calls[3][1].headers.authorization).toBe('Zoho-oauthtoken fresh-token');
  });

  test('coalesces concurrent OAuth refreshes into one request', async () => {
    let resolveOAuth;
    global.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveOAuth = resolve; }));
    const first = stratus.__testing.refreshAccessToken();
    const second = stratus.__testing.refreshAccessToken();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    resolveOAuth(tokenResponse('shared-token'));
    await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('does not expose OAuth response details when refresh is rejected', async () => {
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'invalid_client',
      error_description: 'mock-secret-must-not-escape',
    }), { status: 400 }));

    await expect(stratus.__testing.refreshAccessToken()).rejects.toMatchObject({
      code: 'STRATUS_AUTH_FAILED',
      message: 'Stratus authentication is unavailable',
    });
  });

  test('fails closed when Stratus rejects an upload', async () => {
    global.fetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(stratus.upload({ key: 'documents/user/doc-id', bytes: Buffer.from('x'), contentType: 'image/png' }))
      .rejects.toMatchObject({ code: 'STRATUS_UPLOAD_FAILED' });
  });

  test('uses only the unique attempted object key for delayed Stratus cleanup', async () => {
    global.fetch.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response(null, { status: 200 }));
    const generatedObjectKey = 'verification-tests/attempt-id.txt';
    await expect(stratus.deleteUnreferenced(generatedObjectKey)).resolves.toBe(true);
    const [url, options] = global.fetch.mock.calls[1];
    expect(String(url)).toBe('https://api.catalyst.zoho.in/baas/v1/project/81575000000055001/bucket/object?bucket_name=bhoomiscan-documents');
    expect(options.method).toBe('PUT');
    expect(options.headers.environment).toBe('Development');
    expect(JSON.parse(options.body)).toEqual({ objects: [{ key: generatedObjectKey }], ttl_in_seconds: 60 });
  });

  test('reports cleanup HTTP status and sanitized provider message without secrets or object key', async () => {
    global.fetch.mockResolvedValueOnce(tokenResponse('sensitive-access-token')).mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'failure',
      data: { message: 'Scope denied; test-client-secret test-refresh-token sensitive-access-token verification-tests/private-key.txt' },
    }), { status: 403 }));

    const error = await stratus.deleteUnreferenced('verification-tests/private-key.txt').catch((caught) => caught);
    expect(error).toMatchObject({ code: 'STRATUS_CLEANUP_FAILED' });
    expect(error.message).toContain('HTTP 403');
    expect(error.message).toContain('Scope denied');
    expect(error.message).not.toContain('test-client-secret');
    expect(error.message).not.toContain('test-refresh-token');
    expect(error.message).not.toContain('sensitive-access-token');
    expect(error.message).not.toContain('verification-tests/private-key.txt');
  });
});
