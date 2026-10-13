'use strict';

const store = require('./store');

const MAX_ROWS = 5000;

/**
 * Appends an immutable-ish audit entry. Audit rows are never edited or deleted
 * by application code; only the oldest rows are trimmed to bound file size.
 */
async function record(actor, action, details = {}) {
  return store.mutate(db => {
    const entry = {
      id: store.nextId('auditLogs'),
      at: new Date().toISOString(),
      actorId: actor ? actor.id : null,
      actorName: actor ? actor.name : 'system',
      actorRole: actor ? actor.role : 'System',
      action,
      targetType: details.targetType || null,
      targetId: details.targetId !== undefined ? details.targetId : null,
      summary: details.summary || '',
      metadata: details.metadata || {},
      ip: details.ip || null
    };
    db.auditLogs.push(entry);
    if (db.auditLogs.length > MAX_ROWS) {
      db.auditLogs = db.auditLogs.slice(-MAX_ROWS);
    }
    return entry;
  });
}

function list({ limit = 100, action = '', actorId = null } = {}) {
  let rows = store.read().auditLogs.slice();
  if (action) rows = rows.filter(r => r.action === action);
  if (actorId) rows = rows.filter(r => String(r.actorId) === String(actorId));
  return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

module.exports = { record, list };
