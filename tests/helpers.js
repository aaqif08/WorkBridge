'use strict';

/**
 * Test harness.
 *
 * Every environment variable is set before `backend/config` is first required,
 * because config is read once at load. Each test file runs in its own process
 * (`node --test`), so each gets an isolated temporary data directory and a
 * freshly seeded database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbridge-test-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
process.env.SESSION_SECRET = 'test-session-secret-not-used-in-production';
process.env.SEED_DEMO_DATA = 'true';
process.env.DEMO_PASSWORD = 'DemoPassw0rd1';
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'none';
process.env.ANTHROPIC_API_KEY = process.env.AI_PROVIDER === 'anthropic' ? process.env.ANTHROPIC_API_KEY : '';
process.env.MAX_UPLOAD_MB = '1';
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';

const request = require('supertest');
const { bootstrap } = require('../backend/bootstrap');
const { createApp } = require('../backend/app');
const store = require('../backend/lib/store');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const DEMO = {
  worker: 'worker@demo.workbridge.local',
  worker2: 'worker2@demo.workbridge.local',
  employer: 'employer@demo.workbridge.local',
  consultancy: 'consultancy@demo.workbridge.local',
  admin: 'admin@demo.workbridge.local'
};

let app = null;
let ready = null;

/** Boots storage + app once per test process. */
function getApp() {
  if (!ready) {
    ready = bootstrap().then(() => {
      app = createApp();
      return app;
    });
  }
  return ready;
}

async function agent() {
  const instance = await getApp();
  return request(instance);
}

/** Signs in and returns { token, user }. Throws with detail on failure. */
async function signIn(identifier, password = DEMO_PASSWORD) {
  const http = await agent();
  const res = await http.post('/api/auth/login').send({ identifier, password });
  if (res.status !== 200) {
    throw new Error(`sign-in failed for ${identifier}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, user: res.body.user };
}

/**
 * Convenience wrapper returning request builders that carry a bearer token.
 * Bearer transport is used throughout the suite so the CSRF double-submit check
 * (which only applies to cookie transport) does not need to be simulated.
 */
async function as(identifierOrToken, password) {
  const token = identifierOrToken.includes('@')
    ? (await signIn(identifierOrToken, password)).token
    : identifierOrToken;
  const http = await agent();
  const auth = req => req.set('Authorization', `Bearer ${token}`);
  return {
    token,
    get: (url, query) => auth(http.get(url).query(query || {})),
    post: (url, body) => auth(http.post(url).send(body)),
    patch: (url, body) => auth(http.patch(url).send(body)),
    del: (url, body) => auth(http.delete(url).send(body)),
    upload: (url, fields, file) => {
      let req = auth(http.post(url));
      for (const [key, value] of Object.entries(fields || {})) req = req.field(key, value);
      if (file) req = req.attach('file', file.buffer, { filename: file.filename, contentType: file.contentType });
      return req;
    }
  };
}

function db() {
  return store.read();
}

function findUser(email) {
  return db().users.find(u => u.email === email);
}

function cleanup() {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (_) { /* best effort on Windows */ }
}

/** A tiny but structurally valid PDF, for upload tests. */
function samplePdf(sizeBytes = 512) {
  const header = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
  if (sizeBytes <= header.length) return header;
  return Buffer.concat([header, Buffer.alloc(sizeBytes - header.length, 0x20)]);
}

module.exports = {
  getApp,
  agent,
  as,
  signIn,
  db,
  findUser,
  cleanup,
  samplePdf,
  dataDir,
  DEMO,
  DEMO_PASSWORD
};
