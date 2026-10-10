/**
 * Writes docs/openapi.apidog.json: an OpenAPI 3.0 file for importing into
 * Apidog (Import > OpenAPI/Swagger, target module "Default module").
 *
 *   npm run docs:apidog
 *
 * Shared endpoints (auth, users, plans, payments, smart contract, alerts and the
 * state-independent land-verification routes) are taken from docs/openapi.yaml.
 * Every state's drill-down lists and verify call are generated from the adapter
 * registry, so each state gets concrete endpoints with ready-to-send example
 * bodies, grouped in its own Apidog folder (x-apidog-folder).
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const registry = require('../src/modules/land-verification/providers/registry');
const SAMPLES = require('./surepass-samples');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'docs', 'openapi.yaml');
const TARGET = path.join(ROOT, 'docs', 'openapi.apidog.json');
const LV = '/api/v1/land-verification';
const LAND_FOLDER = 'Land Verification';

const base = YAML.parse(fs.readFileSync(SOURCE, 'utf8'));
const ref = (name) => ({ $ref: `#/components/responses/${name}` });
const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });
const pick = (values, names) => Object.fromEntries(names.map((name) => [name, values[name]]));

// State-specific routes are regenerated below; the generic `{state}` ones from the yaml would duplicate them.
const isStateSpecific = (route) => /^\/api\/v1\/land-verification\/(\{state\}|maharashtra|bihar)\//.test(route);

const errorResponses = (codes) => Object.fromEntries(codes.map((code) => [String(code), ref('Error')]));

const PROVIDER_ERRORS = {
  401: 'Missing or invalid login token',
  403: 'No active subscription (SUBSCRIPTION_REQUIRED)',
  404: 'Unknown state / list, or LAND_RECORD_NOT_FOUND',
  422: 'VALIDATION_FAILED (missing parent field, unknown field) or SUREPASS_REJECTED_REQUEST',
  429: 'Rate limited (ours or Surepass)',
  502: 'SUREPASS_UNREACHABLE',
  503: 'SUREPASS_UNAVAILABLE / SUREPASS_AUTH_FAILED / SUREPASS_NOT_CONFIGURED',
  504: 'SUREPASS_TIMEOUT',
};

const providerErrors = (codes) =>
  Object.fromEntries(codes.map((code) => [String(code), { description: PROVIDER_ERRORS[code], content: { 'application/json': { schema: schemaRef('Error') } } }]));

const fieldSchema = (adapter, field, example) => ({
  type: 'string',
  minLength: 1,
  example,
  description: field.source
    ? `${field.label}. Pick a value from POST ${LV}/${adapter.slug}/${field.source}${adapter.metadataLevels[field.source].filters.length ? '' : ' (GET)'}.`
    : `${field.label}. Entered by the user (no Surepass list).`,
});

const objectSchema = (adapter, fields, sample) => ({
  type: 'object',
  additionalProperties: false,
  required: fields.map((f) => f.name),
  properties: Object.fromEntries(fields.map((f) => [f.name, fieldSchema(adapter, f, sample[f.name])])),
});

const metadataResponse = (adapter, level, filters, sampleValue) => ({
  description: 'Options for the next dropdown',
  content: {
    'application/json': {
      schema: { type: 'object', properties: { success: { type: 'boolean' }, data: schemaRef('MetadataResult') } },
      example: {
        success: true,
        data: { state: adapter.slug, level, filters, options: [{ value: sampleValue, label: sampleValue }], count: 1, cached: false },
      },
    },
  },
});

const stateOperations = (adapter) => {
  const sample = SAMPLES[adapter.slug] || {};
  const folder = `${LAND_FOLDER}/${adapter.label}`;
  const paths = {};
  let order = 0;

  for (const field of adapter.fields) {
    if (!field.source) continue;
    const level = field.source;
    const filterNames = adapter.metadataLevels[level].filters;
    const filterFields = adapter.fields.filter((f) => filterNames.includes(f.name));
    const filters = pick(sample, filterNames);
    const operation = {
      tags: [LAND_FOLDER],
      'x-apidog-folder': folder,
      'x-apidog-orders': (order += 1),
      operationId: `${adapter.slug}-${level}`.replace(/-([a-z])/g, (m, c) => c.toUpperCase()),
      summary: `${adapter.label}: ${field.label} list`,
      description: [
        `Options for **${field.name}**. Requires an active subscription; results are cached.`,
        filterNames.length ? `Body: the values already chosen for ${filterNames.map((n) => `\`${n}\``).join(', ')}.` : 'No body.',
      ].join('\n\n'),
      responses: { 200: metadataResponse(adapter, level, filters, sample[field.name]), ...providerErrors([401, 403, 404, 422, 429, 503, 504]) },
    };
    if (filterNames.length) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: objectSchema(adapter, filterFields, sample), example: filters } } };
    }
    paths[`${LV}/${adapter.slug}/${level}`] = { [filterNames.length ? 'post' : 'get']: operation };
  }

  const dropdowns = adapter.fields.filter((f) => f.source).map((f) => f.name);
  const typed = adapter.fields.filter((f) => !f.source).map((f) => f.name);
  paths[`${LV}/${adapter.slug}/verify`] = {
    post: {
      tags: [LAND_FOLDER],
      'x-apidog-folder': folder,
      'x-apidog-orders': (order += 1),
      operationId: `${adapter.slug}-verify`.replace(/-([a-z])/g, (m, c) => c.toUpperCase()),
      summary: `${adapter.label}: verify land record`,
      description: [
        'Fetches the record from Surepass (billable), stores a snapshot, compares it with the previous one and anchors it.',
        `Dropdown fields: ${dropdowns.map((n) => `\`${n}\``).join(' → ')}.`,
        typed.length ? `Typed by the user: ${typed.map((n) => `\`${n}\``).join(', ')}.` : '',
        'Fields of other states are rejected with 422.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      requestBody: { required: true, content: { 'application/json': { schema: objectSchema(adapter, adapter.fields, sample), example: pick(sample, adapter.fields.map((f) => f.name)) } } },
      responses: {
        200: { description: 'VERIFIED (first time), UNCHANGED or CHANGED', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: schemaRef('VerifyResult') } } } } },
        ...providerErrors([401, 403, 404, 422, 429, 502, 503, 504]),
      },
    },
  };
  return paths;
};

const build = () => {
  const paths = {};
  for (const [route, item] of Object.entries(base.paths)) {
    if (isStateSpecific(route)) continue;
    paths[route] = Object.fromEntries(
      Object.entries(item).map(([method, op]) => {
        const isLand = op.tags?.[0] === LAND_FOLDER;
        const folder = isLand && !route.endsWith('/states') ? `${LAND_FOLDER}/My records` : op.tags?.[0];
        return [method, { ...op, 'x-apidog-folder': folder }];
      }),
    );
  }
  for (const state of registry.listStates()) Object.assign(paths, stateOperations(registry.getAdapter(state.slug)));

  const states = registry.listStates();
  const { Locator, MaharashtraLocator, BiharLocator, ...schemas } = base.components.schemas;
  schemas.MetadataResult = {
    ...schemas.MetadataResult,
    properties: {
      ...schemas.MetadataResult.properties,
      level: { type: 'string', description: 'State-specific list name, e.g. districts, tehsils, talukas, survey-numbers.' },
    },
  };

  return {
    openapi: '3.0.3',
    info: {
      ...base.info,
      description: [
        'Backend API for land-record verification: mobile OTP login, Razorpay subscriptions, Surepass land records',
        `for ${states.length} states (${states.map((s) => s.label).join(', ')}), snapshots with change detection, alerts and smart-contract anchoring.`,
        '',
        '**Auth.** Call `POST /api/auth/mobile-verify`, then send `Authorization: Bearer <token>` (set it once in the Apidog environment / Auth tab).',
        '',
        '**Land flow per state.** `GET /{state}/districts` → each `POST /{state}/<list>` with the values chosen so far → `POST /{state}/verify`.',
        'Each state folder contains its lists in order, with working example bodies. Land endpoints need an active subscription.',
        '',
        '**Envelope.** Success: `{ "success": true, "data": ..., "meta"?: ... }`. Error: `{ "success": false, "error": { "code", "message", "details"? }, "requestId" }`.',
      ].join('\n'),
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local' }],
    tags: base.tags,
    components: { ...base.components, schemas },
    security: base.security,
    paths,
  };
};

/** Every local $ref must resolve; operationIds must be unique. */
const check = (spec) => {
  const problems = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') {
      const target = node.$ref.replace(/^#\//, '').split('/').reduce((acc, key) => acc?.[key], spec);
      if (!target) problems.push(`unresolved ${node.$ref}`);
    }
    Object.values(node).forEach(walk);
  };
  walk(spec);
  const ids = Object.values(spec.paths).flatMap((item) => Object.values(item).map((op) => op.operationId).filter(Boolean));
  ids.filter((id, i) => ids.indexOf(id) !== i).forEach((id) => problems.push(`duplicate operationId ${id}`));
  return problems;
};

const spec = build();
const problems = check(spec);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
fs.writeFileSync(TARGET, `${JSON.stringify(spec, null, 2)}\n`);
const operations = Object.values(spec.paths).reduce((n, item) => n + Object.keys(item).length, 0);
console.log(`Wrote ${path.relative(ROOT, TARGET)}: ${operations} operations, ${Object.keys(spec.paths).length} paths.`);
