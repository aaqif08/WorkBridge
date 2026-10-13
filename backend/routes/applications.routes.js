'use strict';

const express = require('express');
const store = require('../lib/store');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const rbac = require('../lib/rbac');
const matching = require('../lib/matching');
const mw = require('../lib/middleware');
const { ok, fail, asyncRoute, str, int, oneOf } = require('../lib/http');

const router = express.Router();

// Allowed stage moves. Anything not listed here is rejected as an invalid
// workflow transition rather than silently written.
const TRANSITIONS = {
  Applied: ['Shortlisted', 'Rejected', 'Withdrawn'],
  Shortlisted: ['Interview Scheduled', 'Offer Issued', 'Rejected', 'Withdrawn'],
  'Interview Scheduled': ['Offer Issued', 'Rejected', 'Withdrawn'],
  'Offer Issued': ['Visa Processing', 'Rejected', 'Withdrawn'],
  'Visa Processing': ['Placed', 'Rejected', 'Withdrawn'],
  Placed: [],
  Rejected: [],
  Withdrawn: []
};

function present(application, viewer) {
  const job = rbac.jobById(application.jobId);
  const base = {
    id: application.id,
    jobId: application.jobId,
    jobTitle: application.jobTitle,
    company: application.company,
    location: application.location,
    status: application.status,
    appliedAt: application.createdAt,
    updatedAt: application.updatedAt,
    history: application.history || [],
    interview: application.interview || null
  };

  if (viewer && (viewer.role === 'Employer' || rbac.isAdmin(viewer) || viewer.role === 'Consultancy')) {
    const worker = auth.findUserById(application.workerId);
    base.candidate = worker
      ? {
        id: worker.id,
        name: worker.name,
        trade: worker.profile && worker.profile.trade,
        experienceYears: worker.profile && worker.profile.experienceYears,
        skills: (worker.profile && worker.profile.skills) || []
      }
      : null;
    if (worker && job) {
      const match = matching.score(worker, job);
      base.matchScore = match.score;
      base.matchReasons = match.reasons;
    }
  }

  if (viewer && viewer.role === 'Worker' && job) {
    const match = matching.score(viewer, job);
    base.matchScore = match.score;
    base.matchReasons = match.reasons;
  }

  return base;
}

router.get('/', mw.requireAuth, asyncRoute(async (req, res) => {
  const viewer = req.auth.user;
  const status = str(req.query.status, { field: 'status', max: 40 });
  const jobId = str(req.query.jobId, { field: 'jobId', max: 20 });
  const page = int(req.query.page, { field: 'page', min: 1, max: 10000, fallback: 1 });
  const pageSize = int(req.query.pageSize, { field: 'pageSize', min: 1, max: 100, fallback: 50 });

  let rows = rbac.visibleApplications(viewer);
  if (status) rows = rows.filter(a => String(a.status).toLowerCase() === status.toLowerCase());
  if (jobId) rows = rows.filter(a => String(a.jobId) === String(jobId));
  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const data = rows.slice(start, start + pageSize).map(a => present(a, viewer));

  return ok(res, { count: data.length, total, page, pageSize, data });
}));

router.get('/:id', mw.requireAuth, asyncRoute(async (req, res) => {
  const application = rbac.applicationById(req.params.id);
  if (!application) return fail(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
  if (!rbac.canViewApplication(req.auth.user, application)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You cannot view this application');
  }
  return ok(res, { data: present(application, req.auth.user) });
}));

router.post('/', mw.requireAuth, mw.requireRole('Worker'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const jobId = int(body.jobId, { field: 'jobId', required: true, min: 1 });
  const note = str(body.note, { field: 'note', max: 1000 });

  const job = rbac.jobById(jobId);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');
  if (job.status !== 'published') {
    return fail(res, 409, 'JOB_NOT_OPEN', 'This listing is not open for applications');
  }

  const duplicate = store.read().applications.find(
    a => String(a.jobId) === String(jobId) && String(a.workerId) === String(req.auth.user.id)
  );
  if (duplicate) {
    return fail(res, 409, 'ALREADY_APPLIED', 'You have already applied to this listing', { applicationId: duplicate.id });
  }

  const now = new Date().toISOString();
  const application = await store.mutate(db => {
    const row = {
      id: store.nextId('applications'),
      jobId: job.id,
      jobTitle: job.title,
      company: job.company,
      location: job.location,
      // The worker is taken from the session, never from the request body, so
      // nobody can file an application in another worker's name.
      workerId: req.auth.user.id,
      employerId: job.employerId,
      status: 'Applied',
      note,
      interview: null,
      createdAt: now,
      updatedAt: now,
      history: [{ stage: 'Applied', at: now, byId: req.auth.user.id, byName: req.auth.user.name }]
    };
    db.applications.push(row);
    return row;
  });

  await audit.record(req.auth.user, 'APPLICATION_CREATED', {
    targetType: 'application', targetId: application.id,
    summary: `Applied to ${job.title} (job ${job.id})`, ip: req.ip
  });

  return ok(res, { data: present(application, req.auth.user) }, 201);
}));

router.patch('/:id', mw.requireAuth, asyncRoute(async (req, res) => {
  const application = rbac.applicationById(req.params.id);
  if (!application) return fail(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
  if (!rbac.canViewApplication(req.auth.user, application)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You cannot modify this application');
  }

  const body = req.body || {};
  const status = oneOf(body.status, rbac.APPLICATION_STAGES, { field: 'status', required: true });
  const note = str(body.note, { field: 'note', max: 500 });

  if (!rbac.canSetApplicationStage(req.auth.user, application, status)) {
    return fail(res, 403, 'FORBIDDEN_STAGE', 'Your role cannot move an application to this stage', {
      stage: status,
      allowedRoles: rbac.STAGE_PERMISSIONS[status] || []
    });
  }

  const allowedNext = TRANSITIONS[application.status] || [];
  if (application.status === status) {
    return fail(res, 409, 'STAGE_UNCHANGED', 'The application is already at this stage');
  }
  if (!allowedNext.includes(status)) {
    return fail(res, 409, 'STAGE_TRANSITION_INVALID',
      `Cannot move from ${application.status} to ${status}`,
      { from: application.status, allowed: allowedNext });
  }

  const now = new Date().toISOString();
  const updated = await store.mutate(db => {
    const row = db.applications.find(a => String(a.id) === String(application.id));
    row.status = status;
    row.updatedAt = now;
    row.history = row.history || [];
    row.history.push({ stage: status, at: now, byId: req.auth.user.id, byName: req.auth.user.name, note });
    return row;
  });

  await audit.record(req.auth.user, 'APPLICATION_STAGE_CHANGED', {
    targetType: 'application', targetId: application.id,
    summary: `${application.status} -> ${status}`,
    metadata: { from: application.status, to: status }, ip: req.ip
  });

  return ok(res, { data: present(updated, req.auth.user) });
}));

/** Interview scheduling by the owning employer. */
router.post('/:id/interview', mw.requireAuth, mw.requireRole('Employer', 'Admin'), asyncRoute(async (req, res) => {
  const application = rbac.applicationById(req.params.id);
  if (!application) return fail(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
  if (!rbac.isAdmin(req.auth.user) && String(application.employerId) !== String(req.auth.user.id)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You can only schedule interviews for your own listings');
  }

  const body = req.body || {};
  const scheduledAt = str(body.scheduledAt, { field: 'scheduledAt', required: true, max: 40 });
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) {
    return fail(res, 400, 'FIELD_VALUE_INVALID', 'scheduledAt must be an ISO date-time');
  }
  if (when.getTime() < Date.now() - 60 * 1000) {
    return fail(res, 400, 'INTERVIEW_IN_PAST', 'Interview time must be in the future');
  }
  const mode = oneOf(body.mode, ['Phone', 'Video', 'In person'], { field: 'mode', fallback: 'Video' });
  const notes = str(body.notes, { field: 'notes', max: 500 });

  const now = new Date().toISOString();
  const updated = await store.mutate(db => {
    const row = db.applications.find(a => String(a.id) === String(application.id));
    row.interview = { scheduledAt: when.toISOString(), mode, notes, byId: req.auth.user.id, byName: req.auth.user.name };
    if (row.status === 'Shortlisted') {
      row.status = 'Interview Scheduled';
      row.history.push({ stage: 'Interview Scheduled', at: now, byId: req.auth.user.id, byName: req.auth.user.name });
    }
    row.updatedAt = now;
    return row;
  });

  await audit.record(req.auth.user, 'INTERVIEW_SCHEDULED', {
    targetType: 'application', targetId: application.id,
    summary: `${mode} interview at ${when.toISOString()}`, ip: req.ip
  });

  return ok(res, { data: present(updated, req.auth.user) }, 201);
}));

module.exports = router;
module.exports.TRANSITIONS = TRANSITIONS;
