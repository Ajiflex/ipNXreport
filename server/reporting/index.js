'use strict';
// ← 07_ReportEngine.gs, faithful port.
// INTEGRATION CORRECTION #2: exports generateReportLocked / finalizeReportLocked /
// upsertReportPeriod so the autonomous orchestrator (15) can call the Locked
// variants inside the platform lock (nested re-locking would deadlock).
const { COLLECTIONS } = require('../config');
const { col, upsertMany, replaceGroup } = require('../mongodb');
const { hashHex, stripTime, periodId, formatDate } = require('../lib/hash');
const { ingestRange } = require('../ingestion');
const { reconcileEvents } = require('../reconciliation');
const { getBlockingUnknownNodeNames } = require('../mapping');
const { acquireLock, releaseLock } = require('../lib/lock');
const popModule = require('./popAvailability');

// ← REPORT_MODULES registry (wrappers keep the module contract identical).
const REPORT_MODULES = {
  POP_AVAILABILITY: {
    calculate: popModule.calculate,
    populateTemplate: popModule.populateTemplate,
    validateTemplate: popModule.validateTemplate
  }
};

const REPORT_PERIODS_HEADERS = ['period_id', 'report_type', 'period_start', 'period_end',
  'period_minutes', 'status', 'data_completeness', 'data_version', 'updated_at'];
const WEEKLY_RESULTS_HEADERS = ['period_id', 'asset_id', 'total_downtime_minutes',
  'availability_pct', 'sla_status', 'poor_performing', 'incident_refs', 'report_type',
  'data_version', 'calculated_at'];

async function getSystemConfig(reportType) {
  return (await col(COLLECTIONS.SYSTEM_CONFIG)).findOne({ report_type: reportType });
}

// Deterministic hash of everything that appears in the report (incl. reviewed narrative).
function computeDataVersion(systemConfig, calc) {
  const t = d => d ? new Date(d).getTime() : '';
  const payload = {
    cfg: [systemConfig.qualifying_category, Number(systemConfig.period_minutes),
      Number(systemConfig.sla_target), Number(systemConfig.poor_performing_threshold)],
    assets: calc.perAsset.map(a => [
      a.asset_id, a.total_downtime_minutes, a.availability_pct, a.sla_status, a.poor_performing,
      a.incidents.slice().sort((x, y) => x.incident_id < y.incident_id ? -1 : 1).map(i => [
        i.incident_id, t(i.start_time), t(i.end_time), i.duration_minutes, i.status,
        i.rfo_text, i.issue_text || '', i.resolution_text || ''
      ])
    ]).sort((x, y) => x[0] < y[0] ? -1 : 1)
  };
  return hashHex(JSON.stringify(payload));
}

async function upsertReportPeriod(reportType, startDate, endDate, periodMinutes, status, completeness, dataVersion) {
  const record = {
    period_id: periodId(reportType, startDate, endDate), report_type: reportType,
    period_start: startDate, period_end: endDate, period_minutes: periodMinutes,
    status, data_completeness: completeness, data_version: dataVersion, updated_at: new Date()
  };
  await upsertMany(COLLECTIONS.REPORT_PERIODS, o => o.period_id, [record]);
  return record;
}

async function persistWeeklyResults(reportType, startDate, endDate, perAsset, dataVersion) {
  const id = periodId(reportType, startDate, endDate), now = new Date();
  await replaceGroup(COLLECTIONS.WEEKLY_RESULTS, 'period_id', id, perAsset.map(a => ({
    asset_id: a.asset_id, total_downtime_minutes: a.total_downtime_minutes,
    availability_pct: a.availability_pct, sla_status: a.sla_status,
    poor_performing: a.poor_performing, incident_refs: JSON.stringify(a.incident_ids),
    report_type: reportType, data_version: dataVersion, calculated_at: now
  })));
}

async function generateReportLocked(reportType, startDate, endDate, options) {
  const module = REPORT_MODULES[reportType];
  if (!module) throw new Error('Unknown report_type: ' + reportType);
  const systemConfig = await getSystemConfig(reportType);
  if (!systemConfig) throw new Error('No SYSTEM_CONFIG row for ' + reportType + ' — run setup once.');

  // 1: common source layer (ingestRange port has identical SUCCESS/PARTIAL/FAILURE contract)
  const ingestion = await ingestRange(startDate, endDate);
  const warnings = (ingestion.warnings || []).slice();
  if (ingestion.status === 'FAILURE') {
    return { status: 'FAILED_INGESTION', dataCompleteness: 'NONE', ingestion, warnings };
  }
  const partial = ingestion.status === 'PARTIAL_FAILURE';
  if (partial && !options.allowPartial) {
    return { status: 'BLOCKED_INGESTION_INCOMPLETE', dataCompleteness: 'PARTIAL', ingestion, warnings };
  }
  if (partial) {
    warnings.push('PARTIAL SOURCE DATA (operator override): ' +
      ingestion.errors.map(e => e.tab + ': ' + e.message).join('; '));
  }

  // 2: common reconciliation
  const reconcile = await reconcileEvents(startDate, endDate);
  if (reconcile.unclassifiedEvents > 0) {
    warnings.push(reconcile.unclassifiedEvents + ' source row(s) have a blank Outage Type and were not assigned to any report category.');
  }
  if (reconcile.eventsMissingOutageTime > 0) {
    warnings.push(reconcile.eventsMissingOutageTime + ' source row(s) have no parseable outage time.');
  }

  // 3: category-scoped mapping gate
  const unknowns = await getBlockingUnknownNodeNames(systemConfig.qualifying_category, startDate, endDate);
  if (unknowns.length > 0) {
    return { status: 'BLOCKED_UNKNOWN_ASSETS', unknowns, ingestion, reconcile, warnings };
  }

  // 4: module calculation
  const calc = await module.calculate(startDate, endDate, systemConfig, { persistNarratives: true });
  (calc.warnings || []).forEach(w => warnings.push(w));
  const dataVersion = computeDataVersion(systemConfig, calc);
  const completeness = partial ? 'PARTIAL' : 'COMPLETE';

  // 5: recordkeeping — upserts keyed on period identity
  const { getArchivedReport } = require('../archive');
  const archived = await getArchivedReport(reportType, startDate, endDate);
  const alreadyGenerated = !!archived && archived.data_version === dataVersion &&
    archived.data_completeness === completeness;
  const status = alreadyGenerated ? 'GENERATED'
    : (calc.needsNarrativeReview ? 'PENDING_NARRATIVE_REVIEW' : 'CALCULATED');
  await upsertReportPeriod(reportType, startDate, endDate, systemConfig.period_minutes,
    status, completeness, dataVersion);
  await persistWeeklyResults(reportType, startDate, endDate, calc.perAsset, dataVersion);
  return { status, dataCompleteness: completeness, dataVersion, warnings, ingestion, reconcile, result: calc, archived };
}

async function generateReport(reportType, startDate, endDate, options) {
  const lock = await acquireLock('report_engine', 10 * 60 * 1000); // ← withScriptLock_ equivalent
  if (!lock) throw new Error('Another platform run is in progress (could not obtain lock).');
  try {
    return await generateReportLocked(reportType, startDate, endDate, options || {});
  } finally {
    await releaseLock('report_engine');
  }
}

function reportFileName(reportType, startDate, endDate, revision, partial) {
  return reportType + ' ' + formatDate(startDate) + '_to_' + formatDate(endDate) +
    (partial ? ' PARTIAL' : '') + (revision > 1 ? ' rev' + revision : '') + '.xlsx';
}

async function finalizeReportLocked(reportType, startDate, endDate, options) {
  const module = REPORT_MODULES[reportType];
  if (!module) throw new Error('Unknown report_type: ' + reportType);
  const systemConfig = await getSystemConfig(reportType);
  const pid = periodId(reportType, startDate, endDate);
  const period = await (await col(COLLECTIONS.REPORT_PERIODS)).findOne({ period_id: pid });
  if (!period) {
    throw new Error('finalizeReport: ' + pid + ' has not been calculated — run generateReport() first.');
  }
  const partial = period.data_completeness === 'PARTIAL';
  if (partial && !options.allowPartial) {
    throw new Error('finalizeReport: ' + pid + ' was calculated from PARTIAL source data; pass {allowPartial:true} to finalize it knowingly.');
  }
  const unknowns = await getBlockingUnknownNodeNames(systemConfig.qualifying_category, startDate, endDate);
  if (unknowns.length > 0) return { status: 'BLOCKED_UNKNOWN_ASSETS', unknowns };

  // Read-only recalculation — must NOT overwrite operator-edited narrative.
  const calc = await module.calculate(startDate, endDate, systemConfig, { persistNarratives: false });
  const dataVersion = computeDataVersion(systemConfig, calc);
  const completeness = partial ? 'PARTIAL' : 'COMPLETE';
  const { getArchivedReport, archiveGeneratedReport } = require('../archive');
  const archived = await getArchivedReport(reportType, startDate, endDate);
  if (archived && archived.data_version === dataVersion &&
    archived.data_completeness === completeness && !options.force) {
    await upsertReportPeriod(reportType, startDate, endDate, systemConfig.period_minutes,
      'GENERATED', completeness, dataVersion);
    return {
      status: 'GENERATED', reused: true, driveFileId: archived.drive_file_id,
      fileName: archived.file_name, revision: Number(archived.revision) || 1, dataVersion
    };
  }
  const revision = archived ? (Number(archived.revision) || 1) + 1 : 1;
  const fileName = reportFileName(reportType, startDate, endDate, revision, partial);
  const exported = await module.populateTemplate(startDate, endDate, calc, { fileName }); // generate→validate→save→verify
  await archiveGeneratedReport(reportType, startDate, endDate, exported, dataVersion, revision, completeness);
  await upsertReportPeriod(reportType, startDate, endDate, systemConfig.period_minutes,
    'GENERATED', completeness, dataVersion);
  return {
    status: 'GENERATED', reused: false, driveFileId: exported.fileId, fileName,
    revision, dataVersion, dataCompleteness: completeness
  };
}

async function finalizeReport(reportType, startDate, endDate, options) {
  const lock = await acquireLock('report_engine', 10 * 60 * 1000);
  if (!lock) throw new Error('Another platform run is in progress (could not obtain lock).');
  try {
    return await finalizeReportLocked(reportType, startDate, endDate, options || {});
  } finally {
    await releaseLock('report_engine');
  }
}

module.exports = {
  REPORT_MODULES, generateReport, finalizeReport,
  generateReportLocked, finalizeReportLocked, upsertReportPeriod, // ← correction #2
  computeDataVersion, getSystemConfig, reportFileName,
  REPORT_PERIODS_HEADERS, WEEKLY_RESULTS_HEADERS
};
