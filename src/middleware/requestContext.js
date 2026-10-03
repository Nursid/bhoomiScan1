/** Assigns a request id (honours a safe inbound x-request-id) and opens the async context. */

const { randomUUID } = require('crypto');
const requestContext = require('../utils/requestContext');

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

const requestContextMiddleware = (req, res, next) => {
  const inbound = req.get('x-request-id');
  const requestId = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  req.id = requestId;
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId }, next);
};

module.exports = requestContextMiddleware;
