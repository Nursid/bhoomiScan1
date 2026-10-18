/**
 * One-time setup of server-side access to Catalyst Data Store (Zoho OAuth Self Client).
 *
 *  1. https://api-console.zoho.in -> Self Client -> copy Client ID / Client Secret
 *  2. Generate Code with the scopes below (time duration 10 minutes)
 *  3. Put in .env:  CATALYST_OAUTH_CLIENT_ID, CATALYST_OAUTH_CLIENT_SECRET, CATALYST_OAUTH_GRANT_CODE
 *  4. node scripts/catalyst/oauth-setup.js
 *
 * Exchanges the one-time grant code for a refresh token and writes it to .env as
 * CATALYST_OAUTH_REFRESH_TOKEN (the grant code line is removed). No secret is printed.
 */

const fs = require('fs');
const path = require('path');

const SCOPES = [
  'ZohoCatalyst.tables.ALL',
  'ZohoCatalyst.tables.rows.ALL',
  'ZohoCatalyst.tables.columns.ALL',
  'ZohoCatalyst.tables.bulk.READ',
  'ZohoCatalyst.tables.bulk.CREATE',
  'ZohoCatalyst.zcql.CREATE',
  // NoSQL table `bhoomi_locks`: atomic "insert if absent" for locks and idempotency.
  'ZohoCatalyst.nosql.READ',
  'ZohoCatalyst.nosql.rows.ALL',
];

const ENV_FILE = path.resolve(process.cwd(), '.env');

const readEnv = () => {
  const text = fs.readFileSync(ENV_FILE, 'utf8');
  const get = (key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '') || '';
  return { text, get };
};

const main = async () => {
  if (process.argv.includes('--scopes')) {
    console.log(SCOPES.join(','));
    return;
  }
  const { text, get } = readEnv();
  const accountsUrl = get('CATALYST_ACCOUNTS_URL') || 'https://accounts.zoho.in';
  const clientId = get('CATALYST_OAUTH_CLIENT_ID');
  const clientSecret = get('CATALYST_OAUTH_CLIENT_SECRET');
  const code = get('CATALYST_OAUTH_GRANT_CODE');
  const missing = [['CATALYST_OAUTH_CLIENT_ID', clientId], ['CATALYST_OAUTH_CLIENT_SECRET', clientSecret], ['CATALYST_OAUTH_GRANT_CODE', code]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(', ')}`);
    console.error(`Generate the code with these scopes:\n${SCOPES.join(',')}`);
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.refresh_token) {
    // Zoho answers e.g. { error: "invalid_code" } (expired / already used) or "invalid_client".
    console.error(`Token exchange failed: ${body.error || `HTTP ${response.status}`}. Generate a new code and retry (codes expire and work once).`);
    process.exitCode = 1;
    return;
  }

  const granted = String(body.scope || '').split(/[ ,]+/).filter(Boolean);
  let next = text.replace(/^CATALYST_OAUTH_GRANT_CODE=.*\r?\n?/m, '');
  next = /^CATALYST_OAUTH_REFRESH_TOKEN=.*$/m.test(next)
    ? next.replace(/^CATALYST_OAUTH_REFRESH_TOKEN=.*$/m, `CATALYST_OAUTH_REFRESH_TOKEN=${body.refresh_token}`)
    : `${next.replace(/\s*$/, '')}\nCATALYST_OAUTH_REFRESH_TOKEN=${body.refresh_token}\n`;
  fs.writeFileSync(ENV_FILE, next);

  console.log(`OK: refresh token saved to .env (CATALYST_OAUTH_REFRESH_TOKEN). API domain: ${body.api_domain || 'n/a'}`);
  if (granted.length) {
    const absent = SCOPES.filter((scope) => !granted.includes(scope));
    console.log(absent.length ? `WARNING: scopes not granted: ${absent.join(', ')}` : `All ${SCOPES.length} required scopes granted.`);
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
