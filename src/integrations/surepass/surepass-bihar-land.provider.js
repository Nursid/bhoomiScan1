/**
 * Surepass land-verification endpoints (Bihar). Bihar has its own hierarchy:
 * district -> anchal -> light -> mouza -> plot_number. "light" is Surepass's
 * field name and is used verbatim; it is not mapped onto any other concept.
 *
 *   GET  /api/v1/land-verification/bihar/meta/district-list
 *   POST /api/v1/land-verification/bihar/meta/anchal-list   { district }
 *   POST /api/v1/land-verification/bihar/meta/light-list    { district, anchal }
 *   POST /api/v1/land-verification/bihar/meta/mouza-list    { district, anchal, light }
 *   POST /api/v1/land-verification/bihar                    { district, anchal, light, mouza, plot_number }
 *
 * Surepass offers no plot-number list, so plot_number is entered by the user.
 */

const { SurepassStateLandProvider } = require('./surepass-land.base');

class SurepassBiharLandProvider extends SurepassStateLandProvider {
  constructor({ client } = {}) {
    super({ state: 'bihar', client });
  }

  async getDistricts() {
    return this.listMetadata('district-list', undefined, 'bihar.districts');
  }

  async getAnchals(district) {
    return this.listMetadata('anchal-list', { district }, 'bihar.anchals');
  }

  async getLights(district, anchal) {
    return this.listMetadata('light-list', { district, anchal }, 'bihar.lights');
  }

  async getMouzas(district, anchal, light) {
    return this.listMetadata('mouza-list', { district, anchal, light }, 'bihar.mouzas');
  }

  /** Billable call (see SurepassStateLandProvider.verifyLand). */
  async verifyBiharLand({ district, anchal, light, mouza, plot_number: plotNumber }) {
    return this.verifyLand({ district, anchal, light, mouza, plot_number: plotNumber }, 'bihar.verify');
  }
}

module.exports = { SurepassBiharLandProvider };
