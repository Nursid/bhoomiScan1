jest.mock('../../src/database/prisma', () => ({ prisma: {} }));
jest.mock('../../src/config', () => ({
  ...jest.requireActual('../../src/config'),
  corsOrigins: ['https://client.example'],
  apiDocsEnabled: false,
}));

const request = require('supertest');
const { createApp } = require('../../src/app');

describe('document upload browser access', () => {
  const previousDisableCors = process.env.DISABLE_APP_CORS;

  beforeAll(() => { delete process.env.DISABLE_APP_CORS; });
  afterAll(() => {
    if (previousDisableCors === undefined) delete process.env.DISABLE_APP_CORS;
    else process.env.DISABLE_APP_CORS = previousDisableCors;
  });

  test('allows an approved origin to upload with authentication and the original filename', async () => {
    const response = await request(createApp())
      .options('/api/v1/documents')
      .set('Origin', 'https://client.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,x-file-name');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://client.example');
    const allowed = response.headers['access-control-allow-headers'].toLowerCase().split(',').map((value) => value.trim());
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'content-type', 'x-file-name']));
  });

  test('still requires authentication after a successful browser preflight', async () => {
    const response = await request(createApp())
      .post('/api/v1/documents')
      .set('Origin', 'https://client.example')
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', 'sample.pdf')
      .send(Buffer.from('%PDF-local-test'));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_REQUIRED');
  });
});
