'use strict';
// POST /api/sync/run — manual trigger of the same lock-guarded pipeline the
// hourly cron runs (server-side only — the frontend never runs the engine).
const crypto = require('crypto');
const { allowMethods, fail, json, requireApiKey } = require('../_lib');
const { ensureIndexes, col } = require('../../server/mongodb');
const { authorizedClient } = require('../../server/google/auth');
const { acquireLock, releaseLock } = require('../../server/lib/lock');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['POST'])) return;
  if (!requireApiKey(req, res)) return;
  const runId = crypto.randomUUID();
  let lockHeld = false;
  try {
    await ensureIndexes();
    lockHeld = await acquireLock('hourly_sync', 55 * 60 * 1000);
    if (!lockHeld) {
      return json(res, 409, { ok: false, error: { code: 'LOCKED', message: 'Another run is in progress' } });
    }
    const auth = await authorizedClient();
    const { syncOperationalSources } = require('../../server/ingestion');
    const sync = await syncOperationalSources(auth);
    const { runAutonomousReports } = require('../../server/autonomous');
    const reports = await runAutonomousReports(sync);
    const status = sync.status === 'SUCCESS' ? 'SUCCESS' : sync.status;
    await (await col('sync_runs')).insertOne({
      run_id: runId, started_at: new Date(), finished_at: new Date(),
      status, trigger: 'manual',
      sourcesScanned: sync.sourcesScanned,
      tabsScanned: (sync.tabsDiscovered || 0) + (sync.tabsUpdated || 0) + (sync.tabsUnchanged || 0),
      tabsChanged: sync.tabsUpdated,
      eventsIngested: (sync.rowsNew || 0) + (sync.rowsUpdated || 0),
      incidentsCreated: sync.newIncidents,
      incidentsUpdated: (sync.continuedIncidents || 0) + (sync.closedIncidents || 0),
      reportsGenerated: (reports.generated || []).length,
      reportsFinalized: (reports.generated || []).length + (reports.revised || []).length,
      reportsArchived: (reports.generated || []).length + (reports.revised || []).length,
      exceptions: (sync.errors || []).concat((reports && reports.exceptions) || []),
      error: null
    });
    return json(res, 200, { ok: true, runId, sync, reports });
  } catch (e) {
    await (await col('sync_runs')).insertOne({
      run_id: runId, started_at: new Date(), finished_at: new Date(),
      status: 'FAILURE', trigger: 'manual', error: String(e.message || e), code: e.code || 'INTERNAL'
    }).catch(() => {});
    return fail(res, e);
  } finally {
    if (lockHeld) await releaseLock('hourly_sync').catch(() => {});
  }
};
