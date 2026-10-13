'use strict';

const crypto = require('crypto');
const config = require('../config');
const auth = require('./auth');
const { fail } = require('./http');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: config.sessionAbsoluteMs
  };
}

function csrfCookieOptions() {
  return {
    httpOnly: false, // the browser app must read this to echo it back
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: config.sessionAbsoluteMs
  };
}

function issueSessionCookies(res, token, csrfToken) {
  res.cookie(config.sessionCookieName, token, sessionCookieOptions());
  res.cookie(config.csrfCookieName, csrfToken, csrfCookieOptions());
}

function clearSessionCookies(res) {
  res.clearCookie(config.sessionCookieName, { path: '/' });
  res.clearCookie(config.csrfCookieName, { path: '/' });
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Resolves the caller, if any, onto `req.auth`. Never rejects on its own - route
 * guards decide whether anonymous access is acceptable.
 *
 * Two transports are supported:
 *  - `Authorization: Bearer <token>` for API clients and automated tests.
 *  - the httpOnly session cookie for the browser app. Cookie-authenticated
 *    mutations additionally require a matching CSRF header, because a cookie is
 *    attached by the browser automatically and a bearer token is not.
 */
function attachUser(req, res, next) {
  req.auth = null;
  const bearer = bearerToken(req);
  const cookieToken = req.cookies ? req.cookies[config.sessionCookieName] : null;
  const token = bearer || cookieToken;
  if (!token) return next();

  const result = auth.lookupSession(token);
  if (!result) return next();
  if (result.expired) {
    req.expiredSession = true;
    if (!bearer) clearSessionCookies(res);
    // Best-effort cleanup; failure must not break the request.
    auth.revokeSession(result.session.id).catch(() => {});
    return next();
  }

  const user = auth.findUserById(result.session.userId);
  if (!user) return next();

  req.auth = {
    user,
    session: result.session,
    transport: bearer ? 'bearer' : 'cookie'
  };

  // Refresh idle timer at most once a minute to avoid a disk write per request.
  const lastSeen = new Date(result.session.lastSeenAt).getTime();
  if (Date.now() - lastSeen > 60 * 1000) {
    auth.touchSession(result.session.id).catch(() => {});
  }
  return next();
}

function requireAuth(req, res, next) {
  if (!req.auth) {
    const code = req.expiredSession ? 'SESSION_EXPIRED' : 'AUTH_REQUIRED';
    return fail(res, 401, code, 'Authentication required');
  }
  if (req.auth.user.status !== 'active') {
    return fail(res, 403, 'ACCOUNT_SUSPENDED', 'This account is suspended');
  }
  return next();
}

function requireCsrf(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (!req.auth || req.auth.transport !== 'cookie') return next();
  const header = req.get('x-csrf-token');
  if (!header || !safeEqual(header, req.auth.session.csrfToken)) {
    return fail(res, 403, 'CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token');
  }
  return next();
}

/** Role gate. Use after requireAuth. */
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.auth) return fail(res, 401, 'AUTH_REQUIRED', 'Authentication required');
    if (!allowed.includes(req.auth.user.role)) {
      return fail(res, 403, 'FORBIDDEN_ROLE', 'Your role cannot perform this action');
    }
    return next();
  };
}

module.exports = {
  attachUser,
  requireAuth,
  requireRole,
  requireCsrf,
  issueSessionCookies,
  clearSessionCookies,
  safeEqual
};
