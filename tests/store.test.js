'use strict';

/**
 * Data-integrity tests for the JSON store: concurrency, persistence across a
 * restart, id uniqueness and referential consistency.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const h = require('./helpers');
const store = require('../backend/lib/store');

test.after(() => h.cleanup());

test('concurrent mutations all survive (no lost updates)', async () => {
  await h.getApp();
  const before = h.db().messages.length;

  // The original implementation read-modify-wrote the whole file per request,
  // so overlapping writes lost each other. These 40 mutations are issued
  // without awaiting in between.
  const writes = Array.from({ length: 40 }, (_, i) => store.mutate(db => {
    db.messages.push({
      id: store.nextId('messages'),
      fromId: 0,
      fromName: 'concurrency-probe',
      toId: 0,
      subject: `probe ${i}`,
      body: 'x',
      readAt: null,
      createdAt: new Date().toISOString()
    });
  }));
  await Promise.all(writes);

  assert.equal(h.db().messages.length, before + 40);

  const onDisk = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  assert.equal(onDisk.messages.length, before + 40);

  const probeIds = onDisk.messages.filter(m => m.fromName === 'concurrency-probe').map(m => m.id);
  assert.equal(new Set(probeIds).size, probeIds.length, 'ids must be unique');
});

test('concurrent HTTP writes to the same collection all persist', async () => {
  const employer = await h.as(h.DEMO.employer);
  const base = {
    company: 'Concurrency Co',
    category: 'Driver',
    country: 'UAE',
    city: 'Dubai',
    salary: 'AED 2,000 / month',
    exp: '1+ year',
    hours: '8 hours',
    vacancies: 2,
    visa: 'Yes',
    description: 'A listing created to prove parallel writes do not overwrite one another.',
    requirements: 'Valid licence and one year of experience.'
  };

  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) => employer.post('/api/jobs', { ...base, title: `Parallel Listing ${i}` }))
  );

  assert.equal(responses.every(r => r.status === 201), true);
  const ids = responses.map(r => r.body.data.id);
  assert.equal(new Set(ids).size, 10, 'every parallel create must get a distinct id');

  const onDisk = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  for (const id of ids) {
    assert.ok(onDisk.jobs.some(j => String(j.id) === String(id)), `listing ${id} was lost`);
  }
});

test('ids are never reused after a delete', async () => {
  const employer = await h.as(h.DEMO.employer);
  const payload = {
    title: 'Id Reuse Probe',
    company: 'Id Co',
    category: 'Driver',
    country: 'UAE',
    city: 'Dubai',
    salary: 'AED 2,000 / month',
    exp: '1+ year',
    hours: '8 hours',
    vacancies: 1,
    visa: 'Yes',
    description: 'A listing created and deleted so id allocation can be inspected.',
    requirements: 'Valid licence and one year of experience.'
  };

  const first = await employer.post('/api/jobs', payload);
  const firstId = first.body.data.id;
  await employer.del(`/api/jobs/${firstId}`);

  const second = await employer.post('/api/jobs', { ...payload, title: 'Id Reuse Probe 2' });
  assert.notEqual(second.body.data.id, firstId, 'a deleted id must not be handed out again');
  assert.ok(second.body.data.id > firstId);
});

test('data written through the API is readable after the store is reloaded from disk', async () => {
  const employer = await h.as(h.DEMO.employer);
  const created = await employer.post('/api/jobs', {
    title: 'Restart Survivor',
    company: 'Restart Co',
    category: 'Welder',
    country: 'Qatar',
    city: 'Doha',
    salary: 'QAR 1,900 / month',
    exp: '2+ years',
    hours: '8 hours',
    vacancies: 3,
    visa: 'Yes',
    description: 'A listing used to confirm that writes survive a process restart.',
    requirements: 'Welding certification and two years of experience.'
  });
  const id = created.body.data.id;

  // Simulate a restart: re-read the file exactly as a fresh process would.
  const reloaded = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  const found = reloaded.jobs.find(j => String(j.id) === String(id));
  assert.ok(found, 'the listing must be on disk');
  assert.equal(found.title, 'Restart Survivor');
  assert.ok(found.risk, 'the server-side risk assessment must be persisted too');
});

test('a write is durable before the HTTP response returns', async () => {
  const worker = await h.as(h.DEMO.worker2);
  const published = h.db().jobs.find(j => j.status === 'published'
    && !h.db().applications.some(a => String(a.jobId) === String(j.id)
      && String(a.workerId) === String(h.findUser(h.DEMO.worker2).id)));
  assert.ok(published, 'expected an applicable listing');

  const res = await worker.post('/api/applications', { jobId: published.id });
  assert.equal(res.status, 201);

  // Read the file synchronously immediately after the response: the mutation
  // is flushed before the handler resolves, so no race is possible here.
  const onDisk = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  assert.ok(onDisk.applications.some(a => String(a.id) === String(res.body.data.id)));
});

test('seeded demo records are flagged so they can be told apart from real data', () => {
  const demoUsers = h.db().users.filter(u => u.demo);
  assert.ok(demoUsers.length >= 5);
  assert.equal(demoUsers.every(u => u.email.endsWith('.workbridge.local')), true);
  assert.equal(h.db().meta.demoSeeded, true);
});

test('demo passwords are stored hashed, like any other account', () => {
  for (const user of h.db().users) {
    assert.ok(user.passwordHash, `${user.email} has no password hash`);
    assert.match(user.passwordHash, /^\$2[aby]\$/);
    assert.equal(user.password, undefined, `${user.email} still has a plaintext password field`);
    assert.equal(user.passwordHash.includes(h.DEMO_PASSWORD), false);
  }
});

test('related records stay consistent: every application points at a real job and worker', () => {
  const db = h.db();
  const jobIds = new Set(db.jobs.map(j => String(j.id)));
  const userIds = new Set(db.users.map(u => String(u.id)));

  for (const application of db.applications) {
    assert.ok(userIds.has(String(application.workerId)), `application ${application.id} has a dangling workerId`);
    assert.ok(userIds.has(String(application.employerId)), `application ${application.id} has a dangling employerId`);
    // A job can legitimately be deleted only when it had no live applications,
    // so any application still present must point at an existing job.
    assert.ok(jobIds.has(String(application.jobId)), `application ${application.id} points at a missing job`);
  }

  for (const visaCase of db.visaCases) {
    assert.ok(userIds.has(String(visaCase.workerId)));
    assert.ok(userIds.has(String(visaCase.consultancyId)));
    assert.ok(db.applications.some(a => String(a.id) === String(visaCase.applicationId)));
    assert.equal(visaCase.stages.length, 7);
  }

  for (const doc of db.documents) {
    assert.ok(userIds.has(String(doc.ownerId)), `document ${doc.id} has a dangling ownerId`);
  }
});

test('the health check reports unhealthy when the data directory is unusable', () => {
  const health = store.health();
  assert.equal(health.ok, true);
  assert.equal(typeof health.file, 'string');

  // Point the store at a path that cannot be written, then confirm the check
  // notices rather than reporting success.
  const config = require('../backend/config');
  const original = config.dataDir;
  config.dataDir = process.platform === 'win32' ? 'Z:\\no-such-drive\\nope' : '/proc/self/no-such-dir';
  try {
    const broken = store.health();
    assert.equal(broken.ok, false);
    assert.match(broken.error, /not writable/);
  } finally {
    config.dataDir = original;
  }
});

test('a corrupt database file is preserved rather than silently replaced', () => {
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbridge-corrupt-'));
  const target = path.join(tmp, 'workbridge.json');
  fs.writeFileSync(target, '{ this is not json', 'utf8');

  // A second store instance is loaded in isolation so the live one is untouched.
  const config = require('../backend/config');
  const originalDir = config.dataDir;
  config.dataDir = tmp;
  delete require.cache[require.resolve('../backend/lib/store')];
  const isolated = require('../backend/lib/store');

  try {
    assert.throws(() => isolated.init(), /not valid JSON/);
    const preserved = fs.readdirSync(tmp).filter(f => f.includes('corrupt'));
    assert.ok(preserved.length >= 1, 'the bad file must be kept for recovery');
  } finally {
    config.dataDir = originalDir;
    delete require.cache[require.resolve('../backend/lib/store')];
    require('../backend/lib/store');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
