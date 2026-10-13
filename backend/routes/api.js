'use strict';

/**
 * API router.
 *
 * Mount order matters: every request gets a resolved identity (`attachUser`)
 * and, for cookie-authenticated mutations, a CSRF check before any handler
 * runs. Individual routers then apply requireAuth / requireRole.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const mw = require('../lib/middleware');
const { fail } = require('../lib/http');

const router = express.Router();

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.isTest ? 100000 : 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => fail(res, 429, 'TOO_MANY_REQUESTS', 'Too many requests. Please slow down.')
});

router.use(generalLimiter);
router.use(mw.attachUser);
router.use(mw.requireCsrf);

router.use('/auth', require('./auth.routes'));
router.use('/jobs', require('./jobs.routes'));
router.use('/applications', require('./applications.routes'));
router.use('/visa', require('./visa.routes'));
router.use('/documents', require('./documents.routes'));
router.use('/ai', require('./ai.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/', require('./misc.routes'));

router.use((req, res) => fail(res, 404, 'ROUTE_NOT_FOUND', 'API route not found'));

module.exports = router;
