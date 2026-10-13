'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.after(() => h.cleanup());

const JOB = {
  title: 'Case Flow Driver',
  company: 'Case Flow Logistics',
  category: 'Driver',
  country: 'UAE',
  city: 'Dubai',
  salary: 'AED 2,000 - 2,300 / month',
  exp: '2+ years',
  hours: '9 hours',
  vacancies: 3,
  visa: 'Yes',
  benefits: ['Accommodation'],
  description: 'Heavy goods driving between Dubai and Abu Dhabi on a fixed night route.',
  requirements: 'Valid heavy licence and two years of commercial driving.'
};

/** Drives an application up to "Offer Issued" so a visa case can be opened. */
async function applicationWithOffer(title, workerEmail = h.DEMO.worker2) {
  const employer = await h.as(h.DEMO.employer);
  const job = await employer.post('/api/jobs', { ...JOB, title });
  assert.equal(job.status, 201, JSON.stringify(job.body));

  const worker = await h.as(workerEmail);
  const application = await worker.post('/api/applications', { jobId: job.body.data.id });
  assert.equal(application.status, 201);

  const id = application.body.data.id;
  await employer.patch(`/api/applications/${id}`, { status: 'Shortlisted' });
  await employer.patch(`/api/applications/${id}`, { status: 'Offer Issued' });
  return id;
}

// --- visa cases -------------------------------------------------------------

test('my-status is worker-only and returns the caller\'s own case', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.get('/api/visa/my-status');
  assert.equal(res.status, 200);
  assert.ok(res.body.data);
  assert.equal(res.body.data.stages.length, 7);

  const employer = await h.as(h.DEMO.employer);
  const denied = await employer.get('/api/visa/my-status');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'FORBIDDEN_ROLE');
});

test('a worker with no case gets a null payload, not an error or someone else\'s case', async () => {
  const http = await h.agent();
  await http.post('/api/auth/register').send({
    name: 'Caseless Worker',
    email: 'caseless@example.com',
    password: 'ValidPass123',
    role: 'Worker'
  });
  const worker = await h.as('caseless@example.com', 'ValidPass123');
  const res = await worker.get('/api/visa/my-status');
  assert.equal(res.status, 200);
  assert.equal(res.body.data, null);
});

test('a case cannot be opened before an offer is issued', async () => {
  const employer = await h.as(h.DEMO.employer);
  const job = await employer.post('/api/jobs', { ...JOB, title: 'Premature Case' });
  const worker = await h.as(h.DEMO.worker2);
  const application = await worker.post('/api/applications', { jobId: job.body.data.id });

  const consultancy = await h.as(h.DEMO.consultancy);
  const res = await consultancy.post('/api/visa/cases', { applicationId: application.body.data.id });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'APPLICATION_NOT_READY');
});

test('a worker cannot open a visa case for themselves', async () => {
  const applicationId = await applicationWithOffer('Worker Opens Case');
  const worker = await h.as(h.DEMO.worker2);
  const res = await worker.post('/api/visa/cases', { applicationId });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'FORBIDDEN_ROLE');
});

test('a consultancy opening a case gains access and the application advances', async () => {
  const applicationId = await applicationWithOffer('Consultancy Opens Case');
  const consultancy = await h.as(h.DEMO.consultancy);
  const res = await consultancy.post('/api/visa/cases', { applicationId });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.stages.length, 7);

  const stored = h.db().applications.find(a => String(a.id) === String(applicationId));
  assert.equal(stored.status, 'Visa Processing');

  const duplicate = await consultancy.post('/api/visa/cases', { applicationId });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'VISA_CASE_EXISTS');
});

test('an unassigned consultancy cannot read or update another agency\'s case', async () => {
  const http = await h.agent();
  await http.post('/api/auth/register').send({
    name: 'Rival Agency',
    email: 'rival-agency@example.com',
    password: 'ValidPass123',
    role: 'Consultancy',
    profile: { agencyName: 'Rival Agency', city: 'Kochi' }
  });

  const demoCase = h.db().visaCases[0];
  const rival = await h.as('rival-agency@example.com', 'ValidPass123');

  const read = await rival.get(`/api/visa/cases/${demoCase.id}`);
  assert.equal(read.status, 403);
  assert.equal(read.body.error, 'FORBIDDEN_RESOURCE');

  const write = await rival.patch('/api/visa/stages', {
    caseId: demoCase.id,
    stageName: 'Visa Stamping',
    status: 'done'
  });
  assert.equal(write.status, 403);

  const list = await rival.get('/api/visa/cases');
  assert.deepEqual(list.body.data, []);
});

test('an employer cannot move a visa milestone', async () => {
  const demoCase = h.db().visaCases[0];
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.patch('/api/visa/stages', {
    caseId: demoCase.id,
    stageName: 'Visa Stamping',
    status: 'done'
  });
  assert.equal(res.status, 403);
});

test('milestone updates are sequential, stamped and attributed', async () => {
  const consultancy = await h.as(h.DEMO.consultancy);
  const demoCase = h.db().visaCases[0];

  // "Travel Booking" cannot complete while "Visa Stamping" is still open.
  const outOfOrder = await consultancy.patch('/api/visa/stages', {
    caseId: demoCase.id,
    stageName: 'Travel Booking',
    status: 'done'
  });
  assert.equal(outOfOrder.status, 409);
  assert.equal(outOfOrder.body.error, 'VISA_STAGE_OUT_OF_ORDER');
  assert.equal(outOfOrder.body.details.blockedBy, 'Visa Stamping');

  const inOrder = await consultancy.patch('/api/visa/stages', {
    caseId: demoCase.id,
    stageName: 'Visa Stamping',
    status: 'done',
    note: 'Stamped and collected'
  });
  assert.equal(inOrder.status, 200);

  const stamping = inOrder.body.data.stages.find(s => s.name === 'Visa Stamping');
  assert.equal(stamping.status, 'done');
  assert.ok(stamping.updatedAt);
  assert.ok(stamping.updatedByName);
  assert.equal(stamping.note, 'Stamped and collected');

  // Completing a stage advances the next one to "current".
  const next = inOrder.body.data.stages.find(s => s.name === 'Travel Booking');
  assert.equal(next.status, 'current');
  assert.ok(inOrder.body.data.progress > 60);

  // And the worker sees the same update on their own view.
  const worker = await h.as(h.DEMO.worker);
  const mine = await worker.get('/api/visa/my-status');
  const seen = mine.body.data.stages.find(s => s.name === 'Visa Stamping');
  assert.equal(seen.status, 'done');
  assert.equal(seen.updatedByName, stamping.updatedByName);
});

test('an earlier milestone cannot be reopened while a later one is complete', async () => {
  const consultancy = await h.as(h.DEMO.consultancy);
  const demoCase = h.db().visaCases[0];

  // "Visa Stamping" was completed by the previous test, so pushing an earlier
  // milestone back would leave the worker with an impossible timeline.
  const res = await consultancy.patch('/api/visa/stages', {
    caseId: demoCase.id,
    stageName: 'Medical Test',
    status: 'current'
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'VISA_STAGE_LATER_COMPLETED');
  assert.equal(res.body.details.blockedBy, 'Visa Stamping');

  // Reopening from the newest completed milestone backwards is allowed.
  const reopenLast = await consultancy.patch('/api/visa/stages', {
    caseId: demoCase.id,
    stageName: 'Visa Stamping',
    status: 'current'
  });
  assert.equal(reopenLast.status, 200);

  const restore = await consultancy.patch('/api/visa/stages', {
    caseId: demoCase.id,
    stageName: 'Visa Stamping',
    status: 'done'
  });
  assert.equal(restore.status, 200);
});

test('an unknown stage name or status is rejected, and an unknown case is 404', async () => {
  const consultancy = await h.as(h.DEMO.consultancy);
  const demoCase = h.db().visaCases[0];

  const badStage = await consultancy.patch('/api/visa/stages', {
    caseId: demoCase.id, stageName: 'Interview at Embassy', status: 'done'
  });
  assert.equal(badStage.status, 400);

  const badStatus = await consultancy.patch('/api/visa/stages', {
    caseId: demoCase.id, stageName: 'Departure', status: 'finished'
  });
  assert.equal(badStatus.status, 400);

  const missingCase = await consultancy.patch('/api/visa/stages', {
    caseId: 987654, stageName: 'Departure', status: 'done'
  });
  assert.equal(missingCase.status, 404);
});

// --- documents --------------------------------------------------------------

test('document upload requires a file', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.upload('/api/documents/upload', { name: 'Passport copy', type: 'passport' }, null);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'FILE_REQUIRED');
});

test('an unsupported file type is rejected', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.upload('/api/documents/upload',
    { name: 'Script', type: 'other' },
    { buffer: Buffer.from('#!/bin/sh\necho hi\n'), filename: 'payload.sh', contentType: 'application/x-sh' });
  assert.equal(res.status, 415);
  assert.equal(res.body.error, 'UNSUPPORTED_FILE_TYPE');
});

test('an oversized file is rejected', async () => {
  const worker = await h.as(h.DEMO.worker);
  // MAX_UPLOAD_MB is 1 in the test environment.
  const res = await worker.upload('/api/documents/upload',
    { name: 'Huge scan', type: 'other' },
    { buffer: h.samplePdf(2 * 1024 * 1024), filename: 'huge.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 413);
  assert.equal(res.body.error, 'FILE_TOO_LARGE');
});

test('a valid upload is stored under the session user with a generated filename', async () => {
  const worker = await h.as(h.DEMO.worker);
  const otherId = h.findUser(h.DEMO.worker2).id;
  const res = await worker.upload('/api/documents/upload',
    { name: 'Passport scan', type: 'passport', ownerId: String(otherId) },
    { buffer: h.samplePdf(), filename: '../../etc/passwd.pdf', contentType: 'application/pdf' });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'Pending Review');

  const stored = h.db().documents.find(d => String(d.id) === String(res.body.data.id));
  // ownerId in the body is ignored for a worker: the session owns the record.
  assert.equal(String(stored.ownerId), String(h.findUser(h.DEMO.worker).id));
  // The client filename never becomes the on-disk name.
  assert.equal(stored.storedName.includes('..'), false);
  assert.equal(stored.storedName.includes('/'), false);
  assert.ok(stored.storedName.endsWith('.pdf'));
});

test('a medical upload is marked sensitive automatically', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.upload('/api/documents/upload',
    { name: 'GAMCA result', type: 'medical' },
    { buffer: h.samplePdf(), filename: 'medical.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.sensitive, true);
});

test('a worker only sees their own documents', async () => {
  const workerTwo = await h.as(h.DEMO.worker2);
  await workerTwo.upload('/api/documents/upload',
    { name: 'Worker two licence', type: 'licence' },
    { buffer: h.samplePdf(), filename: 'licence.pdf', contentType: 'application/pdf' });

  const workerOne = await h.as(h.DEMO.worker);
  const res = await workerOne.get('/api/documents');
  assert.equal(res.status, 200);
  const myId = String(h.findUser(h.DEMO.worker).id);
  assert.equal(res.body.data.every(d => d.ownerId === undefined || String(d.ownerId) === myId), true);
  assert.equal(res.body.data.some(d => d.name === 'Worker two licence'), false);
});

test('a worker cannot open another worker\'s document file', async () => {
  const workerTwo = await h.as(h.DEMO.worker2);
  const uploaded = await workerTwo.upload('/api/documents/upload',
    { name: 'Private certificate', type: 'experience' },
    { buffer: h.samplePdf(), filename: 'cert.pdf', contentType: 'application/pdf' });

  const workerOne = await h.as(h.DEMO.worker);
  const meta = await workerOne.patch(`/api/documents/${uploaded.body.data.id}`, { status: 'Verified' });
  assert.equal(meta.status, 403);

  const file = await workerOne.get(`/api/documents/${uploaded.body.data.id}/file`);
  assert.equal(file.status, 403);
  assert.equal(file.body.error, 'FORBIDDEN_RESOURCE');
});

test('a worker cannot verify their own document', async () => {
  const worker = await h.as(h.DEMO.worker);
  const uploaded = await worker.upload('/api/documents/upload',
    { name: 'Self verify attempt', type: 'experience' },
    { buffer: h.samplePdf(), filename: 'self.pdf', contentType: 'application/pdf' });

  const res = await worker.patch(`/api/documents/${uploaded.body.data.id}`, { status: 'Verified' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'CANNOT_VERIFY_OWN_DOCUMENT');
});

test('the assigned consultancy can verify a document but not a medical one', async () => {
  const worker = await h.as(h.DEMO.worker);
  const ordinary = await worker.upload('/api/documents/upload',
    { name: 'Experience letter', type: 'experience' },
    { buffer: h.samplePdf(), filename: 'exp.pdf', contentType: 'application/pdf' });
  const medical = await worker.upload('/api/documents/upload',
    { name: 'Medical fitness', type: 'medical' },
    { buffer: h.samplePdf(), filename: 'med.pdf', contentType: 'application/pdf' });

  const consultancy = await h.as(h.DEMO.consultancy);

  const verified = await consultancy.patch(`/api/documents/${ordinary.body.data.id}`, { status: 'Verified' });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.status, 'Verified');
  assert.ok(verified.body.data.verifiedByName);

  const blocked = await consultancy.patch(`/api/documents/${medical.body.data.id}`, { status: 'Verified' });
  assert.equal(blocked.status, 403);

  const file = await consultancy.get(`/api/documents/${medical.body.data.id}/file`);
  assert.equal(file.status, 403);
});

test('rejecting a document requires a reason', async () => {
  const worker = await h.as(h.DEMO.worker);
  const uploaded = await worker.upload('/api/documents/upload',
    { name: 'Blurry scan', type: 'licence' },
    { buffer: h.samplePdf(), filename: 'blurry.pdf', contentType: 'application/pdf' });

  const consultancy = await h.as(h.DEMO.consultancy);
  const noReason = await consultancy.patch(`/api/documents/${uploaded.body.data.id}`, { status: 'Rejected' });
  assert.equal(noReason.status, 400);

  const withReason = await consultancy.patch(`/api/documents/${uploaded.body.data.id}`, {
    status: 'Rejected',
    rejectionReason: 'The licence number is not readable. Please re-scan.'
  });
  assert.equal(withReason.status, 200);
  assert.equal(withReason.body.data.rejectionReason.length > 0, true);
});

test('the consultancy case view hides medical documents but reports the count', async () => {
  const consultancy = await h.as(h.DEMO.consultancy);
  const demoCase = h.db().visaCases[0];
  const res = await consultancy.get(`/api/visa/cases/${demoCase.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.documents.some(d => d.type === 'medical'), false);
  assert.ok(res.body.data.restrictedDocumentCount >= 1);
});

test('the caseload summary counts restricted documents without revealing them', async () => {
  const consultancy = await h.as(h.DEMO.consultancy);
  const res = await consultancy.get('/api/consultancy/cases');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length >= 1);
  const row = res.body.data[0];
  assert.equal(typeof row.documents.restricted, 'number');
  assert.equal(JSON.stringify(res.body).toLowerCase().includes('gamca result'), false);
});

test('a verified document cannot be deleted by its owner', async () => {
  const worker = await h.as(h.DEMO.worker);
  const uploaded = await worker.upload('/api/documents/upload',
    { name: 'To verify then keep', type: 'education' },
    { buffer: h.samplePdf(), filename: 'edu.pdf', contentType: 'application/pdf' });

  const consultancy = await h.as(h.DEMO.consultancy);
  await consultancy.patch(`/api/documents/${uploaded.body.data.id}`, { status: 'Verified' });

  const res = await worker.del(`/api/documents/${uploaded.body.data.id}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'DOCUMENT_VERIFIED_LOCKED');
});

test('an owner can delete their own pending document and the file goes with it', async () => {
  const fs = require('fs');
  const path = require('path');
  const config = require('../backend/config');

  const worker = await h.as(h.DEMO.worker);
  const uploaded = await worker.upload('/api/documents/upload',
    { name: 'Temporary scan', type: 'other' },
    { buffer: h.samplePdf(), filename: 'temp.pdf', contentType: 'application/pdf' });

  const stored = h.db().documents.find(d => String(d.id) === String(uploaded.body.data.id));
  const onDisk = path.join(config.uploadDir, stored.storedName);
  assert.equal(fs.existsSync(onDisk), true);

  const res = await worker.del(`/api/documents/${uploaded.body.data.id}`);
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(onDisk), false);
});

test('an owner can download their own document file', async () => {
  const worker = await h.as(h.DEMO.worker);
  const uploaded = await worker.upload('/api/documents/upload',
    { name: 'Downloadable', type: 'other' },
    { buffer: h.samplePdf(), filename: 'dl.pdf', contentType: 'application/pdf' });

  const res = await worker.get(`/api/documents/${uploaded.body.data.id}/file`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /pdf/);
});

test('a seeded placeholder record with no file reports that honestly', async () => {
  const worker = await h.as(h.DEMO.worker);
  const placeholder = h.db().documents.find(d => d.placeholder && String(d.ownerId) === String(h.findUser(h.DEMO.worker).id));
  assert.ok(placeholder, 'expected a seeded placeholder document');
  const res = await worker.get(`/api/documents/${placeholder.id}/file`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'DOCUMENT_FILE_MISSING');
});
