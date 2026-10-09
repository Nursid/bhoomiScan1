/**
 * Drill-down metadata, cached (Redis or memory) because it changes rarely and
 * provider calls cost money. Levels and their required parent filters are
 * state-specific (adapter.metadataLevels), e.g.
 *   punjab:      districts -> tehsils -> villages -> years -> khasras
 *   maharashtra: districts -> talukas -> villages -> survey-numbers
 *   bihar:       districts -> anchals -> lights -> mouzas
 * Filters are validated before any provider call, so a child list is never
 * requested with a missing parent. Cache keys include state, level and every filter.
 */

const { z } = require('zod');
const config = require('../../config');
const cache = require('../../utils/cache');
const { sha256Hex, canonicalStringify } = require('../../utils/canonicalJson');
const { AppError, notFound } = require('../../utils/errors');

const filtersSchemaFor = (adapter, level) => {
  const definition = adapter.metadataLevels[level];
  if (!definition) throw notFound(`Unknown metadata list "${level}"`, 'METADATA_LEVEL_NOT_FOUND');
  const shape = Object.fromEntries(definition.filters.map((name) => [name, adapter.filterSchemas[name]]));
  return z.object(shape).strict();
};

const parseFilters = (adapter, level, body) => {
  const result = filtersSchemaFor(adapter, level).safeParse(body ?? {});
  if (!result.success) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Request validation failed', {
      details: result.error.issues.map((issue) => ({ location: 'body', field: issue.path.join('.') || 'body', message: issue.message })),
    });
  }
  return result.data;
};

const listOptions = async (adapter, level, body) => {
  const filters = parseFilters(adapter, level, body);
  const cacheFilters = Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value).toLowerCase()]));
  const key = `meta:${adapter.slug}:${adapter.provider}:${level}:${sha256Hex(canonicalStringify(cacheFilters)).slice(0, 32)}`;
  const { value, cached } = await cache.wrap(key, config.metadataCacheTtlSeconds, () => adapter.listOptions(level, filters));
  return { state: adapter.slug, level, filters, options: value, count: value.length, cached };
};

module.exports = { listOptions, __testing: { parseFilters } };
