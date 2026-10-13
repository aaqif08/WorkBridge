'use strict';

const express = require('express');
const store = require('../lib/store');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const rbac = require('../lib/rbac');
const mw = require('../lib/middleware');
const { ok, fail, asyncRoute, str, int, oneOf } = require('../lib/http');

const router = express.Router();

function present(visaCase, viewer) {
  const worker = auth.findUserById(visaCase.workerId);
  const consultancy = auth.findUserById(visaCase.consultancyId);
  const base = {
    id: visaCase.id,
    applicationId: visaCase.applicationId,
    destination: visaCase.destination,
    role: visaCase.role,
    progress: visaCase.progress,
    caseOfficer: visaCase.caseOfficer,
    consultancy: consultancy ? consultancy.name : null,
    consultancyId: visaCase.consultancyId,
    estimatedCompletion: visaCase.estimatedCompletion,
    createdAt: visaCase.createdAt,
    updatedAt: visaCase.updatedAt,
    stages: visaCase.stages.map(s => ({
      name: s.name,
      status: s.status,
      updatedAt: s.updatedAt,
      updatedByName: s.updatedByName,
      note: s.note || ''
    }))
  };
  if (viewer && viewer.role !== 'Worker') {
    base.worker = worker ? { id: worker.id, name: worker.name, trade: worker.profile && worker.profile.trade } : null;
  }
  return base;
}

function recalcProgress(stages) {
  const done = stages.filter(s => s.status === 'done').length;
  return Math.round((done / stages.length) * 100);
}

/** The signed-in worker's own case. Never takes an id from the client. */
router.get('/my-status', mw.requireAuth, asyncRoute(async (req, res) => {
  const viewer = req.auth.user;
  if (viewer.role !== 'Worker') {
    return fail(res, 403, 'FORBIDDEN_ROLE', 'Only worker accounts have a personal visa status');
  }
  const myCase = store.read().visaCases.find(v => String(v.workerId) === String(viewer.id));
  if (!myCase) {
    return ok(res, { data: null, message: 'No visa case has been opened for your account yet' });
  }
  return ok(res, { data: present(myCase, viewer) });
}));

/** Cases the caller is entitled to see (consultancy caseload, admin, worker). */
router.get('/cases', mw.requireAuth, asyncRoute(async (req, res) => {
  const viewer = req.auth.user;
  const rows = rbac.visibleVisaCases(viewer)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(v => present(v, viewer));
  return ok(res, { count: rows.length, data: rows });
}));

router.get('/cases/:id', mw.requireAuth, asyncRoute(async (req, res) => {
  const visaCase = rbac.visaCaseById(req.params.id);
  if (!visaCase) return fail(res, 404, 'VISA_CASE_NOT_FOUND', 'Visa case not found');
  if (!rbac.canViewVisaCase(req.auth.user, visaCase)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You cannot view this visa case');
  }

  const payload = present(visaCase, req.auth.user);

  // Documents attached to the case, filtered per-document by visibility, so a
  // consultancy sees paperwork but not the candidate's medical records.
  const docs = store.read().documents
    .filter(d => String(d.ownerId) === String(visaCase.workerId))
    .filter(d => rbac.canViewDocument(req.auth.user, d))
    .map(d => ({ id: d.id, name: d.name, type: d.type, status: d.status, updatedAt: d.updatedAt }));
  payload.documents = docs;
  payload.restrictedDocumentCount = store.read().documents
    .filter(d => String(d.ownerId) === String(visaCase.workerId))
    .filter(d => !rbac.canViewDocument(req.auth.user, d)).length;

  return ok(res, { data: payload });
}));

/**
 * Opens a case from an application that has reached "Offer Issued".
 * A consultancy opening a case becomes the assigned consultancy and gains
 * access to that candidate; an administrator must name the consultancy.
 */
router.post('/cases', mw.requireAuth, mw.requireRole('Consultancy', 'Admin'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const applicationId = int(body.applicationId, { field: 'applicationId', required: true, min: 1 });
  const application = rbac.applicationById(applicationId);
  if (!application) return fail(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');

  // Checked before the stage gate: once a case exists the application has
  // already moved to "Visa Processing", and "already open" is the useful answer.
  const duplicate = store.read().visaCases.find(v => String(v.applicationId) === String(applicationId));
  if (duplicate) return fail(res, 409, 'VISA_CASE_EXISTS', 'A visa case already exists for this application');

  if (application.status !== 'Offer Issued') {
    return fail(res, 409, 'APPLICATION_NOT_READY', 'A visa case can only be opened once an offer has been issued', {
      currentStage: application.status
    });
  }

  let consultancyId = req.auth.user.id;
  if (rbac.isAdmin(req.auth.user)) {
    consultancyId = int(body.consultancyId, { field: 'consultancyId', required: true, min: 1 });
    const target = auth.findUserById(consultancyId);
    if (!target || target.role !== 'Consultancy') {
      return fail(res, 400, 'CONSULTANCY_NOT_FOUND', 'consultancyId does not refer to a consultancy account');
    }
  }

  const job = rbac.jobById(application.jobId);
  const caseOfficer = str(body.caseOfficer, { field: 'caseOfficer', max: 120 }) || req.auth.user.name;
  const now = new Date().toISOString();

  const created = await store.mutate(db => {
    const stages = rbac.VISA_STAGES.map((name, index) => ({
      name,
      status: index === 0 ? 'done' : index === 1 ? 'current' : 'pending',
      updatedAt: index <= 1 ? now : null,
      updatedById: index <= 1 ? req.auth.user.id : null,
      updatedByName: index <= 1 ? req.auth.user.name : null,
      note: ''
    }));
    const row = {
      id: store.nextId('visaCases'),
      workerId: application.workerId,
      applicationId: application.id,
      employerId: application.employerId,
      consultancyId,
      destination: job ? job.country : '',
      role: application.jobTitle,
      caseOfficer,
      stages,
      progress: recalcProgress(stages),
      estimatedCompletion: null,
      createdAt: now,
      updatedAt: now
    };
    db.visaCases.push(row);

    db.consultancyAssignments.push({
      id: store.nextId('consultancyAssignments'),
      consultancyId,
      workerId: application.workerId,
      employerId: application.employerId,
      applicationId: application.id,
      status: 'active',
      createdAt: now
    });

    const app = db.applications.find(a => String(a.id) === String(application.id));
    app.status = 'Visa Processing';
    app.updatedAt = now;
    app.history.push({ stage: 'Visa Processing', at: now, byId: req.auth.user.id, byName: req.auth.user.name });

    return row;
  });

  await audit.record(req.auth.user, 'VISA_CASE_OPENED', {
    targetType: 'visaCase', targetId: created.id,
    summary: `Case opened for application ${application.id}`,
    metadata: { consultancyId }, ip: req.ip
  });

  return ok(res, { data: present(created, req.auth.user) }, 201);
}));

/**
 * Milestone update. Kept at the documented path/method.
 * `caseId` is validated against the caller's authorisation - passing another
 * consultancy's case id returns 403, not a silent write.
 */
router.patch('/stages', mw.requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const caseId = int(body.caseId, { field: 'caseId', required: true, min: 1 });
  const stageName = oneOf(body.stageName, rbac.VISA_STAGES, { field: 'stageName', required: true });
  const status = oneOf(body.status, rbac.VISA_STATUSES, { field: 'status', required: true });
  const note = str(body.note, { field: 'note', max: 500 });

  const visaCase = rbac.visaCaseById(caseId);
  if (!visaCase) return fail(res, 404, 'VISA_CASE_NOT_FOUND', 'Visa case not found');
  if (!rbac.canUpdateVisaCase(req.auth.user, visaCase)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'Only the assigned consultancy or an administrator can update this case');
  }

  const index = visaCase.stages.findIndex(s => s.name === stageName);
  if (index === -1) return fail(res, 400, 'VISA_STAGE_UNKNOWN', 'Unknown visa stage');

  // Milestones are sequential in both directions.
  // Forwards: a stage cannot be completed while an earlier one is outstanding.
  if (status === 'done' || status === 'current') {
    const blocking = visaCase.stages.slice(0, index).find(s => s.status !== 'done');
    if (blocking) {
      return fail(res, 409, 'VISA_STAGE_OUT_OF_ORDER',
        `"${blocking.name}" must be completed first`, { blockedBy: blocking.name });
    }
  }
  // Backwards: reopening a stage while a later one is already complete would
  // leave the worker looking at a timeline that cannot be true. The later
  // stages have to be reopened first, newest back.
  if (status !== 'done') {
    const laterDone = visaCase.stages.slice(index + 1).filter(s => s.status === 'done');
    if (laterDone.length) {
      const next = laterDone[laterDone.length - 1];
      return fail(res, 409, 'VISA_STAGE_LATER_COMPLETED',
        `"${next.name}" is already completed; reopen the later milestones first`,
        { blockedBy: next.name });
    }
  }

  const now = new Date().toISOString();
  const updated = await store.mutate(db => {
    const row = db.visaCases.find(v => String(v.id) === String(caseId));
    const stage = row.stages[index];
    stage.status = status;
    stage.updatedAt = now;
    stage.updatedById = req.auth.user.id;
    stage.updatedByName = req.auth.user.name;
    stage.note = note;
    // Keep exactly one "current" marker ahead of the completed stages.
    if (status === 'done') {
      const next = row.stages[index + 1];
      if (next && next.status === 'pending') next.status = 'current';
    }
    row.progress = recalcProgress(row.stages);
    row.updatedAt = now;
    if (body.estimatedCompletion !== undefined) {
      const raw = str(body.estimatedCompletion, { field: 'estimatedCompletion', max: 40 });
      row.estimatedCompletion = raw || null;
    }
    return row;
  });

  await audit.record(req.auth.user, 'VISA_STAGE_UPDATED', {
    targetType: 'visaCase', targetId: caseId,
    summary: `${stageName} -> ${status}`,
    metadata: { stageName, status, note }, ip: req.ip
  });

  return ok(res, { data: present(updated, req.auth.user) });
}));

module.exports = router;
