/**
 * Builds a Surepass state adapter (adapter contract: punjab-surepass.adapter.js)
 * from a declarative spec. States whose Surepass API is a plain drill-down
 * (meta lists + one verify call, payload fields sent verbatim) are described by
 * data alone; see gujarat-surepass.adapter.js and the other state files.
 *
 *   spec.stateCode, slug, label, propertyPrefix
 *   spec.levels   { level: { list: '<surepass meta list>', filters: [...] } }
 *                 Surepass path: /api/v1/land-verification/<slug>/meta/<list>
 *   spec.schemas  zod schema for every locator field (filters + verify-only fields)
 *   spec.fields   ordered form fields; their names, in order, are the verify payload
 *   spec.parcelNumberFields  fields whose identity ignores inner whitespace
 *   spec.criticalFields, spec.displayName(locator)
 *
 * HTTP, auth, retries and error mapping come from SurepassStateLandProvider.
 */

const { z } = require('zod');
const { SurepassStateLandProvider } = require('../../../integrations/surepass/surepass-land.base');
const { cleanIdentity, buildDiffOptions, surepassRecordNormalizer } = require('./adapter-helpers');

const pick = (values, names) => Object.fromEntries(names.map((name) => [name, values[name]]));

const createSurepassStateAdapter = (spec, { provider = new SurepassStateLandProvider({ state: spec.slug }) } = {}) => {
  const fieldNames = spec.fields.map((field) => field.name);
  const filterNames = [...new Set(Object.values(spec.levels).flatMap((level) => level.filters))];
  const filterSchemas = pick(spec.schemas, filterNames);
  const locatorSchema = z.object(pick(spec.schemas, fieldNames)).strict();
  const metadataLevels = Object.fromEntries(Object.entries(spec.levels).map(([level, { filters }]) => [level, { filters }]));
  const parcelNumberFields = new Set(spec.parcelNumberFields || []);
  const diffOptions = buildDiffOptions(spec.criticalFields);
  const normalize = surepassRecordNormalizer(diffOptions);

  return {
    stateCode: spec.stateCode,
    slug: spec.slug,
    label: spec.label,
    provider: 'SUREPASS',
    normalizerVersion: `surepass-${spec.slug}@1`,
    metadataLevels,
    filterSchemas,
    fields: spec.fields,
    locatorSchema,
    diffOptions,

    async listOptions(level, filters) {
      const definition = Object.hasOwn(spec.levels, level) ? spec.levels[level] : null;
      if (!definition) throw new Error(`Unknown metadata level ${level}`);
      const payload = definition.filters.length === 0 ? undefined : pick(filters, definition.filters);
      return provider.listMetadata(definition.list, payload, `${spec.slug}.${level}`);
    },

    /** Billable call (see SurepassStateLandProvider.verifyLand). Sends exactly the form fields. */
    async fetchRecord(locator) {
      const result = await provider.verifyLand(pick(locator, fieldNames), `${spec.slug}.verify`);
      return { raw: result.body, record: result.record, providerReference: result.providerReference, providerRequestId: result.providerRequestId };
    },

    normalizeRecord(raw) {
      return normalize(raw);
    },

    parcelIdentity(locator) {
      return Object.fromEntries(
        fieldNames.map((name) => {
          const value = cleanIdentity(locator[name]);
          return [name, parcelNumberFields.has(name) ? value.replace(/\s+/g, '') : value];
        }),
      );
    },

    propertyId(locator) {
      const id = this.parcelIdentity(locator);
      return [spec.propertyPrefix, ...fieldNames.map((name) => id[name])].join(':');
    },

    displayName(locator) {
      return spec.displayName(locator);
    },
  };
};

module.exports = { createSurepassStateAdapter };
