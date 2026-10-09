/**
 * Building blocks shared by state adapters. Only generic pieces live here
 * (validation primitives, envelope unwrapping, identity cleaning); each state's
 * fields, hierarchy and terminology stay in its own adapter file.
 */

const { z } = require('zod');
const { normalizeRecord } = require('../land-record-normalizer');
const { resolveIgnoredFields } = require('../land-record-ignore');

/** Place names: letters (any script), digits, spaces and the punctuation real names use. */
const text = (name, max = 120) =>
  z
    .string({ required_error: `${name} is required`, invalid_type_error: `${name} must be a string` })
    .trim()
    .min(1, `${name} is required`)
    .max(max, `${name} is too long`)
    .regex(/^[\p{L}\p{M}\p{N} .,'()&_-]+$/u, `${name} contains invalid characters`);

/**
 * Like `text`, but also allows "/" and ":" which appear in values Surepass itself
 * returns for some states (e.g. Bihar mouza "अररिया बस्ती - 214/1").
 */
const placeName = (name, max = 160) =>
  z
    .string({ required_error: `${name} is required`, invalid_type_error: `${name} must be a string` })
    .trim()
    .min(1, `${name} is required`)
    .max(max, `${name} is too long`)
    .regex(/^[\p{L}\p{M}\p{N} .,'()&_/:-]+$/u, `${name} contains invalid characters`);

/** Parcel numbers (survey / plot / part numbers): letters of any script, digits, "/", "-", ".", spaces. */
const parcelNumber = (name, max = 60) =>
  z
    .string({ required_error: `${name} is required`, invalid_type_error: `${name} must be a string` })
    .trim()
    .min(1, `${name} is required`)
    .max(max, `${name} is too long`)
    .regex(/^[\p{L}\p{M}\p{N}/\-\s.()]+$/u, `${name} contains invalid characters`);

/** Case/whitespace/Unicode-insensitive form used for parcel identity keys. */
const cleanIdentity = (value) => String(value).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Surepass envelopes the land record as { data, status_code, success, ... }; only `data` describes the land. */
const unwrapSurepassData = (raw) => (raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw);

const buildDiffOptions = (criticalFields) => ({
  ignoredFields: resolveIgnoredFields([]),
  // Fill in once real Surepass payloads for the state are observed.
  // Unkeyed arrays still compare correctly (order-insensitive ADD/REMOVE).
  arrayKeys: {},
  orderedArrays: [],
  criticalFields,
});

/** Normalizes a stored Surepass envelope with the adapter's diff options. */
const surepassRecordNormalizer = (diffOptions) => {
  const options = { ignoredFields: diffOptions.ignoredFields, orderedArrays: diffOptions.orderedArrays };
  return (raw) => normalizeRecord(unwrapSurepassData(raw), options);
};

module.exports = { text, placeName, parcelNumber, cleanIdentity, unwrapSurepassData, buildDiffOptions, surepassRecordNormalizer };
