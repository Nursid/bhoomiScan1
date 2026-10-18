// Pure validation only: never loads .env or opens a database connection.
const requireTestDatabaseUrl = (env = process.env) => {
  const value = env.TEST_DATABASE_URL;
  const fail = () => {
    throw new Error('Integration tests require an explicit TEST_DATABASE_URL targeting the disposable bhoomiscan_test PostgreSQL database. No database fallback is allowed.');
  };
  if (typeof value !== 'string' || !value.trim()) return fail();
  const connectionString = value.trim();
  let url;
  try {
    url = new URL(connectionString);
    // URL parsing alone accepts malformed percent escapes and strips controls.
    decodeURIComponent(connectionString);
    // PostgreSQL is a non-special URL scheme: its opaque hostname parser accepts
    // encoded whitespace and delimiters. Validate the authority as a normal host,
    // and disallow encoded hostnames rather than relying on downstream decoding.
    if (url.hostname.includes('%')) return fail();
    const hostname = new URL(`http://${url.host}`).hostname;
    if (!hostname.startsWith('[')) {
      const dnsName = hostname.replace(/\.$/, '');
      if (dnsName.length > 253 || dnsName.split('.').some((label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return fail();
    }
  } catch {
    return fail();
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
    || url.pathname !== '/bhoomiscan_test' || url.hash || /\s/.test(connectionString)) {
    return fail();
  }
  return connectionString;
};

module.exports = { requireTestDatabaseUrl };
