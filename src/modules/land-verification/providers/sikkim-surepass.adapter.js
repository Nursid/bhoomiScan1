/**
 * Sikkim -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> subdivision -> revenue_circle -> revenue_block -> plot_number
 *
 *   GET  /sikkim/meta/district-list
 *   POST /sikkim/meta/subdivision-list      { district }
 *   POST /sikkim/meta/revenue-circle-list   { district, subdivision }
 *   POST /sikkim/meta/revenue-block-list    { district, subdivision, revenue_circle }
 *   POST /sikkim                            { district, subdivision, revenue_circle, revenue_block, plot_number }
 *
 * Surepass has no plot-number list for Sikkim, so plot_number is entered by the user.
 * Values are passed verbatim, including Surepass's own spelling ("gangtok sub-divison").
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'SIKKIM',
  slug: 'sikkim',
  label: 'Sikkim',
  propertyPrefix: 'SK',
  levels: {
    districts: { list: 'district-list', filters: [] },
    subdivisions: { list: 'subdivision-list', filters: ['district'] },
    'revenue-circles': { list: 'revenue-circle-list', filters: ['district', 'subdivision'] },
    'revenue-blocks': { list: 'revenue-block-list', filters: ['district', 'subdivision', 'revenue_circle'] },
  },
  schemas: {
    district: placeName('district'),
    subdivision: placeName('subdivision'),
    revenue_circle: placeName('revenue_circle'),
    revenue_block: placeName('revenue_block'),
    plot_number: parcelNumber('plot_number'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'subdivision', label: 'Subdivision', input: 'select', source: 'subdivisions' },
    { name: 'revenue_circle', label: 'Revenue Circle', input: 'select', source: 'revenue-circles' },
    { name: 'revenue_block', label: 'Revenue Block', input: 'select', source: 'revenue-blocks' },
    { name: 'plot_number', label: 'Plot Number', input: 'text' },
  ],
  parcelNumberFields: ['plot_number'],
  criticalFields: ['owner', 'khatiyan', 'khata', 'plot', 'area', 'share', 'class', 'mutation', 'encumbrance', 'mortgage', 'remarks'],
  displayName: (l) => `Plot ${l.plot_number}, ${l.revenue_block}, ${l.revenue_circle}, ${l.subdivision}, ${l.district}`,
};

const createSikkimSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createSikkimSurepassAdapter, spec };
