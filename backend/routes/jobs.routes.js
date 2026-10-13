'use strict';

const express = require('express');
const store = require('../lib/store');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const rbac = require('../lib/rbac');
const fraud = require('../lib/fraud');
const matching = require('../lib/matching');
const mw = require('../lib/middleware');
const { ok, fail, asyncRoute, str, int, strArray, oneOf } = require('../lib/http');

const router = express.Router();

const CATEGORIES = ['Driver', 'Electrician', 'Welder', 'Plumber', 'Chef', 'Mechanic', 'Painter', 'Construction', 'Other'];
const COUNTRIES = ['UAE', 'Qatar', 'Saudi Arabia', 'Kuwait', 'Oman', 'Bahrain', 'India'];
const JOB_STATUSES = ['draft', 'published', 'under_review', 'suspended', 'closed'];

function employerFor(job) {
  return auth.findUserById(job.employerId);
}

/**
 * Shapes a job for the caller. Risk factors and review state are only included
 * for people entitled to see them (the owning employer, or an administrator).
 */
function present(job, viewer) {
  const employer = employerFor(job);
  const base = {
    id: job.id,
    title: job.title,
    company: job.company,
    category: job.category,
    country: job.country,
    city: job.city,
    location: job.location,
    salary: job.salary,
    inr: job.inr,
    exp: job.exp,
    hours: job.hours,
    visa: job.visa,
    vacancies: job.vacancies,
    benefits: job.benefits,
    description: job.description,
    requirements: job.requirements,
    type: job.type,
    status: job.status,
    postedAt: job.createdAt,
    updatedAt: job.updatedAt,
    // Honest trust signalling: we report whether the employer completed
    // platform verification and the listing's risk band. We never label a
    // listing itself "verified".
    employerVerified: Boolean(employer && employer.profile && employer.profile.verificationStatus === 'verified'),
    riskBand: job.risk ? job.risk.band : 'unknown'
  };

  if (viewer && viewer.role === 'Worker') {
    const match = matching.score(viewer, job);
    base.matchScore = match.score;
    base.matchReasons = match.reasons;
  }

  if (rbac.canManageJob(viewer, job)) {
    base.risk = job.risk || null;
    base.reviewState = job.reviewState;
    base.reviewedAt = job.reviewedAt;
    base.reports = (job.reports || []).length;
  }

  return base;
}

function matchesFilters(job, filters) {
  if (filters.type && filters.type !== 'All' && String(job.type).toLowerCase() !== filters.type.toLowerCase()) return false;
  if (filters.category && filters.category !== 'All' && String(job.category).toLowerCase() !== filters.category.toLowerCase()) return false;
  if (filters.country && filters.country !== 'All' && String(job.country).toLowerCase() !== filters.country.toLowerCase()) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const haystack = [job.title, job.company, job.location, job.category, job.requirements, job.description]
      .map(v => String(v || '').toLowerCase()).join(' ');
    if (!haystack.includes(q)) return false;
  }
  return true;
}

router.get('/', asyncRoute(async (req, res) => {
  const viewer = req.auth ? req.auth.user : null;
  const filters = {
    search: str(req.query.search, { field: 'search', max: 120 }),
    category: str(req.query.category, { field: 'category', max: 60 }),
    type: str(req.query.type, { field: 'type', max: 30 }),
    country: str(req.query.country, { field: 'country', max: 60 })
  };
  const page = int(req.query.page, { field: 'page', min: 1, max: 10000, fallback: 1 });
  const pageSize = int(req.query.pageSize, { field: 'pageSize', min: 1, max: 100, fallback: 50 });
  const scope = oneOf(req.query.scope, ['public', 'mine'], { field: 'scope', fallback: 'public' });

  let jobs = store.read().jobs.slice();

  if (scope === 'mine') {
    if (!viewer) return fail(res, 401, 'AUTH_REQUIRED', 'Authentication required');
    if (viewer.role === 'Employer') {
      jobs = jobs.filter(j => String(j.employerId) === String(viewer.id));
    } else if (!rbac.isAdmin(viewer)) {
      return fail(res, 403, 'FORBIDDEN_ROLE', 'Only employers and administrators can list owned jobs');
    }
  } else {
    // Public browsing only ever exposes published listings. Listings under
    // review, suspended or in draft stay out of the jobseeker-facing list.
    jobs = jobs.filter(j => j.status === 'published');
  }

  jobs = jobs.filter(j => matchesFilters(j, filters));
  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = jobs.length;
  const start = (page - 1) * pageSize;
  const pageItems = jobs.slice(start, start + pageSize).map(j => present(j, viewer));

  return ok(res, {
    count: pageItems.length,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    data: pageItems
  });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const job = rbac.jobById(req.params.id);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');
  const viewer = req.auth ? req.auth.user : null;
  if (!rbac.canViewJob(viewer, job)) {
    // Hidden listings are reported as missing rather than forbidden so the
    // endpoint does not confirm the existence of a suspended listing.
    return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');
  }
  return ok(res, { data: present(job, viewer) });
}));

function readJobBody(body, { partial = false } = {}) {
  const required = !partial;
  const out = {};
  const has = key => body[key] !== undefined;

  if (required || has('title')) out.title = str(body.title, { field: 'title', required, min: 3, max: 140 });
  if (required || has('company')) out.company = str(body.company, { field: 'company', required, min: 2, max: 140 });
  if (required || has('category')) out.category = oneOf(body.category, CATEGORIES, { field: 'category', required, fallback: 'Other' });
  if (required || has('country')) out.country = oneOf(body.country, COUNTRIES, { field: 'country', required });
  if (required || has('city')) out.city = str(body.city, { field: 'city', required, min: 2, max: 80 });
  if (required || has('salary')) out.salary = str(body.salary, { field: 'salary', required, min: 2, max: 120 });
  if (has('inr')) out.inr = str(body.inr, { field: 'inr', max: 120 });
  if (required || has('exp')) out.exp = str(body.exp, { field: 'exp', required, max: 60 });
  if (required || has('hours')) out.hours = str(body.hours, { field: 'hours', required, max: 60 });
  if (required || has('visa')) out.visa = oneOf(body.visa, ['Yes', 'No'], { field: 'visa', required, fallback: 'No' });
  if (required || has('vacancies')) out.vacancies = int(body.vacancies, { field: 'vacancies', required, min: 1, max: 5000 });
  if (has('benefits')) out.benefits = strArray(body.benefits, { field: 'benefits', max: 12, itemMax: 60 });
  if (required || has('description')) out.description = str(body.description, { field: 'description', required, min: 20, max: 4000 });
  if (required || has('requirements')) out.requirements = str(body.requirements, { field: 'requirements', required, min: 10, max: 2000 });

  return out;
}

router.post('/', mw.requireAuth, mw.requireRole('Employer', 'Admin'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const fields = readJobBody(body);
  const requestedStatus = oneOf(body.status, ['draft', 'published'], { field: 'status', fallback: 'published' });

  // An employer always owns the listings they create. An administrator may post
  // on behalf of an employer by passing employerId explicitly.
  let employer = req.auth.user;
  if (rbac.isAdmin(req.auth.user) && body.employerId !== undefined) {
    const target = auth.findUserById(body.employerId);
    if (!target || target.role !== 'Employer') {
      return fail(res, 400, 'EMPLOYER_NOT_FOUND', 'employerId does not refer to an employer account');
    }
    employer = target;
  } else if (req.auth.user.role === 'Admin') {
    return fail(res, 400, 'EMPLOYER_REQUIRED', 'Administrators must supply employerId when posting a job');
  }

  // Risk is computed here from the submitted content. Any riskScore, verified
  // or reviewState value in the request body is ignored.
  const assessment = fraud.assess({ ...fields }, { employer });
  const now = new Date().toISOString();

  const job = await store.mutate(db => {
    const row = {
      id: store.nextId('jobs'),
      employerId: employer.id,
      ...fields,
      benefits: fields.benefits || [],
      inr: fields.inr || '',
      location: `${fields.city}, ${fields.country}`,
      type: String(fields.country).toLowerCase() === 'india' ? 'Local' : 'Overseas',
      status: assessment.requiresReview ? 'under_review' : requestedStatus,
      risk: assessment,
      reviewState: assessment.requiresReview ? 'flagged' : 'clear',
      reviewedBy: null,
      reviewedAt: null,
      reports: [],
      createdAt: now,
      updatedAt: now
    };
    db.jobs.push(row);
    return row;
  });

  await audit.record(req.auth.user, 'JOB_CREATED', {
    targetType: 'job',
    targetId: job.id,
    summary: `${job.title} (risk ${assessment.score}, ${assessment.band})`,
    metadata: { riskScore: assessment.score, status: job.status },
    ip: req.ip
  });

  return ok(res, {
    data: present(job, req.auth.user),
    risk: assessment,
    heldForReview: assessment.requiresReview
  }, 201);
}));

router.patch('/:id', mw.requireAuth, asyncRoute(async (req, res) => {
  const job = rbac.jobById(req.params.id);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');
  if (!rbac.canManageJob(req.auth.user, job)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You can only modify your own listings');
  }

  const body = req.body || {};
  const fields = readJobBody(body, { partial: true });

  let requestedStatus = null;
  if (body.status !== undefined) {
    const allowed = rbac.isAdmin(req.auth.user) ? JOB_STATUSES : ['draft', 'published', 'closed'];
    requestedStatus = oneOf(body.status, allowed, { field: 'status', required: true });
  }

  const merged = { ...job, ...fields };
  const assessment = fraud.assess(merged, { employer: employerFor(job) });

  const updated = await store.mutate(db => {
    const row = db.jobs.find(j => String(j.id) === String(job.id));
    Object.assign(row, fields);
    if (fields.city || fields.country) {
      row.location = `${row.city}, ${row.country}`;
      row.type = String(row.country).toLowerCase() === 'india' ? 'Local' : 'Overseas';
    }
    row.risk = assessment;
    row.updatedAt = new Date().toISOString();

    if (assessment.requiresReview) {
      // An edit that trips the heuristics pulls the listing back for review,
      // regardless of what status the employer asked for.
      row.status = 'under_review';
      row.reviewState = 'flagged';
    } else if (requestedStatus) {
      row.status = requestedStatus;
      if (requestedStatus === 'published') row.reviewState = row.reviewState === 'flagged' ? 'clear' : row.reviewState;
    }
    return row;
  });

  await audit.record(req.auth.user, 'JOB_UPDATED', {
    targetType: 'job',
    targetId: job.id,
    summary: `Updated ${Object.keys(fields).join(', ') || 'status'}; risk now ${assessment.score}`,
    metadata: { riskScore: assessment.score, status: updated.status },
    ip: req.ip
  });

  return ok(res, { data: present(updated, req.auth.user), risk: assessment, heldForReview: assessment.requiresReview });
}));

router.delete('/:id', mw.requireAuth, asyncRoute(async (req, res) => {
  const job = rbac.jobById(req.params.id);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');
  if (!rbac.canManageJob(req.auth.user, job)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You can only remove your own listings');
  }

  const openApplications = store.read().applications.filter(
    a => String(a.jobId) === String(job.id) && !['Rejected', 'Withdrawn', 'Placed'].includes(a.status)
  );

  await store.mutate(db => {
    const row = db.jobs.find(j => String(j.id) === String(job.id));
    // Listings with live applications are closed rather than deleted, so the
    // applicants' records keep pointing at something real.
    if (openApplications.length) {
      row.status = 'closed';
      row.updatedAt = new Date().toISOString();
    } else {
      db.jobs = db.jobs.filter(j => String(j.id) !== String(job.id));
    }
  });

  await audit.record(req.auth.user, openApplications.length ? 'JOB_CLOSED' : 'JOB_DELETED', {
    targetType: 'job',
    targetId: job.id,
    summary: openApplications.length
      ? `Closed instead of deleted: ${openApplications.length} live application(s)`
      : `Deleted listing ${job.title}`,
    ip: req.ip
  });

  return ok(res, {
    message: openApplications.length ? 'Listing closed (live applications exist)' : 'Listing removed',
    closed: openApplications.length > 0
  });
}));

/** Any signed-in user can report a listing; reports route it to human review. */
router.post('/:id/report', mw.requireAuth, asyncRoute(async (req, res) => {
  const job = rbac.jobById(req.params.id);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');
  const reason = str((req.body || {}).reason, { field: 'reason', required: true, min: 5, max: 500 });

  await store.mutate(db => {
    const row = db.jobs.find(j => String(j.id) === String(job.id));
    row.reports = row.reports || [];
    row.reports.push({
      at: new Date().toISOString(),
      byId: req.auth.user.id,
      byRole: req.auth.user.role,
      reason
    });
    row.reviewState = 'flagged';
    if (row.status === 'published' && row.reports.length >= 3) row.status = 'under_review';
    row.updatedAt = new Date().toISOString();
  });

  await audit.record(req.auth.user, 'JOB_REPORTED', {
    targetType: 'job', targetId: job.id, summary: reason.slice(0, 200), ip: req.ip
  });

  return ok(res, { message: 'Report submitted for review' }, 201);
}));

/** Applicants for one listing - owning employer or administrator only. */
router.get('/:id/applicants', mw.requireAuth, asyncRoute(async (req, res) => {
  const job = rbac.jobById(req.params.id);
  if (!job) return fail(res, 404, 'JOB_NOT_FOUND', 'Job not found');
  if (!rbac.canManageJob(req.auth.user, job)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You can only view applicants for your own listings');
  }

  const db = store.read();
  const rows = db.applications
    .filter(a => String(a.jobId) === String(job.id))
    .map(application => {
      const worker = auth.findUserById(application.workerId);
      const match = worker ? matching.score(worker, job) : { score: 0, reasons: [] };
      const docs = db.documents.filter(d => String(d.ownerId) === String(application.workerId));
      return {
        applicationId: application.id,
        status: application.status,
        appliedAt: application.createdAt,
        candidate: worker
          ? {
            id: worker.id,
            name: worker.name,
            trade: worker.profile && worker.profile.trade,
            experienceYears: worker.profile && worker.profile.experienceYears,
            skills: (worker.profile && worker.profile.skills) || [],
            languages: (worker.profile && worker.profile.languages) || [],
            location: worker.profile && worker.profile.currentLocation
          }
          : null,
        matchScore: match.score,
        matchReasons: match.reasons,
        // Employers see verification counts, never the candidate's files.
        documentSummary: {
          total: docs.length,
          verified: docs.filter(d => d.status === 'Verified').length
        }
      };
    });

  return ok(res, { count: rows.length, data: rows });
}));

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
module.exports.COUNTRIES = COUNTRIES;
