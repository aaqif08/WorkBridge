'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const store = require('../lib/store');
const audit = require('../lib/audit');
const rbac = require('../lib/rbac');
const mw = require('../lib/middleware');
const { ok, fail, asyncRoute, str, oneOf } = require('../lib/http');

const router = express.Router();

const DOC_TYPES = ['passport', 'licence', 'experience', 'education', 'medical', 'police', 'photo', 'other'];
// Medical paperwork is treated as sensitive: owner and administrators only.
const SENSITIVE_TYPES = new Set(['medical']);
const DOC_STATUSES = ['Pending Review', 'Verified', 'Rejected'];

const EXTENSIONS = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    cb(null, config.uploadDir);
  },
  filename: (req, file, cb) => {
    // Never reuse the client-supplied filename on disk: it is attacker
    // controlled and could contain path traversal or an executable extension.
    const ext = EXTENSIONS[file.mimetype] || '';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (!config.allowedUploadTypes.includes(file.mimetype)) {
      const err = new Error('UNSUPPORTED_FILE_TYPE');
      err.code = 'UNSUPPORTED_FILE_TYPE';
      return cb(err);
    }
    return cb(null, true);
  }
});

/** Translates multer's errors into the project's error envelope. */
function handleUpload(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 413, 'FILE_TOO_LARGE', `File exceeds the ${config.maxUploadBytes / (1024 * 1024)} MB limit`);
    }
    if (err.code === 'UNSUPPORTED_FILE_TYPE') {
      return fail(res, 415, 'UNSUPPORTED_FILE_TYPE',
        `Allowed file types: ${config.allowedUploadTypes.join(', ')}`);
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return fail(res, 400, 'TOO_MANY_FILES', 'Upload one file at a time using the "file" field');
    }
    return next(err);
  });
}

function present(doc, viewer) {
  const base = {
    id: doc.id,
    name: doc.name,
    type: doc.type,
    status: doc.status,
    sensitive: Boolean(doc.sensitive),
    sizeBytes: doc.sizeBytes,
    mimeType: doc.mimeType,
    originalName: doc.originalName,
    hasFile: Boolean(doc.storedName),
    verifiedByName: doc.verifiedByName,
    verifiedAt: doc.verifiedAt,
    rejectionReason: doc.rejectionReason || '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
  if (rbac.isAdmin(viewer) || String(doc.ownerId) === String(viewer.id)) {
    base.ownerId = doc.ownerId;
  }
  return base;
}

router.get('/', mw.requireAuth, asyncRoute(async (req, res) => {
  const viewer = req.auth.user;
  const ownerParam = req.query.ownerId ? String(req.query.ownerId) : null;

  let rows = rbac.visibleDocuments(viewer);
  if (ownerParam) {
    rows = rows.filter(d => String(d.ownerId) === ownerParam);
    // Asking for someone else's documents is allowed only where the visibility
    // rules already grant it; an empty list is the honest answer otherwise.
    if (!rows.length && ownerParam !== String(viewer.id) && !rbac.isAdmin(viewer)) {
      const anyExist = store.read().documents.some(d => String(d.ownerId) === ownerParam);
      if (anyExist) return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You cannot view this candidate\'s documents');
    }
  }

  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return ok(res, { count: rows.length, data: rows.map(d => present(d, viewer)) });
}));

router.post('/upload', mw.requireAuth, mw.requireRole('Worker', 'Admin'), handleUpload,
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return fail(res, 400, 'FILE_REQUIRED', 'Attach a file in the "file" field (PDF, JPEG, PNG or WebP)');
    }

    const cleanup = async () => { try { await fsp.unlink(req.file.path); } catch (_) { /* already gone */ } };

    let name;
    let type;
    try {
      name = str(req.body.name, { field: 'name', required: true, min: 2, max: 120 });
      type = oneOf(req.body.type, DOC_TYPES, { field: 'type', fallback: 'other' });
    } catch (err) {
      await cleanup();
      throw err;
    }

    // Owner comes from the session. An admin may upload on behalf of a worker.
    let ownerId = req.auth.user.id;
    if (rbac.isAdmin(req.auth.user) && req.body.ownerId) {
      ownerId = Number(req.body.ownerId);
      const owner = store.read().users.find(u => String(u.id) === String(ownerId));
      if (!owner || owner.role !== 'Worker') {
        await cleanup();
        return fail(res, 400, 'OWNER_NOT_FOUND', 'ownerId does not refer to a worker account');
      }
    }

    const now = new Date().toISOString();
    const doc = await store.mutate(db => {
      const row = {
        id: store.nextId('documents'),
        ownerId,
        name,
        type,
        status: 'Pending Review',
        sensitive: SENSITIVE_TYPES.has(type),
        storedName: path.basename(req.file.filename),
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        placeholder: false,
        verifiedById: null,
        verifiedByName: null,
        verifiedAt: null,
        rejectionReason: '',
        createdAt: now,
        updatedAt: now
      };
      db.documents.push(row);
      return row;
    });

    await audit.record(req.auth.user, 'DOCUMENT_UPLOADED', {
      targetType: 'document', targetId: doc.id,
      summary: `${name} (${type}, ${req.file.size} bytes)`, ip: req.ip
    });

    return ok(res, { data: present(doc, req.auth.user) }, 201);
  }));

router.get('/:id/file', mw.requireAuth, asyncRoute(async (req, res) => {
  const doc = rbac.documentById(req.params.id);
  if (!doc) return fail(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  if (!rbac.canViewDocument(req.auth.user, doc)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You cannot access this document');
  }
  if (!doc.storedName) {
    return fail(res, 404, 'DOCUMENT_FILE_MISSING', 'This record has no stored file');
  }

  // Re-basename defensively so a tampered stored name cannot escape the
  // upload directory.
  const absolute = path.join(config.uploadDir, path.basename(doc.storedName));
  if (!fs.existsSync(absolute)) {
    return fail(res, 410, 'DOCUMENT_FILE_GONE',
      'The stored file is no longer on disk. On ephemeral hosting, uploads are lost on redeploy.');
  }

  await audit.record(req.auth.user, 'DOCUMENT_DOWNLOADED', {
    targetType: 'document', targetId: doc.id, summary: doc.name, ip: req.ip
  });

  res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.originalName || doc.name)}"`);
  return res.sendFile(absolute);
}));

router.patch('/:id', mw.requireAuth, asyncRoute(async (req, res) => {
  const doc = rbac.documentById(req.params.id);
  if (!doc) return fail(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');

  const body = req.body || {};
  const status = oneOf(body.status, DOC_STATUSES, { field: 'status', required: true });
  const reason = str(body.rejectionReason, { field: 'rejectionReason', max: 300 });

  // Owners cannot verify their own paperwork; that is the point of verification.
  if (!rbac.canVerifyDocument(req.auth.user, doc)) {
    const ownsIt = String(doc.ownerId) === String(req.auth.user.id);
    return fail(res, 403, ownsIt ? 'CANNOT_VERIFY_OWN_DOCUMENT' : 'FORBIDDEN_RESOURCE',
      ownsIt
        ? 'You cannot change the verification status of your own document'
        : 'You are not authorised to review this document');
  }
  if (status === 'Rejected' && !reason) {
    return fail(res, 400, 'FIELD_REQUIRED', 'A rejection reason is required');
  }

  const now = new Date().toISOString();
  const updated = await store.mutate(db => {
    const row = db.documents.find(d => String(d.id) === String(doc.id));
    row.status = status;
    row.rejectionReason = status === 'Rejected' ? reason : '';
    row.verifiedById = req.auth.user.id;
    row.verifiedByName = req.auth.user.name;
    row.verifiedAt = now;
    row.updatedAt = now;
    return row;
  });

  await audit.record(req.auth.user, 'DOCUMENT_REVIEWED', {
    targetType: 'document', targetId: doc.id,
    summary: `${doc.status} -> ${status}`, metadata: { reason }, ip: req.ip
  });

  return ok(res, { data: present(updated, req.auth.user) });
}));

router.delete('/:id', mw.requireAuth, asyncRoute(async (req, res) => {
  const doc = rbac.documentById(req.params.id);
  if (!doc) return fail(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  const isOwner = String(doc.ownerId) === String(req.auth.user.id);
  if (!isOwner && !rbac.isAdmin(req.auth.user)) {
    return fail(res, 403, 'FORBIDDEN_RESOURCE', 'You can only remove your own documents');
  }
  if (isOwner && doc.status === 'Verified' && !rbac.isAdmin(req.auth.user)) {
    return fail(res, 409, 'DOCUMENT_VERIFIED_LOCKED',
      'A verified document cannot be removed. Contact your consultancy or WorkBridge support.');
  }

  await store.mutate(db => {
    db.documents = db.documents.filter(d => String(d.id) !== String(doc.id));
  });
  if (doc.storedName) {
    try { await fsp.unlink(path.join(config.uploadDir, path.basename(doc.storedName))); } catch (_) { /* best effort */ }
  }

  await audit.record(req.auth.user, 'DOCUMENT_DELETED', {
    targetType: 'document', targetId: doc.id, summary: doc.name, ip: req.ip
  });

  return ok(res, { message: 'Document removed' });
}));

module.exports = router;
module.exports.DOC_TYPES = DOC_TYPES;
