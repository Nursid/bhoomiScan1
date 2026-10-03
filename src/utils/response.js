/**
 * Response envelope used by every endpoint:
 *   success: { success: true, data, meta? }
 *   error:   { success: false, error: { code, message, details? }, requestId }
 */

const ok = (res, data, { status = 200, meta } = {}) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

const created = (res, data, options = {}) => ok(res, data, { ...options, status: 201 });

const paginationParams = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};

const paginationMeta = ({ page, limit }, total) => ({ page, limit, total, totalPages: Math.ceil(total / limit) });

module.exports = { ok, created, paginationParams, paginationMeta };
