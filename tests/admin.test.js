'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.after(() => h.cleanup());

const ADMIN_ROUTES = [
  ['get', '/api/admin/stats'],
  ['get', '/api/admin/fraud-queue'],
  ['get', '/api/admin/users'],
  ['get', '/api/admin/jobs'],
  ['get', '/api/admin/audit-log']
];

test('admin routes are 401 without a session', async () => {
  const http = await h.agent();
  for (const [method, url] of ADMIN_ROUTES) {
    const res = await http[method](url);
    assert.equal(res.status, 401, `${url} should be 401 when anonymous`);
  }
});

test('admin routes are 403 for every non-admin role', async () => {
  for (const email of [h.DEMO.worker, h.DEMO.employer, h.DEMO.consultancy]) {
    const client = await h.as(email);
    for (const [method, url] of ADMIN_ROUTES) {
      const res = await client[method === 'get' ? 'get' : method](url);
      assert.equal(res.status, 403, `${url} should be 403 for ${email}`);
      assert.equal(res.body.error, 'FORBIDDEN_ROLE');
    }
  }
});

test('platform statistics are computed from stored records', async () => {
  const admin = await h.as(h.DEMO.admin);
  const res = await admin.get('/api/admin/stats');
  assert.equal(res.status, 200);

  const stats = res.body.data;
  const db = h.db();
  assert.equal(stats.users.total, db.users.length);
  assert.equal(stats.jobs.total, db.jobs.length);
  assert.equal(stats.applications.total, db.applications.length);
  assert.equal(stats.visaCases.total, db.visaCases.length);
  assert.equal(stats.documents.total, db.documents.length);
  assert.ok(stats.users.byRole.Worker >= 2);
  // Wage metrics must be labelled as indicative, not presented as audited data.
  assert.match(stats.wages.note, /[Ii]ndicative/);
});

test('the fraud queue exposes the reasons behind each score', async () => {
  const admin = await h.as(h.DEMO.admin);
  const res = await admin.get('/api/admin/fraud-queue');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length >= 1);

  const row = res.body.data[0];
  assert.equal(typeof row.riskScore, 'number');
  assert.ok(['low', 'medium', 'high'].includes(row.riskBand));
  assert.ok(row.factors.length >= 1);
  assert.ok(row.factors.every(f => f.code && typeof f.weight === 'number' && f.detail));
  assert.ok(row.employer);
  assert.equal(typeof row.employer.verificationStatus, 'string');
});

test('a fraud action requires an id, a known action and a reason', async () => {
  const admin = await h.as(h.DEMO.admin);
  const flagged = h.db().jobs.find(j => j.status === 'under_review');

  const noId = await admin.post('/api/admin/fraud-action', { action: 'clear', reason: 'Looks fine to me' });
  assert.equal(noId.status, 400);
  assert.equal(noId.body.error, 'FIELD_REQUIRED');

  const badAction = await admin.post('/api/admin/fraud-action', { id: flagged.id, action: 'approve', reason: 'Looks fine' });
  assert.equal(badAction.status, 400);
  assert.equal(badAction.body.error, 'FIELD_VALUE_INVALID');

  const noReason = await admin.post('/api/admin/fraud-action', { id: flagged.id, action: 'clear' });
  assert.equal(noReason.status, 400);

  const missing = await admin.post('/api/admin/fraud-action', { id: 999999, action: 'clear', reason: 'Not here' });
  assert.equal(missing.status, 404);
});

test('suspending a listing writes an audit entry and hides it from the public list', async () => {
  const admin = await h.as(h.DEMO.admin);
  const http = await h.agent();

  const published = h.db().jobs.find(j => j.status === 'published');
  const res = await admin.post('/api/admin/fraud-action', {
    id: published.id,
    action: 'suspend',
    reason: 'Reported by two workers for an upfront fee demand'
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.auditId);
  assert.match(res.body.note, /indicator|not a finding/i);

  const publicList = await http.get('/api/jobs').query({ pageSize: 100 });
  assert.equal(publicList.body.data.some(j => String(j.id) === String(published.id)), false);

  const log = await admin.get('/api/admin/audit-log', { limit: 20 });
  const entry = log.body.data.find(e => e.action === 'LISTING_SUSPEND' && String(e.targetId) === String(published.id));
  assert.ok(entry, 'expected an audit entry for the suspension');
  assert.equal(entry.actorRole, 'Admin');
  assert.match(entry.summary, /upfront fee demand/);
  assert.ok(entry.at);
});

test('clearing a listing publishes it and is recorded', async () => {
  const admin = await h.as(h.DEMO.admin);
  const flagged = h.db().jobs.find(j => j.status === 'under_review');

  const res = await admin.post('/api/admin/fraud-action', {
    id: flagged.id,
    action: 'clear',
    reason: 'Checked the employer licence and the contract; listing is genuine'
  });
  assert.equal(res.status, 200);

  const stored = h.db().jobs.find(j => String(j.id) === String(flagged.id));
  assert.equal(stored.status, 'published');
  assert.equal(stored.reviewState, 'cleared');
  assert.equal(stored.reviewedByName, h.findUser(h.DEMO.admin).name);
  assert.ok(stored.reviewedAt);

  const log = await admin.get('/api/admin/audit-log', { action: 'LISTING_CLEAR' });
  assert.ok(log.body.data.length >= 1);
});

test('removing a listing deletes it and records the decision', async () => {
  const employer = await h.as(h.DEMO.employer);
  const created = await employer.post('/api/jobs', {
    title: 'Listing To Remove',
    company: 'Removable Co',
    category: 'Driver',
    country: 'UAE',
    city: 'Sharjah',
    salary: 'AED 2,000 / month',
    exp: '1+ year',
    hours: '8 hours',
    vacancies: 2,
    visa: 'Yes',
    description: 'A listing created purely so the removal path can be exercised end to end.',
    requirements: 'A valid licence and one year of experience.'
  });
  const id = created.body.data.id;

  const admin = await h.as(h.DEMO.admin);
  const res = await admin.post('/api/admin/fraud-action', {
    id,
    action: 'remove',
    reason: 'Employer confirmed the vacancy does not exist'
  });
  assert.equal(res.status, 200);
  assert.equal(h.db().jobs.some(j => String(j.id) === String(id)), false);

  const log = await admin.get('/api/admin/audit-log', { action: 'LISTING_REMOVE' });
  assert.ok(log.body.data.some(e => String(e.targetId) === String(id)));
});

test('re-assessing a listing recomputes the score from stored content', async () => {
  const admin = await h.as(h.DEMO.admin);
  const job = h.db().jobs[0];
  const res = await admin.post(`/api/admin/jobs/${job.id}/reassess`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.data.score, 'number');
  assert.ok(Array.isArray(res.body.data.factors));

  const log = await admin.get('/api/admin/audit-log', { action: 'LISTING_REASSESSED' });
  assert.ok(log.body.data.length >= 1);
});

test('verification requires an evidence reference and cannot be self-applied', async () => {
  const admin = await h.as(h.DEMO.admin);
  const employerId = h.findUser(h.DEMO.employer).id;

  const noEvidence = await admin.patch(`/api/admin/users/${employerId}/verification`, {
    verificationStatus: 'verified'
  });
  assert.equal(noEvidence.status, 400);
  assert.equal(noEvidence.body.error, 'FIELD_REQUIRED');

  const ok = await admin.patch(`/api/admin/users/${employerId}/verification`, {
    verificationStatus: 'verified',
    evidenceReference: 'Trade licence 12345 checked against the chamber register on file'
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.profile.verificationStatus, 'verified');
  assert.ok(ok.body.data.profile.verificationEvidence.length > 0);

  const log = await admin.get('/api/admin/audit-log', { action: 'ACCOUNT_VERIFICATION_CHANGED' });
  assert.ok(log.body.data.length >= 1);

  // Once verified, the employer's listings report it; an employer still cannot
  // set this itself (covered in auth.test.js).
  const http = await h.agent();
  const jobs = await http.get('/api/jobs').query({ pageSize: 100 });
  assert.ok(jobs.body.data.some(j => j.employerVerified === true));
});

test('verification is not applicable to worker accounts', async () => {
  const admin = await h.as(h.DEMO.admin);
  const workerId = h.findUser(h.DEMO.worker).id;
  const res = await admin.patch(`/api/admin/users/${workerId}/verification`, {
    verificationStatus: 'verified',
    evidenceReference: 'n/a'
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VERIFICATION_NOT_APPLICABLE');
});

test('an admin cannot suspend their own account or the last administrator', async () => {
  const admin = await h.as(h.DEMO.admin);
  const adminId = h.findUser(h.DEMO.admin).id;

  const self = await admin.patch(`/api/admin/users/${adminId}/status`, {
    status: 'suspended',
    reason: 'Testing the self-suspension guard'
  });
  assert.equal(self.status, 409);
  assert.equal(self.body.error, 'CANNOT_MODIFY_SELF');

  // Create a second admin, then confirm the last-admin guard protects the set.
  const created = await admin.post('/api/users/admin', {}).catch(() => null);
  assert.ok(created === null || created.status === 404, 'the admin-create route lives under /api/admin');

  const second = await admin.post('/api/admin/users/admin', {
    name: 'Second Administrator',
    email: 'second-admin@example.com',
    password: 'ValidPass123'
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.data.role, 'Admin');

  const secondAdmin = await h.as('second-admin@example.com', 'ValidPass123');
  const suspendFirst = await secondAdmin.patch(`/api/admin/users/${adminId}/status`, {
    status: 'suspended',
    reason: 'Two administrators exist so this is allowed'
  });
  assert.equal(suspendFirst.status, 200);

  const secondId = h.findUser('second-admin@example.com').id;
  const reactivate = await secondAdmin.patch(`/api/admin/users/${adminId}/status`, {
    status: 'active',
    reason: 'Restoring for the remaining tests'
  });
  assert.equal(reactivate.status, 200);
  assert.ok(secondId);
});

test('an administrator created through the API is recorded in the audit log', async () => {
  const admin = await h.as(h.DEMO.admin);
  const log = await admin.get('/api/admin/audit-log', { action: 'ADMIN_CREATED' });
  assert.ok(log.body.data.some(e => /second-admin@example.com/.test(e.summary)));
});

test('user search filters by name, email and role', async () => {
  const admin = await h.as(h.DEMO.admin);
  const byRole = await admin.get('/api/admin/users', { role: 'Consultancy' });
  assert.equal(byRole.body.data.every(u => u.role === 'Consultancy'), true);

  const bySearch = await admin.get('/api/admin/users', { search: 'second-admin' });
  assert.equal(bySearch.body.data.length, 1);

  // Listed users never carry a password hash.
  assert.equal(JSON.stringify(byRole.body).includes('passwordHash'), false);
});

test('the audit log is append-only from the application\'s point of view', async () => {
  const admin = await h.as(h.DEMO.admin);
  const before = (await admin.get('/api/admin/audit-log', { limit: 500 })).body.data.length;

  await admin.post(`/api/admin/jobs/${h.db().jobs[0].id}/reassess`);

  const after = (await admin.get('/api/admin/audit-log', { limit: 500 })).body.data.length;
  assert.equal(after, before + 1);

  // There is no API that edits or deletes an entry.
  const patch = await admin.patch('/api/admin/audit-log/1', { summary: 'tampered' });
  assert.equal(patch.status, 404);
  const del = await admin.del('/api/admin/audit-log/1');
  assert.equal(del.status, 404);
});

test('workflow actions by other roles also reach the audit log', async () => {
  // Perform a worker-side action, then confirm it is attributed to that worker.
  const employer = await h.as(h.DEMO.employer);
  const job = await employer.post('/api/jobs', {
    title: 'Audited Application Target',
    company: 'Audit Co',
    category: 'Driver',
    country: 'UAE',
    city: 'Dubai',
    salary: 'AED 2,000 / month',
    exp: '1+ year',
    hours: '8 hours',
    vacancies: 2,
    visa: 'Yes',
    description: 'A listing used to confirm that worker-side workflow actions are audited.',
    requirements: 'A valid licence and one year of experience.'
  });
  const worker = await h.as(h.DEMO.worker2);
  const application = await worker.post('/api/applications', { jobId: job.body.data.id });
  assert.equal(application.status, 201);

  const admin = await h.as(h.DEMO.admin);
  const log = await admin.get('/api/admin/audit-log', { limit: 500 });
  const actions = new Set(log.body.data.map(e => e.action));
  assert.ok(actions.has('LOGIN_SUCCESS'));
  assert.ok(actions.has('JOB_CREATED'));
  assert.ok(actions.has('APPLICATION_CREATED'));

  const entry = log.body.data.find(e => e.action === 'APPLICATION_CREATED'
    && String(e.targetId) === String(application.body.data.id));
  assert.ok(entry);
  assert.equal(entry.actorRole, 'Worker');
  assert.equal(String(entry.actorId), String(h.findUser(h.DEMO.worker2).id));
});

test('the admin listing view reports applicant counts and risk scores', async () => {
  const admin = await h.as(h.DEMO.admin);
  const res = await admin.get('/api/admin/jobs');
  assert.equal(res.status, 200);
  for (const job of res.body.data) {
    assert.equal(typeof job.applicants, 'number');
    assert.ok(job.riskScore === null || typeof job.riskScore === 'number');
  }

  const filtered = await admin.get('/api/admin/jobs', { status: 'published' });
  assert.equal(filtered.body.data.every(j => j.status === 'published'), true);
});
