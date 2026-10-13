'use strict';

/**
 * Response and validation helpers.
 *
 * Every error carries a stable machine-readable `error` code. The frontend
 * translates that code into English or Tamil, so no user-facing sentence is
 * ever hard-coded on the server.
 */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(res, status, code, message, details) {
  const body = { success: false, error: code, message: message || code };
  if (details) body.details = details;
  return res.status(status).json(body);
}

function ok(res, payload = {}, status = 200) {
  return res.status(status).json({ success: true, ...payload });
}

function badRequest(code, message, details) {
  return new ApiError(400, code, message, details);
}

/** Wraps an async route handler so rejections reach the Express error handler. */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function str(value, { field, required = false, min = 0, max = 500, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badRequest('FIELD_REQUIRED', `${field} is required`, { field });
    return '';
  }
  if (typeof value !== 'string') {
    throw badRequest('FIELD_TYPE_INVALID', `${field} must be a string`, { field });
  }
  const out = trim ? value.trim() : value;
  if (required && !out) throw badRequest('FIELD_REQUIRED', `${field} is required`, { field });
  if (out.length < min) throw badRequest('FIELD_TOO_SHORT', `${field} is too short`, { field, min });
  if (out.length > max) throw badRequest('FIELD_TOO_LONG', `${field} is too long`, { field, max });
  return out;
}

function int(value, { field, required = false, min = -Infinity, max = Infinity, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('FIELD_REQUIRED', `${field} is required`, { field });
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw badRequest('FIELD_TYPE_INVALID', `${field} must be an integer`, { field });
  }
  if (n < min || n > max) throw badRequest('FIELD_OUT_OF_RANGE', `${field} is out of range`, { field, min, max });
  return n;
}

function oneOf(value, allowed, { field, required = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('FIELD_REQUIRED', `${field} is required`, { field });
    return fallback;
  }
  if (!allowed.includes(value)) {
    throw badRequest('FIELD_VALUE_INVALID', `${field} must be one of: ${allowed.join(', ')}`, { field, allowed });
  }
  return value;
}

function strArray(value, { field, max = 20, itemMax = 120 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('FIELD_TYPE_INVALID', `${field} must be an array`, { field });
  if (value.length > max) throw badRequest('FIELD_TOO_LONG', `${field} has too many entries`, { field, max });
  return value.map(v => str(v, { field, max: itemMax })).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function email(value, { field = 'email', required = false } = {}) {
  const raw = str(value, { field, required, max: 200 }).toLowerCase();
  if (!raw) return '';
  if (!EMAIL_RE.test(raw)) throw badRequest('EMAIL_INVALID', 'Email address is not valid', { field });
  return raw;
}

function phone(value, { field = 'phone', required = false } = {}) {
  const raw = str(value, { field, required, max: 40 });
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw badRequest('PHONE_INVALID', 'Phone number is not valid', { field });
  }
  return raw;
}

module.exports = {
  ApiError,
  fail,
  ok,
  badRequest,
  asyncRoute,
  str,
  int,
  oneOf,
  strArray,
  email,
  phone
};
