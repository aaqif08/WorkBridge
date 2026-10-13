'use strict';

const express = require('express');
const store = require('../lib/store');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const rbac = require('../lib/rbac');
const mw = require('../lib/middleware');
const jobsRoutes = require('./jobs.routes');
const documentsRoutes = require('./documents.routes');
const { ok, fail, asyncRoute, str, int } = require('../lib/http');

const router = express.Router();

/** Indicative wage reference table. Public: it contains no personal data. */
router.get('/salary-guide', asyncRoute(async (req, res) => {
  const role = str(req.query.role, { field: 'role', max: 60 }).toLowerCase();
  let rows = store.read().salaryGuide.slice();
  if (role) rows = rows.filter(r => String(r.role).toLowerCase().includes(role));
  return ok(res, {
    count: rows.length,
    data: rows,
    note: 'Indicative monthly ranges for comparison only. The employment contract is the binding figure.'
  });
}));

/** Messages addressed to, or sent by, the signed-in user. */
router.get('/messages', mw.requireAuth, asyncRoute(async (req, res) => {
  const me = String(req.auth.user.id);
  const rows = store.read().messages
    .filter(m => String(m.toId) === me || String(m.fromId) === me)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(m => ({
      id: m.id,
      fromId: m.fromId,
      fromName: m.fromName,
      toId: m.toId,
      subject: m.subject,
      body: m.body,
      direction: String(m.toId) === me ? 'in' : 'out',
      unread: String(m.toId) === me && !m.readAt,
      createdAt: m.createdAt
    }));
  return ok(res, { count: rows.length, data: rows });
}));

router.post('/messages', mw.requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const toId = int(body.toId, { field: 'toId', required: true, min: 1 });
  const subject = str(body.subject, { field: 'subject', required: true, min: 2, max: 140 });
  const text = str(body.body, { field: 'body', required: true, min: 1, max: 2000 });

  const recipient = auth.findUserById(toId);
  if (!recipient) return fail(res, 404, 'USER_NOT_FOUND', 'Recipient not found');

  // Messaging is restricted to people who already share a case or application,
  // so the endpoint cannot be used to message arbitrary accounts.
  const me = req.auth.user;
  const related = rbac.isAdmin(me) || recipient.role === 'Admin' ||
    store.read().applications.some(a =>
      (String(a.workerId) === String(me.id) && String(a.employerId) === String(recipient.id)) ||
      (String(a.employerId) === String(me.id) && String(a.workerId) === String(recipient.id))) ||
    store.read().visaCases.some(v =>
      (String(v.workerId) === String(me.id) && String(v.consultancyId) === String(recipient.id)) ||
      (String(v.consultancyId) === String(me.id) && String(v.workerId) === String(recipient.id)));

  if (!related) {
    return fail(res, 403, 'MESSAGING_NOT_PERMITTED',
      'You can only message accounts connected to one of your applications or cases');
  }

  const now = new Date().toISOString();
  const message = await store.mutate(db => {
    const row = {
      id: store.nextId('messages'),
      fromId: me.id,
      fromName: me.name,
      toId: recipient.id,
      subject,
      body: text,
      readAt: null,
      createdAt: now
    };
    db.messages.push(row);
    return row;
  });

  return ok(res, { data: message }, 201);
}));

router.patch('/messages/:id/read', mw.requireAuth, asyncRoute(async (req, res) => {
  const id = req.params.id;
  const row = store.read().messages.find(m => String(m.id) === String(id));
  if (!row) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
  if (String(row.toId) !== String(req.auth.user.id)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You can only mark your own messages as read');
  }
  await store.mutate(db => {
    const target = db.messages.find(m => String(m.id) === String(id));
    target.readAt = new Date().toISOString();
  });
  return ok(res, { message: 'Marked as read' });
}));

/** Notifications derived from the caller's own records - no invented items. */
router.get('/notifications', mw.requireAuth, asyncRoute(async (req, res) => {
  const me = req.auth.user;
  const db = store.read();
  const items = [];

  for (const application of rbac.visibleApplications(me).slice(0, 25)) {
    const last = (application.history || [])[application.history.length - 1];
    if (!last) continue;
    items.push({
      type: 'application',
      refId: application.id,
      titleKey: 'notifications.applicationStage',
      params: { job: application.jobTitle, stage: last.stage },
      at: last.at
    });
  }

  for (const visaCase of rbac.visibleVisaCases(me)) {
    for (const stage of visaCase.stages.filter(s => s.updatedAt)) {
      items.push({
        type: 'visa',
        refId: visaCase.id,
        titleKey: 'notifications.visaStage',
        params: { stage: stage.name, status: stage.status, by: stage.updatedByName || '' },
        at: stage.updatedAt
      });
    }
  }

  for (const doc of rbac.visibleDocuments(me).filter(d => d.verifiedAt)) {
    items.push({
      type: 'document',
      refId: doc.id,
      titleKey: 'notifications.documentReviewed',
      params: { name: doc.name, status: doc.status },
      at: doc.verifiedAt
    });
  }

  const unreadMessages = db.messages.filter(m => String(m.toId) === String(me.id) && !m.readAt);
  for (const message of unreadMessages) {
    items.push({
      type: 'message',
      refId: message.id,
      titleKey: 'notifications.newMessage',
      params: { from: message.fromName, subject: message.subject },
      at: message.createdAt
    });
  }

  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  return ok(res, { count: items.length, data: items.slice(0, 50) });
}));

/** Consultancy caseload overview. */
router.get('/consultancy/cases', mw.requireAuth, mw.requireRole('Consultancy', 'Admin'), asyncRoute(async (req, res) => {
  const me = req.auth.user;
  const db = store.read();
  const cases = rbac.visibleVisaCases(me);

  const rows = cases.map(visaCase => {
    const worker = auth.findUserById(visaCase.workerId);
    const allDocs = db.documents.filter(d => String(d.ownerId) === String(visaCase.workerId));
    const visibleDocs = allDocs.filter(d => rbac.canViewDocument(me, d));
    const currentStage = visaCase.stages.find(s => s.status === 'current');
    return {
      caseId: visaCase.id,
      worker: worker ? { id: worker.id, name: worker.name, trade: worker.profile && worker.profile.trade } : null,
      destination: visaCase.destination,
      role: visaCase.role,
      progress: visaCase.progress,
      currentStage: currentStage ? currentStage.name : 'Completed',
      documents: {
        visible: visibleDocs.length,
        verified: visibleDocs.filter(d => d.status === 'Verified').length,
        pending: visibleDocs.filter(d => d.status === 'Pending Review').length,
        // Count only - medical files stay with the worker and administrators.
        restricted: allDocs.length - visibleDocs.length
      },
      updatedAt: visaCase.updatedAt
    };
  });

  return ok(res, { count: rows.length, data: rows });
}));

/** Static reference data the frontend needs to build forms. */
router.get('/meta', (req, res) => {
  return ok(res, {
    data: {
      jobCategories: jobsRoutes.CATEGORIES,
      countries: jobsRoutes.COUNTRIES,
      documentTypes: documentsRoutes.DOC_TYPES,
      applicationStages: rbac.APPLICATION_STAGES,
      stagePermissions: rbac.STAGE_PERMISSIONS,
      visaStages: rbac.VISA_STAGES,
      languages: ['en', 'ta'],
      signupRoles: auth.PUBLIC_SIGNUP_ROLES
    }
  });
});

/** A worker's own audit trail: who touched their records and when. */
router.get('/my-activity', mw.requireAuth, asyncRoute(async (req, res) => {
  const rows = audit.list({ limit: 100 }).filter(entry =>
    String(entry.actorId) === String(req.auth.user.id) ||
    (entry.targetType === 'user' && String(entry.targetId) === String(req.auth.user.id)));
  return ok(res, { count: rows.length, data: rows });
}));

module.exports = router;
