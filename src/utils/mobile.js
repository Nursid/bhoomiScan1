/**
 * Phone number normalization to E.164 (India-first).
 * Ported from the reference backend's server/mobileVerify.js normalizeMobile.
 *
 *   7081002501 / 07081002501 / 917081002501 / +91 70810 02501 -> +917081002501
 */

const config = require('../config');

const normalizeMobile = (input, defaultCountryCode = config.otp.defaultCountryCode) => {
  if (input === undefined || input === null) {
    return null;
  }
  let raw = String(input).trim().replace(/[\s\-().]/g, '');
  if (!raw) {
    return null;
  }

  let hasExplicitCountryCode = false;
  if (raw.startsWith('+')) {
    hasExplicitCountryCode = true;
    raw = raw.slice(1);
  } else if (raw.startsWith('00')) {
    hasExplicitCountryCode = true;
    raw = raw.slice(2);
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  let digits = raw;
  if (!hasExplicitCountryCode) {
    if (digits.length === 11 && digits.startsWith('0')) {
      digits = digits.slice(1);
    }
    if (digits.length === 10) {
      digits = `${defaultCountryCode}${digits}`;
    } else if (!digits.startsWith(defaultCountryCode)) {
      return null;
    }
  }

  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) {
    return null;
  }

  const countryCode = digits.startsWith(defaultCountryCode) ? defaultCountryCode : null;
  const national = countryCode ? digits.slice(countryCode.length) : null;
  if (countryCode === '91' && !/^[6-9]\d{9}$/.test(national || '')) {
    return null;
  }

  return { e164: `+${digits}`, digits, countryCode, national };
};

module.exports = { normalizeMobile };
