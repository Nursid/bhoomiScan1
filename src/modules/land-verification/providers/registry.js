/**
 * State -> provider adapter registry. The land-verification core resolves the
 * adapter by URL slug (/land-verification/:state/...) and never imports a
 * provider directly.
 *
 *   punjab      -> Surepass  district -> tehsil -> village -> year -> khasra_number
 *   maharashtra -> Surepass  district -> taluka -> village -> survey_part_number -> survey_number
 *   bihar       -> Surepass  district -> anchal -> light -> mouza -> plot_number
 *   haryana     -> (future) another provider: add createHaryanaXAdapter() here
 */

const { notFound } = require('../../../utils/errors');
const { createPunjabSurepassAdapter } = require('./punjab-surepass.adapter');
const { createMaharashtraSurepassAdapter } = require('./maharashtra-surepass.adapter');
const { createBiharSurepassAdapter } = require('./bihar-surepass.adapter');

let adapters = null;

const build = () => {
  const list = [createPunjabSurepassAdapter(), createMaharashtraSurepassAdapter(), createBiharSurepassAdapter()];
  return new Map(list.map((adapter) => [adapter.slug, adapter]));
};

const all = () => {
  if (!adapters) adapters = build();
  return adapters;
};

const getAdapter = (slug) => {
  const adapter = all().get(String(slug || '').toLowerCase());
  if (!adapter) {
    throw notFound(`Land verification is not available for state "${slug}"`, 'STATE_NOT_SUPPORTED');
  }
  return adapter;
};

const getAdapterByStateCode = (stateCode) => {
  const adapter = [...all().values()].find((item) => item.stateCode === stateCode);
  if (!adapter) {
    throw notFound(`No provider registered for state ${stateCode}`, 'STATE_NOT_SUPPORTED');
  }
  return adapter;
};

/**
 * Form description for clients: each field in drill-down order, the fields it
 * depends on, and (for selects) the endpoint that lists its options.
 */
const describeFields = (adapter) =>
  (adapter.fields || []).map((field, index, fields) => {
    const dependsOn = fields.slice(0, index).map((item) => item.name);
    if (!field.source) return { ...field, dependsOn };
    const filters = adapter.metadataLevels[field.source].filters;
    return {
      ...field,
      dependsOn,
      options: { method: filters.length === 0 ? 'GET' : 'POST', path: `/api/v1/land-verification/${adapter.slug}/${field.source}`, body: filters },
    };
  });

const listStates = () =>
  [...all().values()].map((adapter) => ({
    slug: adapter.slug,
    stateCode: adapter.stateCode,
    label: adapter.label || adapter.slug,
    provider: adapter.provider,
    fields: describeFields(adapter),
    verify: { method: 'POST', path: `/api/v1/land-verification/${adapter.slug}/verify` },
  }));

/** Test hook: replace adapters (e.g. with a fake provider). */
const setAdapters = (list) => {
  adapters = list ? new Map(list.map((adapter) => [adapter.slug, adapter])) : null;
};

module.exports = { getAdapter, getAdapterByStateCode, listStates, setAdapters };
