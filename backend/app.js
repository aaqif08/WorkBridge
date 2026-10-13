'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const config = require('./config');
const store = require('./lib/store');
const ai = require('./lib/ai');
const { ApiError, fail } = require('./lib/http');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const app = express();

  // Behind Render/Heroku/a reverse proxy, req.ip and secure-cookie detection
  // need the forwarded headers to be trusted.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // No inline scripts: the frontend uses delegated event handlers only,
        // so script-src can stay strict.
        scriptSrc: ["'self'"],
        // Inline styles are still used for layout-level tweaks in the views.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProduction ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false
  }));

  // CORS is closed by default. Same-origin requests from the served frontend
  // need no CORS at all; cross-origin callers must be listed explicitly.
  if (config.corsOrigins.length) {
    app.use(cors({
      origin: (origin, cb) => {
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new ApiError(403, 'CORS_ORIGIN_NOT_ALLOWED', 'Origin not allowed'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
    }));
  }

  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    if (!config.isTest) {
      const started = Date.now();
      res.on('finish', () => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
      });
    }
    next();
  });

  /**
   * Health check that actually checks dependencies. It reports 503 when the
   * datastore is unusable, so a platform health probe fails instead of a broken
   * instance staying in rotation.
   */
  app.get('/health', (req, res) => {
    const storeHealth = store.health();
    let uploadsWritable = true;
    let uploadsError = null;
    try {
      fs.accessSync(config.uploadDir, fs.constants.W_OK);
    } catch (err) {
      uploadsWritable = false;
      uploadsError = `upload directory not writable: ${config.uploadDir}`;
    }

    const checks = {
      database: storeHealth,
      uploads: { ok: uploadsWritable, error: uploadsError },
      aiAssistant: {
        ok: true,
        mode: ai.available() ? 'live' : 'fallback',
        provider: ai.available() ? 'anthropic' : null,
        model: ai.available() ? config.ai.model : null
      }
    };

    // Uploads being read-only degrades the service but does not break browsing
    // or authentication, so it is reported without failing the probe.
    const healthy = checks.database.ok;
    return res.status(healthy ? 200 : 503).json({
      status: healthy ? (uploadsWritable ? 'healthy' : 'degraded') : 'unhealthy',
      service: 'WorkBridge Platform',
      env: config.env,
      uptimeSeconds: Math.round(process.uptime()),
      checks,
      timestamp: new Date().toISOString()
    });
  });

  app.use('/api', require('./routes/api'));

  // Static frontend. Only PUBLIC_DIR is served, so backend source, the runtime
  // database, uploads and .env are not reachable over HTTP.
  app.use(express.static(PUBLIC_DIR, {
    etag: true,
    maxAge: config.isProduction ? '1h' : 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // Express identifies an error handler by its four-argument signature.
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return fail(res, err.status, err.code, err.message, err.details);
    }
    if (err && err.type === 'entity.too.large') {
      return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return fail(res, 400, 'MALFORMED_JSON', 'Request body is not valid JSON');
    }

    console.error(`[error] request ${req.id}:`, err && err.stack ? err.stack : err);
    // Never return a stack trace or internal message to a public caller.
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId: req.id
    });
  });

  return app;
}

module.exports = { createApp, PUBLIC_DIR };
