'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.after(() => h.cleanup());

const VALID_JOB = {
  title: 'Site Electrician',
  company: 'Test Build Co',
  category: 'Electrician',
  country: 'UAE',
  city: 'Dubai',
  salary: 'AED 2,100 - 2,600 / month',
  exp: '3+ years',
  hours: '8 hours',
  vacancies: 6,
  visa: 'Yes',
  benefits: ['Accommodation', 'Transport'],
  description: 'Commercial site electrician for fit-out works across Dubai projects, reporting to the site engineer.',
  requirements: 'ITI electrical certificate and three years of site experience.'
};

test('public job listing requires no authentication and only shows published roles', async () => {
  const http = await h.agent();
  const res = await http.get('/api/jobs');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.ok(res.body.data.length > 0);
  assert.equal(res.body.data.every(job => job.status === 'published'), true);
  // Risk internals are not exposed to anonymous browsers.
  assert.equal(res.body.data.every(job => job.risk === undefined), true);
});

test('a flagged demo listing is withheld from the public list', async () => {
  const http = await h.agent();
  const publicRes = await http.get('/api/jobs', { pageSize: 100 });
  const titles = publicRes.body.data.map(j => j.title);
  assert.equal(titles.some(title => /Urgent Driver Required/i.test(title)), false);

  const flagged = h.db().jobs.find(j => /Urgent Driver Required/i.test(j.title));
  assert.ok(flagged, 'expected the seeded high-risk listing to exist');
  assert.equal(flagged.status, 'under_review');
  assert.ok(flagged.risk.score >= 60);
});

test('fetching a withheld listing anonymously returns 404', async () => {
  const http = await h.agent();
  const flagged = h.db().jobs.find(j => j.status === 'under_review');
  const res = await http.get(`/api/jobs/${flagged.id}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'JOB_NOT_FOUND');
});

test('an invalid job id returns 404 rather than a server error', async () => {
  const http = await h.agent();
  for (const id of ['999999', 'abc', '-1']) {
    const res = await http.get(`/api/jobs/${id}`);
    assert.equal(res.status, 404, `id ${id}`);
  }
});

test('search, category and country filters apply', async () => {
  const http = await h.agent();
  const welder = await http.get('/api/jobs').query({ search: 'welder' });
  assert.equal(welder.status, 200);
  assert.equal(welder.body.data.every(j => /welder/i.test(`${j.title} ${j.description} ${j.requirements}`)), true);

  const local = await http.get('/api/jobs').query({ type: 'Local' });
  assert.equal(local.body.data.every(j => j.type === 'Local'), true);

  const qatar = await http.get('/api/jobs').query({ country: 'Qatar' });
  assert.equal(qatar.body.data.every(j => j.country === 'Qatar'), true);
});

test('an empty result set is a 200 with an empty array', async () => {
  const http = await h.agent();
  const res = await http.get('/api/jobs').query({ search: 'zzzz-no-such-trade-zzzz' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.total, 0);
});

test('pagination returns distinct pages and page metadata', async () => {
  const http = await h.agent();
  const page1 = await http.get('/api/jobs').query({ page: 1, pageSize: 2 });
  const page2 = await http.get('/api/jobs').query({ page: 2, pageSize: 2 });
  assert.equal(page1.body.data.length, 2);
  assert.ok(page1.body.totalPages >= 2);
  assert.notEqual(page1.body.data[0].id, page2.body.data[0].id);
});

test('an invalid pageSize is rejected with a field error', async () => {
  const http = await h.agent();
  const res = await http.get('/api/jobs').query({ pageSize: 9999 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'FIELD_OUT_OF_RANGE');
});

test('posting a job requires authentication', async () => {
  const http = await h.agent();
  const res = await http.post('/api/jobs').send(VALID_JOB);
  assert.equal(res.status, 401);
});

test('a worker cannot post a job', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/jobs', VALID_JOB);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN_ROLE');
});

test('a job with missing required fields is rejected', async () => {
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.post('/api/jobs', { title: 'Only a title' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'FIELD_REQUIRED');
});

test('a job with a wrongly typed vacancies field is rejected', async () => {
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.post('/api/jobs', { ...VALID_JOB, vacancies: 'many' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'FIELD_TYPE_INVALID');
});

test('an unknown country is rejected rather than stored', async () => {
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.post('/api/jobs', { ...VALID_JOB, country: 'Atlantis' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'FIELD_VALUE_INVALID');
});

test('a valid job is created, scored server side, and published', async () => {
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.post('/api/jobs', VALID_JOB);
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'published');
  assert.ok(res.body.risk);
  assert.equal(typeof res.body.risk.score, 'number');
  assert.ok(Array.isArray(res.body.risk.factors));
  assert.equal(res.body.heldForReview, false);
});

test('a client-supplied risk score, verified flag and review state are ignored', async () => {
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.post('/api/jobs', {
    ...VALID_JOB,
    title: 'Client Supplied Risk Test',
    riskScore: 0,
    risk: { score: 0, band: 'low', factors: [] },
    verified: true,
    employerVerified: true,
    reviewState: 'cleared'
  });
  assert.equal(res.status, 201);

  const stored = h.db().jobs.find(j => j.title === 'Client Supplied Risk Test');
  // The stored score comes from the heuristics, not the body: the demo employer
  // is unverified, so at minimum that factor must be present.
  assert.ok(stored.risk.factors.some(f => f.code === 'EMPLOYER_NOT_VERIFIED'));
  assert.ok(stored.risk.score > 0);
  assert.equal(stored.verified, undefined);
  // Verification is derived from the employer account, which is still unverified.
  assert.equal(res.body.data.employerVerified, false);
});

test('a listing with fraud signals is held for review instead of published', async () => {
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.post('/api/jobs', {
    ...VALID_JOB,
    title: 'Urgent Hiring No Interview',
    salary: 'AED 25,000 / month',
    vacancies: 900,
    visa: 'No',
    description: 'Immediate joining. Registration fee applies. Contact us on WhatsApp +91 99999 00000 for the visa.',
    requirements: 'No experience needed at all.'
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.heldForReview, true);
  assert.equal(res.body.data.status, 'under_review');
  const codes = res.body.risk.factors.map(f => f.code);
  assert.ok(codes.includes('CANDIDATE_FEE_REQUESTED'));
  assert.ok(codes.includes('OFF_PLATFORM_CONTACT'));
  assert.ok(codes.includes('SALARY_IMPLAUSIBLE') || codes.includes('SALARY_ABOVE_BAND'));
  assert.ok(codes.includes('OVERSEAS_WITHOUT_VISA'));
});

test('every risk factor carries a weight and a human-readable reason', async () => {
  const admin = await h.as(h.DEMO.admin);
  const res = await admin.get('/api/admin/fraud-queue');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length > 0);
  for (const row of res.body.data) {
    for (const factor of row.factors) {
      assert.equal(typeof factor.code, 'string');
      assert.equal(typeof factor.weight, 'number');
      assert.ok(factor.detail.length > 5, `factor ${factor.code} has no explanation`);
    }
  }
});

test('an employer sees risk details for its own listing but a stranger does not', async () => {
  const employer = await h.as(h.DEMO.employer);
  const created = await employer.post('/api/jobs', { ...VALID_JOB, title: 'Risk Visibility Test' });
  const id = created.body.data.id;

  const owner = await employer.get(`/api/jobs/${id}`);
  assert.ok(owner.body.data.risk);

  const worker = await h.as(h.DEMO.worker);
  const other = await worker.get(`/api/jobs/${id}`);
  assert.equal(other.status, 200);
  assert.equal(other.body.data.risk, undefined);
  assert.equal(typeof other.body.data.riskBand, 'string');
});

test('a worker sees an explainable match score, not a random number', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.get('/api/jobs', { search: 'Heavy Driver' });
  const job = res.body.data[0];
  assert.ok(job);
  assert.equal(typeof job.matchScore, 'number');
  assert.ok(Array.isArray(job.matchReasons) && job.matchReasons.length > 0);

  // The same request twice must give the same score.
  const again = await worker.get('/api/jobs', { search: 'Heavy Driver' });
  assert.equal(again.body.data[0].matchScore, job.matchScore);
  assert.ok(job.matchReasons.some(r => r.code === 'TRADE_MATCH'));
});

test('an employer cannot edit or delete another employer\'s listing', async () => {
  const http = await h.agent();
  const intruderEmail = 'rival-employer@example.com';
  await http.post('/api/auth/register').send({
    name: 'Rival Employer',
    email: intruderEmail,
    password: 'ValidPass123',
    role: 'Employer',
    profile: { companyName: 'Rival Co', country: 'UAE', city: 'Dubai' }
  });

  const owner = await h.as(h.DEMO.employer);
  const created = await owner.post('/api/jobs', { ...VALID_JOB, title: 'Ownership Test Listing' });
  const id = created.body.data.id;

  const rival = await h.as(intruderEmail, 'ValidPass123');
  const patch = await rival.patch(`/api/jobs/${id}`, { title: 'Hijacked' });
  assert.equal(patch.status, 403);
  assert.equal(patch.body.error, 'FORBIDDEN_RESOURCE');

  const del = await rival.del(`/api/jobs/${id}`);
  assert.equal(del.status, 403);

  const stored = h.db().jobs.find(j => String(j.id) === String(id));
  assert.equal(stored.title, 'Ownership Test Listing');
});

test('scope=mine only returns the caller\'s own listings', async () => {
  const employer = await h.as(h.DEMO.employer);
  const mine = await employer.get('/api/jobs', { scope: 'mine', pageSize: 100 });
  assert.equal(mine.status, 200);
  const employerId = h.findUser(h.DEMO.employer).id;
  assert.equal(mine.body.data.every(j => j.risk !== undefined), true);
  assert.equal(h.db().jobs.filter(j => String(j.employerId) === String(employerId)).length >= mine.body.data.length, true);

  const worker = await h.as(h.DEMO.worker);
  const denied = await worker.get('/api/jobs', { scope: 'mine' });
  assert.equal(denied.status, 403);
});

test('editing a listing re-runs the risk check and can pull it back for review', async () => {
  const employer = await h.as(h.DEMO.employer);
  const created = await employer.post('/api/jobs', { ...VALID_JOB, title: 'Edit Risk Test' });
  const id = created.body.data.id;
  assert.equal(created.body.data.status, 'published');

  const edited = await employer.patch(`/api/jobs/${id}`, {
    description: 'Pay a registration fee of 15000 to confirm your seat. WhatsApp +91 90000 11111.',
    salary: 'AED 30,000 / month'
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.heldForReview, true);
  assert.equal(edited.body.data.status, 'under_review');
});

test('deleting a listing with live applications closes it instead of destroying the records', async () => {
  const employer = await h.as(h.DEMO.employer);
  const created = await employer.post('/api/jobs', { ...VALID_JOB, title: 'Closable Listing' });
  const jobId = created.body.data.id;

  const worker = await h.as(h.DEMO.worker2);
  const applied = await worker.post('/api/applications', { jobId });
  assert.equal(applied.status, 201);

  const del = await employer.del(`/api/jobs/${jobId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.closed, true);

  const stored = h.db().jobs.find(j => String(j.id) === String(jobId));
  assert.equal(stored.status, 'closed');
  assert.ok(h.db().applications.some(a => String(a.jobId) === String(jobId)));
});

test('deleting a listing with no applications removes it', async () => {
  const employer = await h.as(h.DEMO.employer);
  const created = await employer.post('/api/jobs', { ...VALID_JOB, title: 'Deletable Listing' });
  const jobId = created.body.data.id;

  const del = await employer.del(`/api/jobs/${jobId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.closed, false);
  assert.equal(h.db().jobs.some(j => String(j.id) === String(jobId)), false);
});

test('reporting a listing records the report and flags it', async () => {
  const employer = await h.as(h.DEMO.employer);
  const created = await employer.post('/api/jobs', { ...VALID_JOB, title: 'Reportable Listing' });
  const jobId = created.body.data.id;

  const worker = await h.as(h.DEMO.worker);
  const short = await worker.post(`/api/jobs/${jobId}/report`, { reason: 'bad' });
  assert.equal(short.status, 400);

  const report = await worker.post(`/api/jobs/${jobId}/report`, {
    reason: 'The recruiter asked me for a placement fee over the phone.'
  });
  assert.equal(report.status, 201);

  const stored = h.db().jobs.find(j => String(j.id) === String(jobId));
  assert.equal(stored.reports.length, 1);
  assert.equal(stored.reviewState, 'flagged');
});

test('job applicants are visible to the owning employer only', async () => {
  const employer = await h.as(h.DEMO.employer);
  const jobs = await employer.get('/api/jobs', { scope: 'mine', pageSize: 100 });
  const jobId = jobs.body.data[0].id;

  const ok = await employer.get(`/api/jobs/${jobId}/applicants`);
  assert.equal(ok.status, 200);

  const worker = await h.as(h.DEMO.worker);
  const denied = await worker.get(`/api/jobs/${jobId}/applicants`);
  assert.equal(denied.status, 403);
});

test('applicant payloads expose document counts but never document files', async () => {
  const employer = await h.as(h.DEMO.employer);
  const employerId = h.findUser(h.DEMO.employer).id;
  const jobWithApplicants = h.db().applications.find(a => String(a.employerId) === String(employerId));
  const res = await employer.get(`/api/jobs/${jobWithApplicants.jobId}/applicants`);
  assert.equal(res.status, 200);

  for (const row of res.body.data) {
    assert.ok(row.documentSummary);
    assert.equal(typeof row.documentSummary.verified, 'number');
    assert.equal(row.documents, undefined);
    assert.equal(JSON.stringify(row).includes('storedName'), false);
  }
});
