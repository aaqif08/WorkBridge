'use strict';

const express = require('express');
const store = require('../lib/store');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const rbac = require('../lib/rbac');
const fraud = require('../lib/fraud');
const mw = require('../lib/middleware');
const { ok, fail, asyncRoute, str, int, oneOf } = require('../lib/http');

const router = express.Router();

// Every route in this file is administrator-only, enforced server side.
router.use(mw.requireAuth, mw.requireRole('Admin'));

router.get('/stats', asyncRoute(async (req, res) => {
  const db = store.read();
  const jobs = db.jobs;
  const applications = db.applications;

  const byStatus = {};
  for (const job of jobs) byStatus[job.status] = (byStatus[job.status] || 0) + 1;

  const byStage = {};
  for (const application of applications) byStage[application.status] = (byStage[application.status] || 0) + 1;

  const usersByRole = {};
  for (const user of db.users) usersByRole[user.role] = (usersByRole[user.role] || 0) + 1;

  // Wage metrics are derived from listing text, so they are indicative and
  // labelled as such rather than presented as audited payroll figures.
  const salaries = jobs
    .filter(j => j.status === 'published')
    .map(j => ({ country: j.country, parsed: fraud.parseSalary(j.salary) }))
    .filter(row => row.parsed.amount);
  const wageByCountry = {};
  for (const row of salaries) {
    const key = `${row.country} (${row.parsed.currency || 'local'})`;
    wageByCountry[key] = wageByCountry[key] || { count: 0, sum: 0 };
    wageByCountry[key].count += 1;
    wageByCountry[key].sum += row.parsed.amount;
  }
  const indicativeAverageMonthlyWage = Object.fromEntries(
    Object.entries(wageByCountry).map(([k, v]) => [k, Math.round(v.sum / v.count)])
  );

  return ok(res, {
    data: {
      users: { total: db.users.length, byRole: usersByRole, suspended: db.users.filter(u => u.status !== 'active').length },
      jobs: { total: jobs.length, byStatus, flagged: jobs.filter(j => j.reviewState === 'flagged').length },
      applications: { total: applications.length, byStage },
      placements: applications.filter(a => a.status === 'Placed').length,
      visaCases: { total: db.visaCases.length, inProgress: db.visaCases.filter(v => v.progress < 100).length },
      documents: { total: db.documents.length, verified: db.documents.filter(d => d.status === 'Verified').length },
      wages: {
        indicativeAverageMonthlyWage,
        note: 'Derived from employer-entered listing text. Indicative only, not audited payroll data.'
      },
      generatedAt: new Date().toISOString()
    }
  });
}));

/** Listings that need a human decision, newest first, with full reasoning. */
router.get('/fraud-queue', asyncRoute(async (req, res) => {
  const rows = store.read().jobs
    .filter(j => j.reviewState === 'flagged' || j.status === 'under_review' || (j.reports || []).length > 0)
    .sort((a, b) => (b.risk ? b.risk.score : 0) - (a.risk ? a.risk.score : 0))
    .map(job => {
      const employer = auth.findUserById(job.employerId);
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        location: job.location,
        salary: job.salary,
        status: job.status,
        reviewState: job.reviewState,
        riskScore: job.risk ? job.risk.score : null,
        riskBand: job.risk ? job.risk.band : null,
        // The reasons are what makes the score reviewable rather than oracular.
        factors: job.risk ? job.risk.factors : [],
        salaryBandUsed: job.risk ? job.risk.salaryBandUsed : null,
        reports: job.reports || [],
        employer: employer
          ? {
            id: employer.id,
            name: employer.name,
            email: employer.email,
            verificationStatus: (employer.profile && employer.profile.verificationStatus) || 'unverified',
            createdAt: employer.createdAt
          }
          : null,
        createdAt: job.createdAt
      };
    });

  return ok(res, { count: rows.length, data: rows });
}));

/**
 * Administrative decision on a flagged listing.
 * `clear` publishes it, `suspend` hides it, `remove` deletes it. Every action
 * requires a reason and is written to the audit log.
 */
router.post('/fraud-action', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const id = int(body.id, { field: 'id', required: true, min: 1 });
  const action = oneOf(body.action, ['clear', 'suspend', 'remove'], { field: 'action', required: true });
  const reason = str(body.reason, { field: 'reason', required: true, min: 5, max: 500 });

  const job = rbac.jobById(id);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');

  const now = new Date().toISOString();
  await store.mutate(db => {
    if (action === 'remove') {
      db.jobs = db.jobs.filter(j => String(j.id) !== String(id));
      return;
    }
    const row = db.jobs.find(j => String(j.id) === String(id));
    row.status = action === 'clear' ? 'published' : 'suspended';
    row.reviewState = action === 'clear' ? 'cleared' : 'suspended';
    row.reviewedBy = req.auth.user.id;
    row.reviewedByName = req.auth.user.name;
    row.reviewedAt = now;
    row.reviewReason = reason;
    row.updatedAt = now;
  });

  const entry = await audit.record(req.auth.user, `LISTING_${action.toUpperCase()}`, {
    targetType: 'job',
    targetId: id,
    summary: reason,
    metadata: { action, previousStatus: job.status, riskScore: job.risk ? job.risk.score : null },
    ip: req.ip
  });

  return ok(res, {
    message: `Listing ${id}: ${action}`,
    auditId: entry.id,
    note: 'A risk score is an indicator for review. This action records a human decision, not a finding of fraud.'
  });
}));

/** Re-run the heuristics against the stored listing content. */
router.post('/jobs/:id/reassess', asyncRoute(async (req, res) => {
  const job = rbac.jobById(req.params.id);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');
  const employer = auth.findUserById(job.employerId);
  const assessment = fraud.assess(job, { employer });

  await store.mutate(db => {
    const row = db.jobs.find(j => String(j.id) === String(job.id));
    row.risk = assessment;
    row.updatedAt = new Date().toISOString();
  });

  await audit.record(req.auth.user, 'LISTING_REASSESSED', {
    targetType: 'job', targetId: job.id,
    summary: `Risk recomputed: ${assessment.score} (${assessment.band})`, ip: req.ip
  });

  return ok(res, { data: assessment });
}));

router.get('/users', asyncRoute(async (req, res) => {
  const role = str(req.query.role, { field: 'role', max: 20 });
  const search = str(req.query.search, { field: 'search', max: 120 }).toLowerCase();
  let rows = store.read().users.slice();
  if (role) rows = rows.filter(u => u.role === role);
  if (search) {
    rows = rows.filter(u =>
      `${u.name} ${u.email} ${u.phone}`.toLowerCase().includes(search));
  }
  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return ok(res, { count: rows.length, data: rows.map(auth.publicUser) });
}));

/** Suspend or reactivate an account. */
router.patch('/users/:id/status', asyncRoute(async (req, res) => {
  const target = auth.findUserById(req.params.id);
  if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
  const status = oneOf((req.body || {}).status, ['active', 'suspended'], { field: 'status', required: true });
  const reason = str((req.body || {}).reason, { field: 'reason', required: true, min: 5, max: 400 });

  if (String(target.id) === String(req.auth.user.id)) {
    return fail(res, 409, 'CANNOT_MODIFY_SELF', 'You cannot change your own account status');
  }
  if (target.role === 'Admin' && status === 'suspended') {
    const activeAdmins = store.read().users.filter(u => u.role === 'Admin' && u.status === 'active').length;
    if (activeAdmins <= 1) {
      return fail(res, 409, 'LAST_ADMIN', 'Cannot suspend the last active administrator');
    }
  }

  await store.mutate(db => {
    const row = db.users.find(u => String(u.id) === String(target.id));
    row.status = status;
    row.statusReason = reason;
    row.updatedAt = new Date().toISOString();
  });
  if (status === 'suspended') await auth.revokeAllSessionsForUser(target.id);

  await audit.record(req.auth.user, status === 'suspended' ? 'USER_SUSPENDED' : 'USER_REACTIVATED', {
    targetType: 'user', targetId: target.id, summary: reason, ip: req.ip
  });

  return ok(res, { data: auth.publicUser(auth.findUserById(target.id)) });
}));

/**
 * Employer/consultancy verification status.
 * Only an administrator can set this, and the evidence reference is required -
 * the platform does not mark an organisation verified on its own say-so.
 */
router.patch('/users/:id/verification', asyncRoute(async (req, res) => {
  const target = auth.findUserById(req.params.id);
  if (!target) return fail(res, 404, 'USER_NOT_FOUND', 'User not found');
  if (!['Employer', 'Consultancy'].includes(target.role)) {
    return fail(res, 400, 'VERIFICATION_NOT_APPLICABLE', 'Only employer and consultancy accounts carry a verification status');
  }
  const body = req.body || {};
  const status = oneOf(body.verificationStatus, ['unverified', 'in_review', 'verified', 'rejected'], {
    field: 'verificationStatus', required: true
  });
  const evidence = str(body.evidenceReference, {
    field: 'evidenceReference', required: status === 'verified', max: 300
  });

  await store.mutate(db => {
    const row = db.users.find(u => String(u.id) === String(target.id));
    row.profile = row.profile || {};
    row.profile.verificationStatus = status;
    row.profile.verificationEvidence = evidence || '';
    row.profile.verifiedByName = status === 'verified' ? req.auth.user.name : null;
    row.profile.verifiedAt = status === 'verified' ? new Date().toISOString() : null;
    row.updatedAt = new Date().toISOString();
  });

  await audit.record(req.auth.user, 'ACCOUNT_VERIFICATION_CHANGED', {
    targetType: 'user', targetId: target.id,
    summary: `${target.name}: ${status}`,
    metadata: { status, evidenceReference: evidence }, ip: req.ip
  });

  return ok(res, { data: auth.publicUser(auth.findUserById(target.id)) });
}));

/** Create another administrator. Admin accounts exist only via this path. */
router.post('/users/admin', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const name = str(body.name, { field: 'name', required: true, min: 2, max: 120 });
  const { email: emailField } = require('../lib/http');
  const email = emailField(body.email, { field: 'email', required: true });
  const password = String(body.password || '');
  const problem = auth.passwordProblem(password);
  if (problem) return fail(res, 400, problem, 'Password does not meet the minimum requirements');
  if (auth.findUserByIdentifier(email)) {
    return fail(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists');
  }

  const passwordHash = await auth.hashPassword(password);
  const now = new Date().toISOString();
  const created = await store.mutate(db => {
    const row = {
      id: store.nextId('users'),
      name, email, phone: '',
      passwordHash,
      role: 'Admin',
      status: 'active',
      language: 'en',
      profile: { provisionedBy: req.auth.user.name },
      createdAt: now,
      updatedAt: now
    };
    db.users.push(row);
    return row;
  });

  await audit.record(req.auth.user, 'ADMIN_CREATED', {
    targetType: 'user', targetId: created.id, summary: `Administrator ${email} created`, ip: req.ip
  });

  return ok(res, { data: auth.publicUser(created) }, 201);
}));

router.get('/audit-log', asyncRoute(async (req, res) => {
  const limit = int(req.query.limit, { field: 'limit', min: 1, max: 500, fallback: 100 });
  const action = str(req.query.action, { field: 'action', max: 60 });
  return ok(res, { data: audit.list({ limit, action }) });
}));

router.get('/jobs', asyncRoute(async (req, res) => {
  const status = str(req.query.status, { field: 'status', max: 30 });
  let rows = store.read().jobs.slice();
  if (status) rows = rows.filter(j => j.status === status);
  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return ok(res, {
    count: rows.length,
    data: rows.map(j => ({
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      salary: j.salary,
      status: j.status,
      reviewState: j.reviewState,
      riskScore: j.risk ? j.risk.score : null,
      employerId: j.employerId,
      applicants: store.read().applications.filter(a => String(a.jobId) === String(j.id)).length,
      createdAt: j.createdAt
    }))
  });
}));

module.exports = router;
