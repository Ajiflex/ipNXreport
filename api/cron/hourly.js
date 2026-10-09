'use strict';
// /api/cron/hourly — the Vercel Cron target. Vercel Cron issues a GET with
// `Authorization: Bearer $CRON_SECRET`; POST is also accepted for manual
// invocations with the same credential. Everything else → 401/405.
//
// INTEGRATION CORRECTION #1: runAutonomousReports(sync) runs AFTER
// syncOperationalSources; the sync result exposes per-tab errors (tab fields)
// and the orchestrator derives everything else from source_tabs — no
// changedDates plumbing.
const crypto = require('crypto');
const { config } = require('../../server/config');
const { col, ensureIndexes } = require('../../server/mongodb');
const { authorizedClient } = require('../../server/google/auth');
const { acquireLock, releaseLock } = require('../../server/lib/lock');
const { json, allowMethods } = require('../_lib');

module.exports = async (req, res) => {
  // Vercel Cron issues GET with the Bearer secret; POST accepted for manual runs.
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  if ((req.headers.authorization || '') !== 'Bearer ' + config().cronSecret) {
    return json(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid cron secret' } });
  }
  const runId = crypto.randomUUID();
  let lockHeld = false;
  try {
    await ensureIndexes();
    lockHeld = await acquireLock('hourly_sync', 55 * 60 * 1000);
    if (!lockHeld) {
      return json(res, 409, { ok: false, error: { code: 'LOCKED', message: 'Another run is in progress' } });
    }
    const auth = await authorizedClient(); // refresh-token auto-refresh
    const { syncOperationalSources } = require('../../server/ingestion');
    const sync = await syncOperationalSources(auth); // discovery → change detect → ingest → reconcile
    const { runAutonomousReports } = require('../../server/autonomous');
    const reports = await runAutonomousReports(sync); // affected periods → XLSX → validate → finalize → archive
    const status = sync.status === 'SUCCESS' ? 'SUCCESS' : sync.status;
    await (await col('sync_runs')).insertOne({
      run_id: runId, started_at: new Date(), finished_at: new Date(),
      status, trigger: 'cron',
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
    return json(res, 200, { ok: true, runId, sync: { status: sync.status }, reports });
  } catch (e) {
    await (await col('sync_runs')).insertOne({
      run_id: runId, started_at: new Date(), finished_at: new Date(),
      status: 'FAILURE', trigger: 'cron', error: String(e.message || e), code: e.code || 'INTERNAL'
    }).catch(() => {});
    return json(res, 200, { ok: false, error: { code: e.code || 'INTERNAL', message: 'Run failed; see sync_runs' } });
  } finally {
    if (lockHeld) await releaseLock('hourly_sync').catch(() => {});
  }
};

// Catch-up is structural: every run re-fingerprints Drive state against
// persisted source_tabs.content_hash, so a failed 10:00 run is fully caught by
// the 11:00 run — no missed-run bookkeeping needed.
