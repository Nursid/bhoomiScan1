/**
 * Surepass land-verification endpoints (Punjab). Pure integration: knows Surepass
 * paths and payload names, nothing about subscriptions, storage or diffing.
 *
 *   GET  /api/v1/land-verification/punjab/meta/district-list
 *   POST /api/v1/land-verification/punjab/meta/tehsil-list        { district }
 *   POST /api/v1/land-verification/punjab/meta/village-list       { district, tehsil }
 *   POST /api/v1/land-verification/punjab/meta/year-list          { district, tehsil, village }
 *   POST /api/v1/land-verification/punjab/meta/khasra-number-list { district, tehsil, village, year }
 *   POST /api/v1/land-verification/punjab                         { district, tehsil, village, year, khasra_number }
 *
 * HTTP, auth, retries and error mapping are shared (surepass-land.base.js).
 */

const { SurepassStateLandProvider, toOptions } = require('./surepass-land.base');

class SurepassLandProvider extends SurepassStateLandProvider {
  constructor({ client } = {}) {
    super({ state: 'punjab', client });
  }

  async getDistricts() {
    return this.listMetadata('district-list', undefined, 'punjab.districts');
  }

  async getTehsils(district) {
    return this.listMetadata('tehsil-list', { district }, 'punjab.tehsils');
  }

  async getVillages(district, tehsil) {
    return this.listMetadata('village-list', { district, tehsil }, 'punjab.villages');
  }

  async getYears(district, tehsil, village) {
    return this.listMetadata('year-list', { district, tehsil, village }, 'punjab.years');
  }

  async getKhasraNumbers(district, tehsil, village, year) {
    return this.listMetadata('khasra-number-list', { district, tehsil, village, year }, 'punjab.khasras');
  }

  /** Billable call (see SurepassStateLandProvider.verifyLand). */
  async verifyPunjabLand({ district, tehsil, village, year, khasra_number: khasraNumber }) {
    return this.verifyLand({ district, tehsil, village, year, khasra_number: khasraNumber }, 'punjab.verify');
  }
}

module.exports = { SurepassLandProvider, SurepassPunjabLandProvider: SurepassLandProvider, toOptions };
