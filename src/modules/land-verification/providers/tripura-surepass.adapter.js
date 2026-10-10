/**
 * Tripura -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> subdivision -> revenue_circle -> tehsil -> mouja -> khatian_number
 *
 *   GET  /tripura/meta/district-list
 *   POST /tripura/meta/subdivision-list      { district }
 *   POST /tripura/meta/revenue-circle-list   { district, subdivision }
 *   POST /tripura/meta/tehsil-list           { district, subdivision, revenue_circle }
 *   POST /tripura/meta/mouja-list            { district, subdivision, revenue_circle, tehsil }
 *   POST /tripura                            { district, subdivision, revenue_circle, tehsil, mouja, khatian_number }
 *
 * Values are bilingual with a slash, e.g. "উত্তর ত্রিপুরা/north tripura", and are
 * sent verbatim. Surepass has no khatian list, so khatian_number is entered by the user.
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'TRIPURA',
  slug: 'tripura',
  label: 'Tripura',
  propertyPrefix: 'TR',
  levels: {
    districts: { list: 'district-list', filters: [] },
    subdivisions: { list: 'subdivision-list', filters: ['district'] },
    'revenue-circles': { list: 'revenue-circle-list', filters: ['district', 'subdivision'] },
    tehsils: { list: 'tehsil-list', filters: ['district', 'subdivision', 'revenue_circle'] },
    moujas: { list: 'mouja-list', filters: ['district', 'subdivision', 'revenue_circle', 'tehsil'] },
  },
  schemas: {
    district: placeName('district'),
    subdivision: placeName('subdivision'),
    revenue_circle: placeName('revenue_circle'),
    tehsil: placeName('tehsil'),
    mouja: placeName('mouja'),
    khatian_number: parcelNumber('khatian_number'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'subdivision', label: 'Subdivision', input: 'select', source: 'subdivisions' },
    { name: 'revenue_circle', label: 'Revenue Circle', input: 'select', source: 'revenue-circles' },
    { name: 'tehsil', label: 'Tehsil', input: 'select', source: 'tehsils' },
    { name: 'mouja', label: 'Mouja', input: 'select', source: 'moujas' },
    { name: 'khatian_number', label: 'Khatian Number', input: 'text' },
  ],
  parcelNumberFields: ['khatian_number'],
  // Jamir khatian vocabulary.
  criticalFields: ['owner', 'raiyat', 'khatian', 'dag', 'plot', 'area', 'share', 'class', 'mutation', 'encumbrance', 'mortgage', 'remarks'],
  displayName: (l) => `Khatian ${l.khatian_number}, ${l.mouja}, ${l.tehsil}, ${l.revenue_circle}, ${l.subdivision}, ${l.district}`,
};

const createTripuraSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createTripuraSurepassAdapter, spec };
