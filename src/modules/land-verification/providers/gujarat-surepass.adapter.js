/**
 * Gujarat -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> taluka -> village -> block, plus owner_name
 *
 *   GET  /gujarat/meta/district-list
 *   POST /gujarat/meta/taluka-list   { district }
 *   POST /gujarat/meta/village-list  { district, taluka }
 *   POST /gujarat/meta/block-list    { district, taluka, village }
 *   POST /gujarat                    { district, taluka, village, block, owner_name }
 *
 * Surepass has no owner-name list for Gujarat, so owner_name is entered by the user.
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'GUJARAT',
  slug: 'gujarat',
  label: 'Gujarat',
  propertyPrefix: 'GJ',
  levels: {
    districts: { list: 'district-list', filters: [] },
    talukas: { list: 'taluka-list', filters: ['district'] },
    villages: { list: 'village-list', filters: ['district', 'taluka'] },
    blocks: { list: 'block-list', filters: ['district', 'taluka', 'village'] },
  },
  schemas: {
    district: placeName('district'),
    taluka: placeName('taluka'),
    village: placeName('village'),
    block: parcelNumber('block'),
    owner_name: placeName('owner_name'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'taluka', label: 'Taluka', input: 'select', source: 'talukas' },
    { name: 'village', label: 'Village', input: 'select', source: 'villages' },
    { name: 'block', label: 'Block / Survey Number', input: 'select', source: 'blocks' },
    { name: 'owner_name', label: 'Owner Name', input: 'text' },
  ],
  parcelNumberFields: ['block'],
  // 7/12 and 8A (AnyRoR) vocabulary.
  criticalFields: ['owner', 'khata', 'khatedar', 'survey', 'block', 'area', 'share', 'tenure', 'mutation', 'hakk', 'encumbrance', 'boja', 'mortgage', 'remarks'],
  displayName: (l) => `Block ${l.block} (${l.owner_name}), ${l.village}, ${l.taluka}, ${l.district}`,
};

const createGujaratSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createGujaratSurepassAdapter, spec };
