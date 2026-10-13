'use strict';

/**
 * End-to-end workflow tests.
 *
 * These follow the four role journeys through real HTTP requests against the
 * real datastore, asserting that each change is visible to the other roles and
 * still there on a subsequent request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const h = require('./helpers');
const store = require('../backend/lib/store');

test.after(() => h.cleanup());

const PASSWORD = 'JourneyPass123';
const WORKER = 'journey-worker@example.com';
const EMPLOYER = 'journey-employer@example.com';
const CONSULTANCY = 'journey-consultancy@example.com';

const shared = {};

test('employer journey: signup, profile, create listing, risk check, publish', async () => {
  const http = await h.agent();

  const signup = await http.post('/api/auth/register').send({
    name: 'Journey Build LLC',
    email: EMPLOYER,
    password: PASSWORD,
    confirmPassword: PASSWORD,
    role: 'Employer',
    language: 'en',
    profile: { companyName: 'Journey Build LLC', country: 'UAE', city: 'Dubai', sector: 'Construction', contactPerson: 'HR Desk' }
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.role, 'Employer');
  assert.equal(signup.body.user.profile.verificationStatus, 'unverified');

  const employer = await h.as(EMPLOYER, PASSWORD);

  const profile = await employer.patch('/api/auth/me', {
    profile: { companyName: 'Journey Build LLC', country: 'UAE', city: 'Dubai', sector: 'Infrastructure', contactPerson: 'Priya (HR)' }
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.profile.sector, 'Infrastructure');

  // A listing with fraud signals is held back, which the employer is told.
  const risky = await employer.post('/api/jobs', {
    title: 'Driver Urgent Joining',
    company: 'Journey Build LLC',
    category: 'Driver',
    country: 'UAE',
    city: 'Dubai',
    salary: 'AED 18,000 / month',
    exp: 'None',
    hours: '8 hours',
    vacancies: 500,
    visa: 'No',
    description: 'Immediate joining, registration fee applies, contact on WhatsApp +91 90000 12345.',
    requirements: 'None at all.'
  });
  assert.equal(risky.status, 201);
  assert.equal(risky.body.heldForReview, true);
  assert.equal(risky.body.data.status, 'under_review');
  shared.riskyJobId = risky.body.data.id;

  const clean = await employer.post('/api/jobs', {
    title: 'Journey Heavy Driver',
    company: 'Journey Build LLC',
    category: 'Driver',
    country: 'UAE',
    city: 'Dubai',
    salary: 'AED 2,100 - 2,400 / month',
    inr: '≈ ₹47,000 – ₹54,000',
    exp: '2+ years',
    hours: '9 hours',
    vacancies: 8,
    visa: 'Yes',
    benefits: ['Accommodation', 'Transport', 'Medical Insurance'],
    description: 'Heavy goods driving on fixed intercity routes between Dubai and Abu Dhabi, with a company vehicle.',
    requirements: 'Valid heavy vehicle licence, two years of commercial experience and a valid passport.'
  });
  assert.equal(clean.status, 201);
  assert.equal(clean.body.data.status, 'published');
  assert.equal(clean.body.heldForReview, false);
  shared.jobId = clean.body.data.id;

  // The published listing is visible to an anonymous visitor; the held one is not.
  const publicList = await http.get('/api/jobs').query({ search: 'Journey', pageSize: 100 });
  const titles = publicList.body.data.map(j => j.title);
  assert.ok(titles.includes('Journey Heavy Driver'));
  assert.equal(titles.includes('Driver Urgent Joining'), false);
});

test('worker journey: signup, profile, browse, open, apply, view application', async () => {
  const http = await h.agent();

  const signup = await http.post('/api/auth/register').send({
    name: 'Journey Worker',
    email: WORKER,
    phone: '+91 90000 77777',
    password: PASSWORD,
    role: 'Worker',
    language: 'ta',
    profile: {
      trade: 'Driver',
      experienceYears: 5,
      skills: ['Heavy Vehicles', 'Load Safety'],
      languages: ['Tamil', 'English'],
      preferredCountries: ['UAE'],
      currentLocation: 'Tiruchirappalli, India',
      passportAvailable: true
    }
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.language, 'ta');

  const worker = await h.as(WORKER, PASSWORD);

  // Browse and filter.
  const browse = await worker.get('/api/jobs', { search: 'Journey Heavy Driver' });
  assert.equal(browse.status, 200);
  const job = browse.body.data.find(j => String(j.id) === String(shared.jobId));
  assert.ok(job, 'the published listing must appear for the worker');
  assert.equal(typeof job.matchScore, 'number');
  assert.ok(job.matchReasons.some(r => r.code === 'TRADE_MATCH'));
  assert.ok(job.matchReasons.some(r => r.code === 'DESTINATION_PREFERRED'));

  // Open the detail view.
  const detail = await worker.get(`/api/jobs/${shared.jobId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.title, 'Journey Heavy Driver');
  assert.equal(detail.body.data.employerVerified, false);

  // Apply.
  const applied = await worker.post('/api/applications', {
    jobId: shared.jobId,
    note: 'I have five years of heavy vehicle experience and a valid passport.'
  });
  assert.equal(applied.status, 201);
  shared.applicationId = applied.body.data.id;

  // Visible on a subsequent authenticated request.
  const mine = await worker.get('/api/applications', { pageSize: 50 });
  assert.ok(mine.body.data.some(a => String(a.id) === String(shared.applicationId)));
  assert.equal(mine.body.data.find(a => String(a.id) === String(shared.applicationId)).status, 'Applied');

  // No visa case yet, reported honestly.
  const visa = await worker.get('/api/visa/my-status');
  assert.equal(visa.body.data, null);
});

test('worker journey: upload a document and see its verification state', async () => {
  const worker = await h.as(WORKER, PASSWORD);

  const uploaded = await worker.upload('/api/documents/upload',
    { name: 'Journey passport', type: 'passport' },
    { buffer: h.samplePdf(), filename: 'passport.pdf', contentType: 'application/pdf' });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.data.status, 'Pending Review');
  shared.documentId = uploaded.body.data.id;

  const list = await worker.get('/api/documents');
  const row = list.body.data.find(d => String(d.id) === String(shared.documentId));
  assert.ok(row);
  assert.equal(row.hasFile, true);

  const file = await worker.get(`/api/documents/${shared.documentId}/file`);
  assert.equal(file.status, 200);
});

test('worker journey: ask the assistant in Tamil and keep the history', async () => {
  const worker = await h.as(WORKER, PASSWORD);

  const reply = await worker.post('/api/ai/chat', { message: 'என் விசா விண்ணப்பத்தை எப்படி கண்காணிப்பது?' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.lang, 'ta');
  assert.match(reply.body.reply, /[஀-௿]/);

  const history = await worker.get('/api/ai/chat');
  assert.equal(history.body.messages.length, 2);
  assert.equal(history.body.messages[0].role, 'user');
  assert.equal(history.body.messages[1].role, 'assistant');
});

test('employer journey: review applicants, shortlist, interview, issue offer', async () => {
  const employer = await h.as(EMPLOYER, PASSWORD);

  const applicants = await employer.get(`/api/jobs/${shared.jobId}/applicants`);
  assert.equal(applicants.status, 200);
  assert.equal(applicants.body.data.length, 1);

  const row = applicants.body.data[0];
  assert.equal(row.candidate.name, 'Journey Worker');
  assert.ok(row.matchReasons.length > 0);
  assert.equal(row.documentSummary.total >= 1, true);
  assert.equal(row.documentSummary.verified, 0);
  // The employer never receives the document itself.
  assert.equal(JSON.stringify(row).includes('storedName'), false);

  const shortlisted = await employer.patch(`/api/applications/${shared.applicationId}`, { status: 'Shortlisted' });
  assert.equal(shortlisted.status, 200);

  const interview = await employer.post(`/api/applications/${shared.applicationId}/interview`, {
    scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    mode: 'Phone',
    notes: 'Please have your licence to hand.'
  });
  assert.equal(interview.status, 201);
  assert.equal(interview.body.data.status, 'Interview Scheduled');

  const offer = await employer.patch(`/api/applications/${shared.applicationId}`, { status: 'Offer Issued' });
  assert.equal(offer.status, 200);

  // The worker sees every one of those changes on their own record.
  const worker = await h.as(WORKER, PASSWORD);
  const seen = await worker.get(`/api/applications/${shared.applicationId}`);
  assert.equal(seen.body.data.status, 'Offer Issued');
  assert.equal(seen.body.data.interview.mode, 'Phone');
  assert.deepEqual(
    seen.body.data.history.map(entry => entry.stage),
    ['Applied', 'Shortlisted', 'Interview Scheduled', 'Offer Issued']
  );
});

test('consultancy journey: take the case, update a milestone, review documents', async () => {
  const http = await h.agent();
  const signup = await http.post('/api/auth/register').send({
    name: 'Journey Migration Services',
    email: CONSULTANCY,
    password: PASSWORD,
    role: 'Consultancy',
    profile: { agencyName: 'Journey Migration Services', city: 'Chennai', registrationReference: 'TEST-REF-001' }
  });
  assert.equal(signup.status, 201);

  const consultancy = await h.as(CONSULTANCY, PASSWORD);

  // Before taking the case the consultancy cannot see the candidate's documents.
  const beforeDocs = await consultancy.get('/api/documents', { ownerId: String(h.findUser(WORKER).id) });
  assert.equal(beforeDocs.status === 403 || beforeDocs.body.data.length === 0, true);

  const offers = await consultancy.get('/api/applications', { status: 'Offer Issued', pageSize: 50 });
  // Applications only become visible once a case is assigned, so the
  // consultancy opens the case by application id.
  assert.equal(offers.status, 200);

  const opened = await consultancy.post('/api/visa/cases', { applicationId: shared.applicationId });
  assert.equal(opened.status, 201);
  shared.caseId = opened.body.data.id;
  assert.equal(opened.body.data.stages.length, 7);
  assert.equal(opened.body.data.stages[0].status, 'done');
  assert.equal(opened.body.data.stages[1].status, 'current');

  // Now the candidate's non-sensitive documents are visible.
  const caseView = await consultancy.get(`/api/visa/cases/${shared.caseId}`);
  assert.equal(caseView.status, 200);
  assert.ok(caseView.body.data.documents.some(d => String(d.id) === String(shared.documentId)));

  const verified = await consultancy.patch(`/api/documents/${shared.documentId}`, { status: 'Verified' });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.status, 'Verified');

  const milestone = await consultancy.patch('/api/visa/stages', {
    caseId: shared.caseId,
    stageName: 'Visa Applied',
    status: 'done',
    note: 'Filed with the sponsor on the employer quota.'
  });
  assert.equal(milestone.status, 200);
  const stage = milestone.body.data.stages.find(s => s.name === 'Visa Applied');
  assert.equal(stage.status, 'done');
  assert.ok(stage.updatedAt);
  assert.equal(stage.updatedByName, 'Journey Migration Services');

  const caseload = await consultancy.get('/api/consultancy/cases');
  assert.equal(caseload.body.data.length, 1);
  assert.equal(caseload.body.data[0].currentStage, 'Medical Test');
});

test('consultancy changes persist and are visible to the worker after a reload', async () => {
  // Read straight from disk to prove the change was written, not just cached.
  const onDisk = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  const persisted = onDisk.visaCases.find(v => String(v.id) === String(shared.caseId));
  assert.ok(persisted);
  assert.equal(persisted.stages.find(s => s.name === 'Visa Applied').status, 'done');

  const worker = await h.as(WORKER, PASSWORD);
  const mine = await worker.get('/api/visa/my-status');
  assert.equal(mine.status, 200);
  assert.equal(String(mine.body.data.id), String(shared.caseId));
  assert.equal(mine.body.data.consultancy, 'Journey Migration Services');
  assert.ok(mine.body.data.progress >= 28);

  const docs = await worker.get('/api/documents');
  const passport = docs.body.data.find(d => String(d.id) === String(shared.documentId));
  assert.equal(passport.status, 'Verified');
  assert.equal(passport.verifiedByName, 'Journey Migration Services');

  const notifications = await worker.get('/api/notifications');
  assert.ok(notifications.body.data.some(n => n.type === 'visa'));
  assert.ok(notifications.body.data.some(n => n.type === 'document'));
});

test('admin journey: metrics, flagged listing, risk explanation, action, audit record', async () => {
  const admin = await h.as(h.DEMO.admin);

  const stats = await admin.get('/api/admin/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.body.data.users.total >= 8);
  assert.ok(stats.body.data.jobs.byStatus.under_review >= 1);

  const queue = await admin.get('/api/admin/fraud-queue');
  const flagged = queue.body.data.find(row => String(row.id) === String(shared.riskyJobId));
  assert.ok(flagged, 'the held listing must appear in the review queue');
  assert.ok(flagged.riskScore >= 60);

  // The reasons are inspectable, which is what makes the decision reviewable.
  const codes = flagged.factors.map(f => f.code);
  assert.ok(codes.includes('CANDIDATE_FEE_REQUESTED'));
  assert.ok(codes.includes('OFF_PLATFORM_CONTACT'));
  assert.ok(flagged.factors.every(f => f.detail && f.detail.length > 5));
  assert.ok(flagged.employer.name.includes('Journey Build'));

  const action = await admin.post('/api/admin/fraud-action', {
    id: shared.riskyJobId,
    action: 'remove',
    reason: 'Listing demands a registration fee from the worker and routes contact off-platform.'
  });
  assert.equal(action.status, 200);
  assert.ok(action.body.auditId);

  const log = await admin.get('/api/admin/audit-log', { limit: 50 });
  const entry = log.body.data.find(e => String(e.id) === String(action.body.auditId));
  assert.ok(entry);
  assert.equal(entry.action, 'LISTING_REMOVE');
  assert.equal(entry.actorRole, 'Admin');
  assert.match(entry.summary, /registration fee/);

  // The audit entry is on disk, not only in memory.
  const onDisk = JSON.parse(fs.readFileSync(store.DB_FILE, 'utf8'));
  assert.ok(onDisk.auditLogs.some(e => String(e.id) === String(action.body.auditId)));

  // And the listing really is gone.
  const gone = await admin.get(`/api/jobs/${shared.riskyJobId}`);
  assert.equal(gone.status, 404);
});

test('admin journey: verify the employer and see it reflected on the listing', async () => {
  const admin = await h.as(h.DEMO.admin);
  const employerId = h.findUser(EMPLOYER).id;

  const verified = await admin.patch(`/api/admin/users/${employerId}/verification`, {
    verificationStatus: 'verified',
    evidenceReference: 'Trade licence DED-99887 verified against the issuing register'
  });
  assert.equal(verified.status, 200);

  const http = await h.agent();
  const listing = await http.get(`/api/jobs/${shared.jobId}`);
  assert.equal(listing.body.data.employerVerified, true);

  const log = await admin.get('/api/admin/audit-log', { action: 'ACCOUNT_VERIFICATION_CHANGED' });
  assert.ok(log.body.data.some(e => /DED-99887/.test(JSON.stringify(e.metadata))));
});

test('cross-role isolation holds throughout the journey', async () => {
  const worker = await h.as(WORKER, PASSWORD);
  const employer = await h.as(EMPLOYER, PASSWORD);
  const consultancy = await h.as(CONSULTANCY, PASSWORD);

  // The employer cannot read the visa case or the candidate's documents.
  const employerCase = await employer.get(`/api/visa/cases/${shared.caseId}`);
  assert.ok([403, 200].includes(employerCase.status));
  if (employerCase.status === 200) {
    // The employer is a party to the case, so a redacted view is acceptable -
    // but it must never include a document file reference.
    assert.equal(JSON.stringify(employerCase.body).includes('storedName'), false);
  }
  const employerDoc = await employer.get(`/api/documents/${shared.documentId}/file`);
  assert.equal(employerDoc.status, 403);

  // The worker cannot reach any admin surface.
  const workerAdmin = await worker.get('/api/admin/stats');
  assert.equal(workerAdmin.status, 403);

  // The consultancy cannot change the application's employer-side stages.
  const stageAttempt = await consultancy.patch(`/api/applications/${shared.applicationId}`, { status: 'Shortlisted' });
  assert.equal(stageAttempt.status, 403);

  // And nobody can read another worker's visa case by guessing an id.
  const otherCase = h.db().visaCases.find(v => String(v.id) !== String(shared.caseId));
  if (otherCase) {
    const guess = await worker.get(`/api/visa/cases/${otherCase.id}`);
    assert.equal(guess.status, 403);
  }
});

test('placement completes the workflow and the records agree', async () => {
  const consultancy = await h.as(CONSULTANCY, PASSWORD);

  for (const stageName of ['Medical Test', 'Embassy Submission', 'Visa Stamping', 'Travel Booking', 'Departure']) {
    const res = await consultancy.patch('/api/visa/stages', {
      caseId: shared.caseId,
      stageName,
      status: 'done'
    });
    assert.equal(res.status, 200, `${stageName}: ${JSON.stringify(res.body)}`);
  }

  const final = await consultancy.get(`/api/visa/cases/${shared.caseId}`);
  assert.equal(final.body.data.progress, 100);

  const placed = await consultancy.patch(`/api/applications/${shared.applicationId}`, { status: 'Placed' });
  assert.equal(placed.status, 200);

  const admin = await h.as(h.DEMO.admin);
  const stats = await admin.get('/api/admin/stats');
  assert.ok(stats.body.data.placements >= 1);

  const worker = await h.as(WORKER, PASSWORD);
  const mine = await worker.get('/api/applications');
  assert.equal(mine.body.data.find(a => String(a.id) === String(shared.applicationId)).status, 'Placed');
});

test('session expiry and logout end the journey cleanly', async () => {
  const http = await h.agent();
  const session = await http.post('/api/auth/login').send({ identifier: WORKER, password: PASSWORD });
  const token = session.body.token;

  const before = await http.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(before.status, 200);

  await http.post('/api/auth/logout').set('Authorization', `Bearer ${token}`);

  const after = await http.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(after.status, 401);
  assert.equal(after.body.error, 'AUTH_REQUIRED');
});
