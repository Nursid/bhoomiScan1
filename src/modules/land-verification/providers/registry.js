/**
 * State -> provider adapter registry. The land-verification core resolves the
 * adapter by URL slug (/land-verification/:state/...) and never imports a
 * provider directly.
 *
 *   punjab  -> Surepass
 *   haryana -> (future) another provider: add createHaryanaXAdapter() here
 */

const { notFound } = require('../../../utils/errors');
const { createPunjabSurepassAdapter } = require('./punjab-surepass.adapter');

let adapters = null;

const build = () => {
  const list = [createPunjabSurepassAdapter()];
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

const listStates = () => [...all().values()].map((adapter) => ({ slug: adapter.slug, stateCode: adapter.stateCode, provider: adapter.provider }));

/** Test hook: replace adapters (e.g. with a fake provider). */
const setAdapters = (list) => {
  adapters = list ? new Map(list.map((adapter) => [adapter.slug, adapter])) : null;
};

module.exports = { getAdapter, getAdapterByStateCode, listStates, setAdapters };
