'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const store = require('../lib/store');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const mw = require('../lib/middleware');
const { ok, fail, asyncRoute, str, email: emailField, phone: phoneField, oneOf } = require('../lib/http');

const router = express.Router();

// IP-level throttle. The per-account lockout in lib/auth handles credential
// stuffing against a single account; this limits spray across many accounts.
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: config.isTest ? 1000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => fail(res, 429, 'TOO_MANY_LOGIN_ATTEMPTS', 'Too many sign-in attempts. Try again later.')
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => fail(res, 429, 'TOO_MANY_SIGNUPS', 'Too many accounts created from this network. Try again later.')
});

const LANGUAGES = ['en', 'ta'];

function profileFromBody(role, body) {
  const input = body && typeof body.profile === 'object' && body.profile ? body.profile : {};
  if (role === 'Worker') {
    return {
      trade: str(input.trade, { field: 'profile.trade', max: 80 }),
      experienceYears: Number.isFinite(Number(input.experienceYears)) ? Math.max(0, Math.min(60, Number(input.experienceYears))) : 0,
      skills: Array.isArray(input.skills) ? input.skills.slice(0, 15).map(s => str(s, { field: 'profile.skills', max: 60 })) : [],
      languages: Array.isArray(input.languages) ? input.languages.slice(0, 10).map(s => str(s, { field: 'profile.languages', max: 40 })) : [],
      preferredCountries: Array.isArray(input.preferredCountries)
        ? input.preferredCountries.slice(0, 10).map(s => str(s, { field: 'profile.preferredCountries', max: 60 }))
        : [],
      currentLocation: str(input.currentLocation, { field: 'profile.currentLocation', max: 120 }),
      passportAvailable: Boolean(input.passportAvailable)
    };
  }
  if (role === 'Employer') {
    return {
      companyName: str(input.companyName, { field: 'profile.companyName', max: 140 }),
      country: str(input.country, { field: 'profile.country', max: 80 }),
      city: str(input.city, { field: 'profile.city', max: 80 }),
      sector: str(input.sector, { field: 'profile.sector', max: 120 }),
      contactPerson: str(input.contactPerson, { field: 'profile.contactPerson', max: 120 }),
      // Verification status is never settable by the account itself.
      verificationStatus: 'unverified'
    };
  }
  if (role === 'Consultancy') {
    return {
      agencyName: str(input.agencyName, { field: 'profile.agencyName', max: 140 }),
      city: str(input.city, { field: 'profile.city', max: 80 }),
      registrationReference: str(input.registrationReference, { field: 'profile.registrationReference', max: 80 }),
      verificationStatus: 'unverified'
    };
  }
  return {};
}

router.post('/register', registerLimiter, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const name = str(body.name, { field: 'name', required: true, min: 2, max: 120 });
  const email = emailField(body.email, { field: 'email' });
  const phone = phoneField(body.phone, { field: 'phone' });

  if (!email && !phone) {
    return fail(res, 400, 'CONTACT_REQUIRED', 'Provide an email address or a mobile number');
  }

  // A client-supplied role is accepted only from the public signup allow-list.
  // 'Admin' is not on it, so no request body can create an administrator.
  const role = oneOf(body.role, auth.PUBLIC_SIGNUP_ROLES, { field: 'role', fallback: 'Worker' });
  const language = oneOf(body.language, LANGUAGES, { field: 'language', fallback: 'en' });

  const password = String(body.password || '');
  const problem = auth.passwordProblem(password);
  if (problem) return fail(res, 400, problem, 'Password does not meet the minimum requirements');
  if (body.confirmPassword !== undefined && String(body.confirmPassword) !== password) {
    return fail(res, 400, 'PASSWORD_MISMATCH', 'Passwords do not match');
  }

  const users = store.read().users;
  if (email && users.some(u => auth.normaliseIdentifier(u.email) === email)) {
    return fail(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists');
  }
  if (phone && users.some(u => auth.phoneKey(u.phone) && auth.phoneKey(u.phone) === auth.phoneKey(phone))) {
    return fail(res, 409, 'PHONE_TAKEN', 'An account with this mobile number already exists');
  }

  const passwordHash = await auth.hashPassword(password);
  const profile = profileFromBody(role, body);
  const now = new Date().toISOString();

  const user = await store.mutate(db => {
    const row = {
      id: store.nextId('users'),
      name,
      email,
      phone,
      passwordHash,
      role,
      status: 'active',
      language,
      profile,
      createdAt: now,
      updatedAt: now
    };
    db.users.push(row);
    return row;
  });

  await audit.record(user, 'USER_REGISTERED', {
    targetType: 'user',
    targetId: user.id,
    summary: `${role} account created`,
    ip: req.ip
  });

  const { token, csrfToken } = await auth.createSession(user, { userAgent: req.get('user-agent'), ip: req.ip });
  mw.issueSessionCookies(res, token, csrfToken);

  return ok(res, { user: auth.publicUser(user), token, csrfToken }, 201);
}));

router.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const identifier = str(body.identifier || body.email || body.username, {
    field: 'identifier', required: true, max: 200
  });
  const password = String(body.password || '');
  if (!password) return fail(res, 400, 'FIELD_REQUIRED', 'Password is required');

  const lock = auth.lockState(identifier);
  if (lock.locked) {
    return fail(res, 429, 'ACCOUNT_TEMPORARILY_LOCKED',
      'Too many failed attempts. This account is temporarily locked.',
      { retryAfterSeconds: Math.ceil(lock.remainingMs / 1000) });
  }

  const user = auth.findUserByIdentifier(identifier);
  const valid = await auth.verifyPassword(password, user && user.passwordHash);

  // One generic message for both "no such account" and "wrong password" so the
  // endpoint cannot be used to enumerate registered users.
  if (!user || !valid) {
    await auth.recordFailedLogin(identifier);
    return fail(res, 401, 'INVALID_CREDENTIALS', 'Email/mobile or password is incorrect');
  }
  if (user.status !== 'active') {
    await audit.record(user, 'LOGIN_BLOCKED_SUSPENDED', { targetType: 'user', targetId: user.id, ip: req.ip });
    return fail(res, 403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact WorkBridge support.');
  }

  await auth.clearFailedLogins(identifier);
  // A fresh token per login: nothing issued before authentication is honoured,
  // which is what closes session fixation.
  const { token, csrfToken } = await auth.createSession(user, { userAgent: req.get('user-agent'), ip: req.ip });
  mw.issueSessionCookies(res, token, csrfToken);

  await audit.record(user, 'LOGIN_SUCCESS', { targetType: 'user', targetId: user.id, ip: req.ip });

  return ok(res, { user: auth.publicUser(user), token, csrfToken });
}));

router.post('/logout', asyncRoute(async (req, res) => {
  if (req.auth) {
    await auth.revokeSession(req.auth.session.id);
    await audit.record(req.auth.user, 'LOGOUT', { targetType: 'user', targetId: req.auth.user.id, ip: req.ip });
  }
  mw.clearSessionCookies(res);
  return ok(res, { message: 'Signed out' });
}));

router.get('/me', mw.requireAuth, (req, res) => {
  return ok(res, { user: auth.publicUser(req.auth.user), csrfToken: req.auth.session.csrfToken });
});

router.patch('/me', mw.requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const current = req.auth.user;
  const patch = {};

  if (body.name !== undefined) patch.name = str(body.name, { field: 'name', required: true, min: 2, max: 120 });
  if (body.language !== undefined) patch.language = oneOf(body.language, LANGUAGES, { field: 'language', required: true });
  if (body.phone !== undefined) {
    const phone = phoneField(body.phone, { field: 'phone' });
    if (phone && store.read().users.some(u => String(u.id) !== String(current.id) && auth.phoneKey(u.phone) === auth.phoneKey(phone))) {
      return fail(res, 409, 'PHONE_TAKEN', 'An account with this mobile number already exists');
    }
    patch.phone = phone;
  }
  if (body.email !== undefined) {
    const email = emailField(body.email, { field: 'email' });
    if (email && store.read().users.some(u => String(u.id) !== String(current.id) && auth.normaliseIdentifier(u.email) === email)) {
      return fail(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }
    patch.email = email;
  }
  if (body.profile !== undefined) {
    const next = profileFromBody(current.role, body);
    // Preserve administrator-controlled fields the account cannot set itself.
    if (current.profile && current.profile.verificationStatus) {
      next.verificationStatus = current.profile.verificationStatus;
    }
    patch.profile = next;
  }

  // role and status are intentionally not patchable here.
  const updated = await store.mutate(db => {
    const row = db.users.find(u => String(u.id) === String(current.id));
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return row;
  });

  await audit.record(updated, 'PROFILE_UPDATED', {
    targetType: 'user',
    targetId: updated.id,
    summary: `Fields updated: ${Object.keys(patch).join(', ') || 'none'}`,
    ip: req.ip
  });

  return ok(res, { user: auth.publicUser(updated) });
}));

router.post('/change-password', mw.requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  const problem = auth.passwordProblem(newPassword);
  if (problem) return fail(res, 400, problem, 'Password does not meet the minimum requirements');

  const valid = await auth.verifyPassword(currentPassword, req.auth.user.passwordHash);
  if (!valid) return fail(res, 401, 'INVALID_CREDENTIALS', 'Current password is incorrect');

  const passwordHash = await auth.hashPassword(newPassword);
  await store.mutate(db => {
    const row = db.users.find(u => String(u.id) === String(req.auth.user.id));
    row.passwordHash = passwordHash;
    row.updatedAt = new Date().toISOString();
  });
  // Changing a password invalidates every other session for that account.
  await auth.revokeAllSessionsForUser(req.auth.user.id);
  const { token, csrfToken } = await auth.createSession(req.auth.user, { userAgent: req.get('user-agent'), ip: req.ip });
  mw.issueSessionCookies(res, token, csrfToken);

  await audit.record(req.auth.user, 'PASSWORD_CHANGED', { targetType: 'user', targetId: req.auth.user.id, ip: req.ip });

  return ok(res, { message: 'Password updated', token, csrfToken });
}));

/**
 * Password reset, step 1.
 *
 * The reset token is created and stored (hashed) server side. Delivery needs an
 * email or SMS provider, which this deployment does not have configured, so the
 * response reports `delivery: "not_configured"` and the token is NOT returned
 * to the caller - handing it back over HTTP would let anyone reset any account.
 * See README "Password reset" for the provider wiring that completes this flow.
 */
router.post('/forgot-password', loginLimiter, asyncRoute(async (req, res) => {
  const identifier = str((req.body || {}).identifier, { field: 'identifier', required: true, max: 200 });
  const user = auth.findUserByIdentifier(identifier);

  if (user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await store.mutate(db => {
      const row = db.users.find(u => String(u.id) === String(user.id));
      row.passwordReset = {
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        requestedAt: new Date().toISOString()
      };
    });
    await audit.record(user, 'PASSWORD_RESET_REQUESTED', {
      targetType: 'user', targetId: user.id, ip: req.ip,
      summary: 'Reset token issued; delivery provider not configured'
    });
  }

  // Same response whether or not the account exists, to avoid enumeration.
  return ok(res, {
    message: 'If an account exists for that identifier, a reset has been prepared.',
    delivery: 'not_configured',
    deliveryNote: 'No email or SMS provider is configured for this deployment, so the reset link cannot be sent.'
  }, 202);
}));

router.post('/reset-password', loginLimiter, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const token = str(body.token, { field: 'token', required: true, max: 200 });
  const newPassword = String(body.newPassword || '');
  const problem = auth.passwordProblem(newPassword);
  if (problem) return fail(res, 400, problem, 'Password does not meet the minimum requirements');

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = store.read().users.find(u =>
    u.passwordReset &&
    u.passwordReset.tokenHash === tokenHash &&
    new Date(u.passwordReset.expiresAt).getTime() > Date.now()
  );
  if (!user) return fail(res, 400, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired');

  const passwordHash = await auth.hashPassword(newPassword);
  await store.mutate(db => {
    const row = db.users.find(u => String(u.id) === String(user.id));
    row.passwordHash = passwordHash;
    row.passwordReset = null;
    row.updatedAt = new Date().toISOString();
  });
  await auth.revokeAllSessionsForUser(user.id);
  await audit.record(user, 'PASSWORD_RESET_COMPLETED', { targetType: 'user', targetId: user.id, ip: req.ip });

  return ok(res, { message: 'Password updated. Please sign in.' });
}));

module.exports = router;
