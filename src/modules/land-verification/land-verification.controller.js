const registry = require('./providers/registry');
const metadataService = require('./land-metadata.service');
const service = require('./land-verification.service');
const { AppError, notFound } = require('../../utils/errors');
const { ok, paginationParams, paginationMeta } = require('../../utils/response');

const states = async (req, res) => ok(res, { states: registry.listStates() });

/**
 * GET /:state/districts (fixed level), POST /:state/:level (level from the URL).
 * Lists without parent filters are GET-only; lists with filters are POST-only.
 */
const metadata = (fixedLevel) => async (req, res) => {
  const adapter = registry.getAdapter(req.params.state);
  const level = fixedLevel || req.params.level;
  const definition = Object.hasOwn(adapter.metadataLevels, level) ? adapter.metadataLevels[level] : null;
  if (!definition || (req.method === 'GET') !== (definition.filters.length === 0)) {
    throw notFound(`Unknown list "${level}" for state "${adapter.slug}"`, 'METADATA_LEVEL_NOT_FOUND');
  }
  ok(res, await metadataService.listOptions(adapter, level, req.method === 'GET' ? {} : req.body));
};

const verify = async (req, res) => {
  const adapter = registry.getAdapter(req.params.state);
  const parsed = adapter.locatorSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Request validation failed', {
      details: parsed.error.issues.map((issue) => ({ location: 'body', field: issue.path.join('.') || 'body', message: issue.message })),
    });
  }
  ok(res, await service.verify({ userId: req.user.id, adapter, locator: parsed.data, trigger: 'MANUAL' }));
};

const list = async (req, res) => {
  const pagination = paginationParams(req.query);
  const { verifications, total } = await service.listVerifications(req.user.id, pagination);
  ok(res, { verifications }, { meta: paginationMeta(pagination, total) });
};

const get = async (req, res) => ok(res, await service.getVerification(req.user.id, req.params.id));

const history = async (req, res) => {
  const pagination = paginationParams(req.query);
  const { snapshots, total } = await service.getHistory(req.user.id, req.params.id, pagination);
  ok(res, { snapshots }, { meta: paginationMeta(pagination, total) });
};

const snapshot = async (req, res) => ok(res, await service.getSnapshot(req.user.id, req.params.id, req.params.snapshotId));

const changes = async (req, res) => {
  const pagination = paginationParams(req.query);
  const { changes: items, total } = await service.getChanges(req.user.id, req.params.id, {
    ...pagination,
    snapshotId: req.query.snapshotId,
    criticalOnly: req.query.critical === 'true',
  });
  ok(res, { changes: items }, { meta: paginationMeta(pagination, total) });
};

const monitoring = async (req, res) =>
  ok(res, { verification: await service.configureMonitoring(req.user.id, req.params.id, req.body, req.subscription) });

module.exports = { states, metadata, verify, list, get, history, snapshot, changes, monitoring };
