'use strict';
// GET /api/bootstrap — everything the dashboard needs on first paint:
// Google connection state, last sync, counts, report status, exceptions.
const { allowMethods, fail, json } = require('./_lib');
const { col } = require('../server/mongodb');
const { isConnected } = require('../server/google/auth');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const connected = await isConnected();
    const lastSync = (await (await col('sync_runs')).find({}).toArray())
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0] || null;
    const count = async (name, filter) => (await col(name)).find(filter || {}).toArray()
      .then(r => r.length);
    const exceptions = await (await col('report_exceptions')).find({ status: 'OPEN' }).toArray();
    json(res, 200, {
      ok: true,
      google: { connected },
      lastSync,
      counts: {
        sources: await count('sources', { status: 'ACTIVE' }),
        sourceTabs: await count('source_tabs'),
        rawEvents: await count('raw_events'),
        incidents: await count('incidents'),
        reports: await count('report_archive'),
        openExceptions: exceptions.length,
        pendingMappings: await count('mappings', { mapping_type: 'NODE_NAME', status: 'PENDING_REVIEW' })
      },
      exceptions: exceptions.slice(0, 50)
    });
  } catch (e) {
    fail(res, e);
  }
};
