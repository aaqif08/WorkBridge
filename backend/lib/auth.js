'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const store = require('./store');

const ROLES = ['Worker', 'Employer', 'Consultancy', 'Admin'];
// Roles a visitor may choose at public signup. Admin is deliberately absent:
// administrators are provisioned from environment variables or by another
// administrator, never by a client-supplied role field.
const PUBLIC_SIGNUP_ROLES = ['Worker', 'Employer', 'Consultancy'];

function hmac(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(String(value)).digest('hex');
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptRounds);
}

async function verifyPassword(plain, hash) {
  if (!hash) {
    // Still burn comparable time so a missing hash is not distinguishable
    // from a wrong password by response timing.
    await bcrypt.compare(String(plain || ''), '$2a$10$ioNn5Dn3A5Y9rYyTGm3sruZ4OMJsPhQ8hv0Ux7PHoLYWPYoYn8kK6');
    return false;
  }
  return bcrypt.compare(String(plain || ''), hash);
}

function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < 10) return 'PASSWORD_TOO_SHORT';
  if (value.length > 200) return 'PASSWORD_TOO_LONG';
  if (!/[a-zA-Z]/.test(value)) return 'PASSWORD_NEEDS_LETTER';
  if (!/[0-9]/.test(value)) return 'PASSWORD_NEEDS_NUMBER';
  return null;
}

/** Fields of a user record that may ever reach a client. */
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email || '',
    phone: user.phone || '',
    role: user.role,
    status: user.status,
    language: user.language || 'en',
    profile: user.profile || {},
    employerId: user.employerId || null,
    consultancyId: user.consultancyId || null,
    createdAt: user.createdAt
  };
}

function findUserById(id) {
  return store.read().users.find(u => String(u.id) === String(id)) || null;
}

function normaliseIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

/** Digits-only form of a phone number, so +91 98765 43210 == 9876543210. */
function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function findUserByIdentifier(identifier) {
  const key = normaliseIdentifier(identifier);
  if (!key) return null;
  const users = store.read().users;
  const byEmail = users.find(u => normaliseIdentifier(u.email) === key);
  if (byEmail) return byEmail;
  const phone = phoneKey(key);
  if (phone) {
    const byPhone = users.find(u => phoneKey(u.phone) === phone);
    if (byPhone) return byPhone;
  }
  return null;
}

// --- sessions ---------------------------------------------------------------

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Creates a brand new session. Always called after a successful credential
 * check and never reuses a pre-login token, which is what prevents session
 * fixation.
 */
async function createSession(user, meta = {}) {
  const token = newToken();
  const csrfToken = newToken();
  const now = Date.now();
  const session = {
    id: hmac(token),
    userId: user.id,
    csrfToken,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: new Date(now + config.sessionAbsoluteMs).toISOString(),
    userAgent: String(meta.userAgent || '').slice(0, 200),
    ip: String(meta.ip || '').slice(0, 64)
  };
  await store.mutate(db => {
    // Drop expired rows opportunistically so the table cannot grow forever.
    db.sessions = db.sessions.filter(s => new Date(s.expiresAt).getTime() > now);
    db.sessions.push(session);
  });
  return { token, csrfToken, session };
}

function lookupSession(token) {
  if (!token) return null;
  const id = hmac(token);
  const session = store.read().sessions.find(s => s.id === id);
  if (!session) return null;
  const now = Date.now();
  if (new Date(session.expiresAt).getTime() <= now) return { expired: true, session };
  if (now - new Date(session.lastSeenAt).getTime() > config.sessionIdleMs) {
    return { expired: true, session, reason: 'idle' };
  }
  return { expired: false, session };
}

async function touchSession(sessionId) {
  await store.mutate(db => {
    const row = db.sessions.find(s => s.id === sessionId);
    if (row) row.lastSeenAt = new Date().toISOString();
  });
}

async function revokeSession(sessionId) {
  await store.mutate(db => {
    db.sessions = db.sessions.filter(s => s.id !== sessionId);
  });
}

async function revokeAllSessionsForUser(userId) {
  await store.mutate(db => {
    db.sessions = db.sessions.filter(s => String(s.userId) !== String(userId));
  });
}

async function revokeExpiredSessions() {
  const now = Date.now();
  await store.mutate(db => {
    db.sessions = db.sessions.filter(s => new Date(s.expiresAt).getTime() > now);
  });
}

// --- login throttling -------------------------------------------------------

function attemptKey(identifier) {
  return normaliseIdentifier(identifier) || 'unknown';
}

function lockState(identifier) {
  const row = store.read().loginAttempts.find(a => a.key === attemptKey(identifier));
  if (!row) return { locked: false, remainingMs: 0, count: 0 };
  const lockedUntil = row.lockedUntil ? new Date(row.lockedUntil).getTime() : 0;
  const remainingMs = lockedUntil - Date.now();
  return { locked: remainingMs > 0, remainingMs: Math.max(0, remainingMs), count: row.count || 0 };
}

async function recordFailedLogin(identifier) {
  const key = attemptKey(identifier);
  return store.mutate(db => {
    let row = db.loginAttempts.find(a => a.key === key);
    if (!row) {
      row = { key, count: 0, lockedUntil: null, firstFailedAt: new Date().toISOString() };
      db.loginAttempts.push(row);
    }
    row.count = (row.count || 0) + 1;
    row.lastFailedAt = new Date().toISOString();
    if (row.count >= config.loginMaxAttempts) {
      row.lockedUntil = new Date(Date.now() + config.loginLockMs).toISOString();
      row.count = 0;
    }
    return row;
  });
}

async function clearFailedLogins(identifier) {
  const key = attemptKey(identifier);
  await store.mutate(db => {
    db.loginAttempts = db.loginAttempts.filter(a => a.key !== key);
  });
}

module.exports = {
  ROLES,
  PUBLIC_SIGNUP_ROLES,
  hashPassword,
  verifyPassword,
  passwordProblem,
  publicUser,
  findUserById,
  findUserByIdentifier,
  normaliseIdentifier,
  phoneKey,
  createSession,
  lookupSession,
  touchSession,
  revokeSession,
  revokeAllSessionsForUser,
  revokeExpiredSessions,
  lockState,
  recordFailedLogin,
  clearFailedLogins
};
