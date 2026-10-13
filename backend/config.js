'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolve(p, fallback) {
  const target = p && String(p).trim() ? String(p).trim() : fallback;
  return path.isAbsolute(target) ? target : path.join(ROOT, target);
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

// A missing SESSION_SECRET in production is a hard failure: an ephemeral secret
// would silently invalidate every session on each restart and makes session
// lookup inconsistent across instances. The error is collected rather than
// thrown at require time, so the startup path can report it as a readable
// message instead of a stack trace.
const configErrors = [];
let sessionSecret = (process.env.SESSION_SECRET || '').trim();
if (!sessionSecret) {
  if (isProduction) {
    configErrors.push(
      'SESSION_SECRET is required when NODE_ENV=production. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  sessionSecret = crypto.randomBytes(48).toString('hex');
}

const config = {
  env: NODE_ENV,
  isProduction,
  isTest,
  port: int(process.env.PORT, 5000),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  sessionSecret,
  sessionCookieName: 'wb_session',
  csrfCookieName: 'wb_csrf',
  sessionAbsoluteMs: int(process.env.SESSION_ABSOLUTE_HOURS, 168) * 3600 * 1000,
  sessionIdleMs: int(process.env.SESSION_IDLE_HOURS, 12) * 3600 * 1000,

  bcryptRounds: isTest ? 4 : int(process.env.BCRYPT_ROUNDS, 12),
  loginMaxAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 8),
  loginLockMs: int(process.env.LOGIN_LOCK_MINUTES, 15) * 60 * 1000,

  dataDir: resolve(process.env.DATA_DIR, './backend/data'),
  uploadDir: resolve(process.env.UPLOAD_DIR, './uploads'),
  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
  allowedUploadTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],

  seedDemoData: bool(process.env.SEED_DEMO_DATA, !isProduction),
  demoPassword: (process.env.DEMO_PASSWORD || '').trim(),

  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminName: (process.env.ADMIN_NAME || 'Platform Administrator').trim(),

  ai: {
    provider: (process.env.AI_PROVIDER || 'none').trim().toLowerCase(),
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: (process.env.AI_MODEL || 'claude-opus-5-5').trim(),
    maxTokens: int(process.env.AI_MAX_TOKENS, 1024),
    effort: (process.env.AI_EFFORT || 'low').trim(),
    rateWindowMs: int(process.env.AI_RATE_WINDOW_MINUTES, 5) * 60 * 1000,
    rateMax: int(process.env.AI_RATE_MAX, 20),
    maxMessageChars: 1500,
    historyTurns: 8
  }
};

// The AI provider is only considered "live" when a key is actually present;
// otherwise every caller falls back to the deterministic knowledge base.
config.ai.live = config.ai.provider === 'anthropic' && Boolean(config.ai.apiKey);

if (config.ai.provider === 'anthropic' && !config.ai.apiKey) {
  console.warn('[workbridge] AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty - the assistant will use its knowledge-base fallback.');
}
if (isProduction && config.seedDemoData) {
  configErrors.push('SEED_DEMO_DATA must be false when NODE_ENV=production: demo accounts share one password.');
}

config.errors = configErrors;

/** Throws a readable configuration error. Called from the startup path. */
config.assertValid = () => {
  if (configErrors.length) {
    const error = new Error(`Invalid configuration:\n  - ${configErrors.join('\n  - ')}`);
    error.isConfigError = true;
    throw error;
  }
};

module.exports = config;
