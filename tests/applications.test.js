'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.after(() => h.cleanup());

const JOB = {
  title: 'Pipeline Welder',
  company: 'Test Fabrication',
  category: 'Welder',
  country: 'Saudi Arabia',
  city: 'Riyadh',
  salary: 'SAR 1,900 - 2,300 / month',
  exp: '2+ years',
  hours: '8 hours',
  vacancies: 4,
  visa: 'Yes',
  benefits: ['Accommodation'],
  description: 'Structural and pipeline welding for a fabrication yard, working from issued drawings.',
  requirements: '6G welding certification and two years of yard experience.'
};

async function freshJob(title) {
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.post('/api/jobs', { ...JOB, title });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id;
}

test('applying requires authentication', async () => {
  const http = await h.agent();
  const jobId = await freshJob('Auth Required Apply');
  const res = await http.post('/api/applications').send({ jobId });
  assert.equal(res.status, 401);
});

test('an employer cannot file an application', async () => {
  const jobId = await freshJob('Employer Cannot Apply');
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.post('/api/applications', { jobId });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN_ROLE');
});

test('applying to a non-existent job is 404 and to a withheld job is 409', async () => {
  const worker = await h.as(h.DEMO.worker);
  const missing = await worker.post('/api/applications', { jobId: 999999 });
  assert.equal(missing.status, 404);

  const withheld = h.db().jobs.find(j => j.status === 'under_review');
  const blocked = await worker.post('/api/applications', { jobId: withheld.id });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'JOB_NOT_OPEN');
});

test('jobId must be present and numeric', async () => {
  const worker = await h.as(h.DEMO.worker);
  const missing = await worker.post('/api/applications', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'FIELD_REQUIRED');

  const wrongType = await worker.post('/api/applications', { jobId: 'not-a-number' });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error, 'FIELD_TYPE_INVALID');
});

test('an application is created against the session user, not a body-supplied id', async () => {
  const jobId = await freshJob('Session Identity Apply');
  const worker = await h.as(h.DEMO.worker);
  const otherId = h.findUser(h.DEMO.worker2).id;

  const res = await worker.post('/api/applications', { jobId, workerId: otherId, candidateName: 'Someone Else' });
  assert.equal(res.status, 201);

  const stored = h.db().applications.find(a => String(a.id) === String(res.body.data.id));
  assert.equal(String(stored.workerId), String(h.findUser(h.DEMO.worker).id));
  assert.equal(stored.status, 'Applied');
  assert.equal(stored.history.length, 1);
});

test('a duplicate application is rejected with 409', async () => {
  const jobId = await freshJob('Duplicate Apply');
  const worker = await h.as(h.DEMO.worker);

  const first = await worker.post('/api/applications', { jobId });
  assert.equal(first.status, 201);

  const second = await worker.post('/api/applications', { jobId });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'ALREADY_APPLIED');
  assert.equal(h.db().applications.filter(a => String(a.jobId) === String(jobId)).length, 1);
});

test('a worker only sees their own applications', async () => {
  const workerOne = await h.as(h.DEMO.worker);
  const workerTwo = await h.as(h.DEMO.worker2);
  const idOne = h.findUser(h.DEMO.worker).id;

  const mine = await workerOne.get('/api/applications', { pageSize: 100 });
  assert.equal(mine.status, 200);
  const myStoredIds = h.db().applications
    .filter(a => String(a.workerId) === String(idOne))
    .map(a => String(a.id)).sort();
  assert.deepEqual(mine.body.data.map(a => String(a.id)).sort(), myStoredIds);

  const theirs = await workerTwo.get('/api/applications', { pageSize: 100 });
  const overlap = theirs.body.data.filter(a => myStoredIds.includes(String(a.id)));
  assert.deepEqual(overlap, []);
});

test('fetching another worker\'s application by id is forbidden', async () => {
  const jobId = await freshJob('Cross Account Read');
  const workerTwo = await h.as(h.DEMO.worker2);
  const created = await workerTwo.post('/api/applications', { jobId });
  assert.equal(created.status, 201);

  const workerOne = await h.as(h.DEMO.worker);
  const res = await workerOne.get(`/api/applications/${created.body.data.id}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN_RESOURCE');
});

test('a worker cannot shortlist their own application', async () => {
  const jobId = await freshJob('Self Shortlist');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });

  const res = await worker.patch(`/api/applications/${created.body.data.id}`, { status: 'Shortlisted' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN_STAGE');
  assert.deepEqual(res.body.details.allowedRoles, ['Employer', 'Admin']);
});

test('a worker can withdraw their own application', async () => {
  const jobId = await freshJob('Self Withdraw');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });

  const res = await worker.patch(`/api/applications/${created.body.data.id}`, { status: 'Withdrawn' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'Withdrawn');
});

test('an unrelated employer cannot move an application', async () => {
  const http = await h.agent();
  await http.post('/api/auth/register').send({
    name: 'Outsider Employer',
    email: 'outsider@example.com',
    password: 'ValidPass123',
    role: 'Employer',
    profile: { companyName: 'Outsider Co', country: 'UAE', city: 'Dubai' }
  });

  const jobId = await freshJob('Unrelated Employer Stage');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });

  const outsider = await h.as('outsider@example.com', 'ValidPass123');
  const res = await outsider.patch(`/api/applications/${created.body.data.id}`, { status: 'Shortlisted' });
  assert.equal(res.status, 403);
});

test('the owning employer can move the application through valid stages only', async () => {
  const jobId = await freshJob('Stage Machine');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });
  const id = created.body.data.id;
  const employer = await h.as(h.DEMO.employer);

  // Applied -> Placed is not a legal move.
  const illegal = await employer.patch(`/api/applications/${id}`, { status: 'Placed' });
  assert.equal(illegal.status, 403, 'Placed is a consultancy/admin stage');

  const shortlisted = await employer.patch(`/api/applications/${id}`, { status: 'Shortlisted' });
  assert.equal(shortlisted.status, 200);

  const repeat = await employer.patch(`/api/applications/${id}`, { status: 'Shortlisted' });
  assert.equal(repeat.status, 409);
  assert.equal(repeat.body.error, 'STAGE_UNCHANGED');

  const offer = await employer.patch(`/api/applications/${id}`, { status: 'Offer Issued' });
  assert.equal(offer.status, 200);

  // Offer Issued -> Shortlisted is backwards and must be refused.
  const backwards = await employer.patch(`/api/applications/${id}`, { status: 'Shortlisted' });
  assert.equal(backwards.status, 409);
  assert.equal(backwards.body.error, 'STAGE_TRANSITION_INVALID');

  // Visa Processing belongs to the consultancy, not the employer.
  const wrongRole = await employer.patch(`/api/applications/${id}`, { status: 'Visa Processing' });
  assert.equal(wrongRole.status, 403);
});

test('an unknown stage value is rejected', async () => {
  const jobId = await freshJob('Unknown Stage');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });
  const employer = await h.as(h.DEMO.employer);

  const res = await employer.patch(`/api/applications/${created.body.data.id}`, { status: 'Hired Immediately' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'FIELD_VALUE_INVALID');
});

test('stage history records who made each change and when', async () => {
  const jobId = await freshJob('History Tracking');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });
  const employer = await h.as(h.DEMO.employer);
  await employer.patch(`/api/applications/${created.body.data.id}`, { status: 'Shortlisted', note: 'Good match' });

  const res = await worker.get(`/api/applications/${created.body.data.id}`);
  assert.equal(res.status, 200);
  const history = res.body.data.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].stage, 'Applied');
  assert.equal(history[1].stage, 'Shortlisted');
  assert.ok(history[1].byName);
  assert.ok(!Number.isNaN(new Date(history[1].at).getTime()));
});

test('interview scheduling validates the time and advances the stage', async () => {
  const jobId = await freshJob('Interview Flow');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });
  const id = created.body.data.id;
  const employer = await h.as(h.DEMO.employer);
  await employer.patch(`/api/applications/${id}`, { status: 'Shortlisted' });

  const past = await employer.post(`/api/applications/${id}/interview`, {
    scheduledAt: new Date(Date.now() - 86400000).toISOString()
  });
  assert.equal(past.status, 400);
  assert.equal(past.body.error, 'INTERVIEW_IN_PAST');

  const garbage = await employer.post(`/api/applications/${id}/interview`, { scheduledAt: 'tomorrow-ish' });
  assert.equal(garbage.status, 400);

  const ok = await employer.post(`/api/applications/${id}/interview`, {
    scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    mode: 'Video',
    notes: 'Bring your licence'
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.status, 'Interview Scheduled');
  assert.ok(ok.body.data.interview.scheduledAt);

  // The candidate sees the interview on their own record.
  const seen = await worker.get(`/api/applications/${id}`);
  assert.equal(seen.body.data.interview.mode, 'Video');
});

test('an outsider cannot schedule an interview on another employer\'s application', async () => {
  const jobId = await freshJob('Interview Ownership');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });

  const outsider = await h.as('outsider@example.com', 'ValidPass123');
  const res = await outsider.post(`/api/applications/${created.body.data.id}/interview`, {
    scheduledAt: new Date(Date.now() + 86400000).toISOString()
  });
  assert.equal(res.status, 403);
});

test('status filtering works and an unknown status returns an empty list', async () => {
  const employer = await h.as(h.DEMO.employer);
  const shortlisted = await employer.get('/api/applications', { status: 'Shortlisted', pageSize: 100 });
  assert.equal(shortlisted.status, 200);
  assert.equal(shortlisted.body.data.every(a => a.status === 'Shortlisted'), true);

  const none = await employer.get('/api/applications', { status: 'Nonexistent' });
  assert.deepEqual(none.body.data, []);
});

test('changes persist across a store reload', async () => {
  const jobId = await freshJob('Persistence Check');
  const worker = await h.as(h.DEMO.worker);
  const created = await worker.post('/api/applications', { jobId });

  // Read the file from disk, bypassing the in-memory copy.
  const fs = require('fs');
  const store = require('../backend/lib/store');
  const onDisk = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  assert.ok(onDisk.applications.some(a => String(a.id) === String(created.body.data.id)));
});
