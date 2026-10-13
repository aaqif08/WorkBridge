'use strict';

const fs = require('fs');
const config = require('./config');
const store = require('./lib/store');
const auth = require('./lib/auth');
const audit = require('./lib/audit');
const demo = require('./seed/demo');

/**
 * Prepares storage before the HTTP server starts listening:
 *  1. opens (or creates) the runtime database,
 *  2. seeds controlled demo data on first creation when enabled,
 *  3. provisions the initial administrator from environment variables.
 *
 * Administrator provisioning is the only path that can create an Admin besides
 * an existing Admin acting through the API. Public signup cannot.
 */
async function bootstrap() {
  fs.mkdirSync(config.uploadDir, { recursive: true });

  let seedResult = null;
  const { created } = store.init(db => {
    if (config.seedDemoData) {
      seedResult = demo.seed(db);
    } else {
      db.salaryGuide = demo.SALARY_GUIDE.slice();
    }
  });

  const adminResult = await ensureAdmin();
  await auth.revokeExpiredSessions();

  return { created, seedResult, adminResult };
}

async function ensureAdmin() {
  if (!config.adminEmail || !config.adminPassword) {
    return { created: false, reason: 'ADMIN_ENV_NOT_SET' };
  }
  const problem = auth.passwordProblem(config.adminPassword);
  if (problem) {
    return { created: false, reason: problem };
  }
  const existing = auth.findUserByIdentifier(config.adminEmail);
  if (existing) {
    // Do not silently rotate an existing account's password or elevate its role.
    return { created: false, reason: 'ADMIN_ALREADY_EXISTS', email: config.adminEmail };
  }

  const passwordHash = await auth.hashPassword(config.adminPassword);
  const now = new Date().toISOString();
  const user = await store.mutate(db => {
    const row = {
      id: store.nextId('users'),
      name: config.adminName,
      email: config.adminEmail,
      phone: '',
      passwordHash,
      role: 'Admin',
      status: 'active',
      language: 'en',
      profile: { provisionedFrom: 'environment' },
      createdAt: now,
      updatedAt: now
    };
    db.users.push(row);
    return row;
  });

  await audit.record(
    { id: null, name: 'system', role: 'System' },
    'ADMIN_PROVISIONED',
    { targetType: 'user', targetId: user.id, summary: `Administrator ${user.email} provisioned from environment variables` }
  );

  return { created: true, email: user.email };
}

function printStartupNotes(result) {
  if (result.created) {
    console.log(`[workbridge] created new runtime database at ${store.DB_FILE}`);
  }
  if (result.seedResult) {
    console.log('[workbridge] demo dataset seeded (SEED_DEMO_DATA=true). Demo accounts:');
    console.log('             worker@demo.workbridge.local       (Worker)');
    console.log('             worker2@demo.workbridge.local      (Worker)');
    console.log('             employer@demo.workbridge.local     (Employer)');
    console.log('             consultancy@demo.workbridge.local  (Consultancy)');
    console.log('             admin@demo.workbridge.local        (Admin)');
    if (result.seedResult.generated) {
      console.log(`             password (generated once, shown only now): ${result.seedResult.demoPassword}`);
      console.log('             Set DEMO_PASSWORD in .env before first boot to choose it yourself.');
    } else {
      console.log('             password: the value of DEMO_PASSWORD in your environment');
    }
  }
  if (result.adminResult && result.adminResult.created) {
    console.log(`[workbridge] administrator provisioned: ${result.adminResult.email}`);
  }
  if (config.ai.live) {
    console.log(`[workbridge] AI assistant: live provider (anthropic, model ${config.ai.model})`);
  } else {
    console.log('[workbridge] AI assistant: deterministic knowledge-base fallback (no AI provider configured)');
  }
}

module.exports = { bootstrap, ensureAdmin, printStartupNotes };
