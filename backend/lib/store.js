'use strict';

/**
 * Single-process JSON document store.
 *
 * Why it is written this way
 * -------------------------
 * The original implementation did `readFileSync` + mutate + `writeFileSync` on
 * every request. Two overlapping requests would each read the same snapshot and
 * the second write would silently discard the first one's changes. This module
 * fixes that by keeping one authoritative in-memory copy and funnelling every
 * mutation through a serialized promise chain, so mutations apply one at a time
 * and are flushed with an atomic write (temp file + rename).
 *
 * KNOWN LIMITATION: safety here is per Node process. Running more than one
 * instance (cluster mode, several containers) against the same file would
 * reintroduce lost updates. For multi-instance deployments migrate to
 * PostgreSQL - see README "Database and persistence".
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');

const DB_FILE = path.join(config.dataDir, 'workbridge.json');
const TMP_FILE = `${DB_FILE}.tmp`;

const COLLECTIONS = [
  'users',
  'sessions',
  'jobs',
  'applications',
  'visaCases',
  'documents',
  'messages',
  'auditLogs',
  'aiConversations',
  'loginAttempts',
  'consultancyAssignments'
];

function emptyDb() {
  const db = { meta: { version: 2, counters: {}, createdAt: new Date().toISOString() } };
  for (const key of COLLECTIONS) db[key] = [];
  db.salaryGuide = [];
  return db;
}

let db = null;
let writeChain = Promise.resolve();
let dirty = false;

function ensureShape(loaded) {
  const base = emptyDb();
  const merged = { ...base, ...loaded };
  merged.meta = { ...base.meta, ...(loaded.meta || {}) };
  merged.meta.counters = { ...(loaded.meta && loaded.meta.counters) || {} };
  for (const key of COLLECTIONS) {
    if (!Array.isArray(merged[key])) merged[key] = [];
  }
  if (!Array.isArray(merged.salaryGuide)) merged.salaryGuide = [];
  return merged;
}

function loadSync() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    try {
      return ensureShape(JSON.parse(raw));
    } catch (err) {
      // Never silently start from an empty database on top of a corrupt file -
      // that would look like total data loss. Preserve the bad file instead.
      const backup = `${DB_FILE}.corrupt-${Date.now()}`;
      fs.renameSync(DB_FILE, backup);
      throw new Error(`Database file was not valid JSON. Moved to ${backup}. Original error: ${err.message}`);
    }
  }
  return null;
}

function flushSync() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(TMP_FILE, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, DB_FILE);
  dirty = false;
}

async function flush() {
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.writeFile(TMP_FILE, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(TMP_FILE, DB_FILE);
  dirty = false;
}

/** Initialise the store. `seeder(db)` runs only when the file did not exist. */
function init(seeder) {
  const loaded = loadSync();
  if (loaded) {
    db = loaded;
    return { created: false };
  }
  db = emptyDb();
  if (typeof seeder === 'function') seeder(db);
  flushSync();
  return { created: true };
}

/** Read-only view of the whole database. Callers must not mutate the result. */
function read() {
  if (!db) throw new Error('Store not initialised - call store.init() first');
  return db;
}

/**
 * Apply a mutation. `fn(db)` runs exclusively; its return value is resolved to
 * the caller after the change has been durably written to disk.
 */
function mutate(fn) {
  const run = writeChain.then(async () => {
    if (!db) throw new Error('Store not initialised - call store.init() first');
    const result = await fn(db);
    await flush();
    return result;
  });
  // Keep the chain alive even when one mutation rejects.
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Monotonic per-collection id generator; never reuses an id. */
function nextId(collection) {
  const counters = db.meta.counters;
  const existing = Array.isArray(db[collection]) ? db[collection] : [];
  const highest = existing.reduce((max, row) => {
    const n = Number(row && row.id);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  const next = Math.max(counters[collection] || 0, highest) + 1;
  counters[collection] = next;
  return next;
}

function health() {
  try {
    fs.accessSync(config.dataDir, fs.constants.W_OK);
  } catch (err) {
    return { ok: false, error: `data directory not writable: ${config.dataDir}` };
  }
  if (!db) return { ok: false, error: 'store not initialised' };
  return { ok: true, file: DB_FILE, pendingWrite: dirty };
}

module.exports = {
  init,
  read,
  mutate,
  nextId,
  health,
  flushSync,
  DB_FILE,
  COLLECTIONS
};
