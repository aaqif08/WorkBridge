'use strict';

/**
 * Centralised ownership rules. Route handlers ask these questions instead of
 * re-deriving "is this mine?" logic, so a change here applies everywhere.
 *
 * Every function takes the *server-resolved* user (req.auth.user) - never a
 * role, id or permission taken from the request body.
 */

const store = require('./store');

const APPLICATION_STAGES = [
  'Applied',
  'Shortlisted',
  'Interview Scheduled',
  'Offer Issued',
  'Visa Processing',
  'Placed',
  'Rejected',
  'Withdrawn'
];

// Who is allowed to move an application into a given stage.
const STAGE_PERMISSIONS = {
  Shortlisted: ['Employer', 'Admin'],
  'Interview Scheduled': ['Employer', 'Admin'],
  'Offer Issued': ['Employer', 'Admin'],
  Rejected: ['Employer', 'Admin'],
  'Visa Processing': ['Consultancy', 'Admin'],
  Placed: ['Consultancy', 'Admin'],
  Withdrawn: ['Worker', 'Admin'],
  Applied: ['Admin']
};

const VISA_STAGES = [
  'Offer Letter',
  'Visa Applied',
  'Medical Test',
  'Embassy Submission',
  'Visa Stamping',
  'Travel Booking',
  'Departure'
];

const VISA_STATUSES = ['pending', 'current', 'done', 'blocked'];

function isAdmin(user) {
  return Boolean(user) && user.role === 'Admin';
}

function jobById(id) {
  return store.read().jobs.find(j => String(j.id) === String(id)) || null;
}

function applicationById(id) {
  return store.read().applications.find(a => String(a.id) === String(id)) || null;
}

function visaCaseById(id) {
  return store.read().visaCases.find(v => String(v.id) === String(id)) || null;
}

function documentById(id) {
  return store.read().documents.find(d => String(d.id) === String(id)) || null;
}

/** Jobs are editable only by their owning employer, or an administrator. */
function canManageJob(user, job) {
  if (!user || !job) return false;
  if (isAdmin(user)) return true;
  return user.role === 'Employer' && String(job.employerId) === String(user.id);
}

/** Published jobs are public; drafts and suspended jobs are owner/admin only. */
function canViewJob(user, job) {
  if (!job) return false;
  if (job.status === 'published') return true;
  return canManageJob(user, job);
}

function consultancyHasCase(user, candidateId) {
  if (!user || user.role !== 'Consultancy') return false;
  return store.read().consultancyAssignments.some(
    a => String(a.consultancyId) === String(user.id) &&
         String(a.workerId) === String(candidateId) &&
         a.status === 'active'
  );
}

function canViewApplication(user, application) {
  if (!user || !application) return false;
  if (isAdmin(user)) return true;
  if (user.role === 'Worker') return String(application.workerId) === String(user.id);
  if (user.role === 'Employer') return String(application.employerId) === String(user.id);
  if (user.role === 'Consultancy') return consultancyHasCase(user, application.workerId);
  return false;
}

function canSetApplicationStage(user, application, stage) {
  if (!canViewApplication(user, application)) return false;
  const allowed = STAGE_PERMISSIONS[stage];
  if (!allowed || !allowed.includes(user.role)) return false;
  if (user.role === 'Worker') return String(application.workerId) === String(user.id);
  if (user.role === 'Employer') return String(application.employerId) === String(user.id);
  if (user.role === 'Consultancy') return consultancyHasCase(user, application.workerId);
  return isAdmin(user);
}

function canViewVisaCase(user, visaCase) {
  if (!user || !visaCase) return false;
  if (isAdmin(user)) return true;
  if (user.role === 'Worker') return String(visaCase.workerId) === String(user.id);
  if (user.role === 'Consultancy') return String(visaCase.consultancyId) === String(user.id);
  if (user.role === 'Employer') return String(visaCase.employerId) === String(user.id);
  return false;
}

/** Only the assigned consultancy (or an admin) can move a milestone. */
function canUpdateVisaCase(user, visaCase) {
  if (!user || !visaCase) return false;
  if (isAdmin(user)) return true;
  return user.role === 'Consultancy' && String(visaCase.consultancyId) === String(user.id);
}

/**
 * Document visibility.
 * - owners always see their own documents
 * - admins see everything
 * - the assigned consultancy sees a candidate's documents, EXCEPT documents
 *   marked `sensitive` (medical results), which stay with the owner and admin
 * - employers never see a candidate's raw documents, only verification counts
 */
function canViewDocument(user, doc) {
  if (!user || !doc) return false;
  if (String(doc.ownerId) === String(user.id)) return true;
  if (isAdmin(user)) return true;
  if (user.role === 'Consultancy' && consultancyHasCase(user, doc.ownerId)) {
    return !doc.sensitive;
  }
  return false;
}

/** Verification decisions are made by consultancies and admins, not owners. */
function canVerifyDocument(user, doc) {
  if (!user || !doc) return false;
  if (isAdmin(user)) return true;
  return user.role === 'Consultancy' && consultancyHasCase(user, doc.ownerId) && !doc.sensitive;
}

function visibleApplications(user) {
  const all = store.read().applications;
  if (isAdmin(user)) return all.slice();
  return all.filter(a => canViewApplication(user, a));
}

function visibleVisaCases(user) {
  return store.read().visaCases.filter(v => canViewVisaCase(user, v));
}

function visibleDocuments(user) {
  return store.read().documents.filter(d => canViewDocument(user, d));
}

module.exports = {
  APPLICATION_STAGES,
  STAGE_PERMISSIONS,
  VISA_STAGES,
  VISA_STATUSES,
  isAdmin,
  jobById,
  applicationById,
  visaCaseById,
  documentById,
  canManageJob,
  canViewJob,
  canViewApplication,
  canSetApplicationStage,
  canViewVisaCase,
  canUpdateVisaCase,
  canViewDocument,
  canVerifyDocument,
  consultancyHasCase,
  visibleApplications,
  visibleVisaCases,
  visibleDocuments
};
