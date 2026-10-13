'use strict';

const config = require('./backend/config');
const store = require('./backend/lib/store');
const { bootstrap, printStartupNotes } = require('./backend/bootstrap');
const { createApp } = require('./backend/app');

async function start() {
  // Fails fast with a readable message when the environment is incomplete,
  // before anything touches the datastore or binds a port.
  config.assertValid();

  const result = await bootstrap();
  const app = createApp();

  const server = app.listen(config.port, () => {
    printStartupNotes(result);
    console.log('====================================================');
    console.log(`WorkBridge platform listening on port ${config.port} (${config.env})`);
    console.log(`  Frontend / API : http://localhost:${config.port}`);
    console.log(`  Health         : http://localhost:${config.port}/health`);
    console.log('====================================================');
  });

  // Without this, a port clash surfaces as an unhandled 'error' event and a
  // stack trace rather than something an operator can act on.
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[workbridge] port ${config.port} is already in use. Stop the other process or set PORT.`);
    } else if (err.code === 'EACCES') {
      console.error(`[workbridge] not permitted to bind port ${config.port}. Use a port above 1024 or grant permission.`);
    } else {
      console.error('[workbridge] server error:', err.message);
    }
    process.exit(1);
  });

  const shutdown = signal => {
    console.log(`\n[workbridge] ${signal} received, shutting down`);
    server.close(() => {
      try {
        // Flush any mutation that has been applied in memory but not yet
        // written, so a restart does not lose the last change.
        store.flushSync();
      } catch (err) {
        console.error('[workbridge] final flush failed:', err.message);
      }
      process.exit(0);
    });
    // Do not hang forever on lingering keep-alive sockets.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

process.on('unhandledRejection', reason => {
  console.error('[workbridge] unhandled promise rejection:', reason);
});

if (require.main === module) {
  start().catch(err => {
    console.error('[workbridge] failed to start:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { start };
