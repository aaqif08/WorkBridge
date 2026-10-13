#!/usr/bin/env node
'use strict';

/**
 * Probes a running instance's /health endpoint and exits non-zero unless it
 * reports healthy or degraded. Suitable for a Docker HEALTHCHECK or a CI gate.
 *
 * Usage: node scripts/health-check.js [url]
 */

const url = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 5000}/health`;

(async () => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
    if (!res.ok || body.status === 'unhealthy') {
      console.error(`[health] FAILED: status=${res.status} report=${body.status}`);
      process.exit(1);
    }
    console.log(`[health] OK (${body.status})`);
  } catch (err) {
    console.error(`[health] could not reach ${url}: ${err.message}`);
    process.exit(1);
  }
})();
