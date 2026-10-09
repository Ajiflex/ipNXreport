'use strict';
// ← 15_AutonomousReports.gs, faithful port (corrected version).
// Called INSIDE the hourly tick, which already holds the platform lock, so it
// uses the *Locked engine variants directly (nested re-locking would deadlock).
//
// Month-anchored 7-day windows derived from the earliest known source tab
// (NOT Saturday-anchored weeks — that was an earlier, wrong guess), with a
// 48-hour incomplete-period grace.
const { col } = require('../mongodb');
const { hashHex, stripTime, periodId, pad2, TAB_NAME_PATTERN, tabDateFromName } = require('../lib/hash');
const {
  generateReportLocked, finalizeReportLocked, upsertReportPeriod,
  computeDataVersion, REPORT_MODULES, getSystemConfig
} = require('../reporting');
const { getBlockingUnknownNodeNames } = require('../mapping');
const { getArchivedReport } = require('../archive');

const INCOMPLETE_PERIOD_GRACE_HOURS = 48; // ← from source

// date-tab name (DD_MM_YYYY) -> latest successful ingest ms, across all sources.
async function knownReadySourceTabs() {
  const byName = {};
  (await (await col('source_tabs')).find({}).toArray()).forEach(r => {
    const name = String(r.tab_name);
    if (!TAB_NAME_PATTERN.test(name)) return;
    if (r.last_ingest_status !== 'INGESTED' && r.last_ingest_status !== 'SEEN') return;
    const t = r.last_ingested_at ? new Date(r.last_ingested_at).getTime() : 0;
    if (!byName[name] || t > byName[name]) byName[name] = t;
  });
  return byName;
}

// Month-anchored 7-day windows: first month starts at the EARLIEST source date
// (e.g. 05 Sep → 05–11, 12–18, 19–25); later months start on the 1st.
// A month tail shorter than 7 days (26–30 Sep) is NOT a period — nothing
// hard-coded; November 2026 and January 2027 fall out of the same arithmetic.
function candidateReportWindows(knownByName, now) {
  const dates = Object.keys(knownByName).map(tabDateFromName).filter(Boolean).sort((a, b) => a - b);
  if (!dates.length) return [];
  const earliest = dates[0];
  const latest = dates[dates.length - 1] > now ? dates[dates.length - 1] : now;
  const windows = [];
  let y = earliest.getFullYear(), m = earliest.getMonth();
  while (y < latest.getFullYear() || (y === latest.getFullYear() && m <= latest.getMonth())) {
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const anchor = (y === earliest.getFullYear() && m === earliest.getMonth()) ? earliest.getDate() : 1;
    for (let d = anchor; d + 6 <= daysInMonth; d += 7) {
      windows.push({ start: new Date(y, m, d), end: new Date(y, m, d + 6) });
    }
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return windows;
}

function windowTabNames(win) {
  const names = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(win.start.getFullYear(), win.start.getMonth(), win.start.getDate() + i);
    names.push(pad2(d.getDate()) + '_' + pad2(d.getMonth() + 1) + '_' + d.getFullYear());
  }
  return names;
}

async function recordException(reportType, win, type, message, periodMinutes) {
  const pid = win.periodId || periodId(reportType, win.start, win.end);
  const now = new Date();
  const id = hashHex('REPORT_EXCEPTION|' + reportType + '|' + pid + '|' + type);
  const c = await col('report_exceptions');
  const existing = await c.findOne({ exception_id: id });
  await c.updateOne({ exception_id: id }, {
    $set: {
      exception_id: id, report_type: reportType, period_id: pid,
      period_start: win.start || null, period_end: win.end || null,
      exception_type: type, message: String(message || '').slice(0, 4000),
      status: 'OPEN', first_seen_at: (existing && existing.first_seen_at) || now,
      last_seen_at: now, resolved_at: null
    }
  }, { upsert: true }); // same condition re-detected hourly = ONE row, last_seen_at advances
  if (win.start && periodMinutes) {
    const existingPeriod = await (await col('report_periods')).findOne({ period_id: pid });
    await upsertReportPeriod(reportType, win.start, win.end, periodMinutes, 'PENDING_EXCEPTION',
      existingPeriod ? existingPeriod.data_completeness : 'NONE',
      existingPeriod ? existingPeriod.data_version : '');
  }
}

async function resolvePeriodExceptions(reportType, pid) {
  const now = new Date();
  const r = await (await col('report_exceptions')).updateMany(
    { report_type: reportType, period_id: pid, status: 'OPEN' },
    { $set: { status: 'RESOLVED', resolved_at: now, last_seen_at: now } });
  return r.modifiedCount || 0;
}

const hasOpenExceptions = async (reportType, pid) =>
  !!(await (await col('report_exceptions'))
    .findOne({ report_type: reportType, period_id: pid, status: 'OPEN' }));

function classifyAutonomyError(e) {
  const msg = String((e && e.message) || e);
  if (/template/i.test(msg)) return 'TEMPLATE_INVALID';
  if (/xlsx|export|mime|zip|ooxml|archive/i.test(msg)) return 'EXPORT_FAILED';
  return 'CALCULATION_FAILED';
}

async function processReportWindow(reportType, module, systemConfig, win, known, erroredTabs, now, summary) {
  const names = windowTabNames(win);
  const missing = names.filter(n => !known[n]);
  const failed = names.filter(n => erroredTabs[n]);
  const complete = !missing.length && !failed.length;
  const pid = periodId(reportType, win.start, win.end);
  const dayAfterEnd = stripTime(win.end).getTime() + 86400000;
  const ended = dayAfterEnd <= now.getTime();
  const pastGrace = now.getTime() > dayAfterEnd + INCOMPLETE_PERIOD_GRACE_HOURS * 3600000;
  const archived = await getArchivedReport(reportType, win.start, win.end);

  if (!complete) {
    if (pastGrace || (archived && ended)) {
      const parts = [];
      if (missing.length) parts.push('missing daily tab(s): ' + missing.join(', '));
      if (failed.length) parts.push('tab(s) failed to ingest: ' + failed.map(n => n + ' (' + erroredTabs[n] + ')').join(', '));
      await recordException(reportType, win, 'INCOMPLETE_SOURCE_DATA',
        (archived ? 'Source data for an already archived report is no longer complete — ' : 'Weekly period is incomplete — ') +
        parts.join('; ') + '. The report is generated automatically once every day of the period is present.',
        systemConfig.period_minutes);
      summary.exceptions.push({ period_id: pid, type: 'INCOMPLETE_SOURCE_DATA', message: parts.join('; ') });
    } else {
      summary.open.push(pid);
    }
    return;
  }

  const unknowns = await getBlockingUnknownNodeNames(systemConfig.qualifying_category, win.start, win.end);
  if (unknowns.length > 0) {
    await recordException(reportType, win, 'UNKNOWN_MAPPING',
      'Unmapped node name(s) with ' + systemConfig.qualifying_category + ' incidents in this period: ' +
      unknowns.join(', ') + '. Map them in the Dashboard; the report finalizes itself on the next run afterwards.',
      systemConfig.period_minutes);
    summary.exceptions.push({ period_id: pid, type: 'UNKNOWN_MAPPING', message: unknowns.join(', ') });
    return;
  }

  if (!archived) {
    if (!ended) { summary.open.push(pid); return; } // never generate early
    await regenerateReportPeriod(reportType, module, systemConfig, win, null, summary);
    return;
  }

  // Stale only if a tab was re-ingested after the last verification, or an
  // exception is still open (retry). Content hash decides whether a new
  // revision is real — identical content keeps the archived file.
  const periodRow = await (await col('report_periods')).findOne({ period_id: pid });
  const watermark = (periodRow && periodRow.updated_at) ? new Date(periodRow.updated_at).getTime()
    : (archived.generated_at ? new Date(archived.generated_at).getTime() : 0);
  const reIngested = names.some(n => known[n] > watermark);
  const retrying = (await hasOpenExceptions(reportType, pid)) || (periodRow && periodRow.status === 'STALE');
  if (!reIngested && !retrying) { summary.current++; return; }

  const calc = await module.calculate(win.start, win.end, systemConfig, { persistNarratives: false });
  const dataVersion = computeDataVersion(systemConfig, calc);
  if (archived.data_version === dataVersion && archived.data_completeness === 'COMPLETE' && !retrying) {
    await upsertReportPeriod(reportType, win.start, win.end, systemConfig.period_minutes,
      periodRow ? periodRow.status : 'AUTO_FINALIZED', archived.data_completeness, dataVersion);
    summary.current++;
    return;
  }
  await regenerateReportPeriod(reportType, module, systemConfig, win, archived, summary);
}

async function regenerateReportPeriod(reportType, module, systemConfig, win, archived, summary) {
  const pid = periodId(reportType, win.start, win.end);
  if (archived) { // the library must never show an obsolete report as current
    await upsertReportPeriod(reportType, win.start, win.end, systemConfig.period_minutes, 'STALE',
      archived.data_completeness, archived.data_version);
  }
  const g = await generateReportLocked(reportType, win.start, win.end, {}); // never allowPartial
  if (g.status === 'FAILED_INGESTION' || g.status === 'BLOCKED_INGESTION_INCOMPLETE') {
    await recordException(reportType, win, 'INCOMPLETE_SOURCE_DATA',
      'Ingestion for this period reported ' + g.ingestion.status + ': ' +
      (g.ingestion.errors || []).map(e => e.tab + ': ' + e.message).join('; '),
      systemConfig.period_minutes);
    summary.exceptions.push({ period_id: pid, type: 'INCOMPLETE_SOURCE_DATA', message: g.status });
    return;
  }
  if (g.status === 'BLOCKED_UNKNOWN_ASSETS') {
    await recordException(reportType, win, 'UNKNOWN_MAPPING',
      'Unmapped node name(s): ' + (g.unknowns || []).join(', '), systemConfig.period_minutes);
    summary.exceptions.push({ period_id: pid, type: 'UNKNOWN_MAPPING', message: (g.unknowns || []).join(', ') });
    return;
  }
  // PENDING_NARRATIVE_REVIEW does not block autonomy (narratives are the
  // incident's own factual RFO text or blank — see the popAvailability module).
  const f = await finalizeReportLocked(reportType, win.start, win.end, {});
  if (f.status === 'BLOCKED_UNKNOWN_ASSETS') {
    await recordException(reportType, win, 'UNKNOWN_MAPPING',
      'Unmapped node name(s): ' + (f.unknowns || []).join(', '), systemConfig.period_minutes);
    summary.exceptions.push({ period_id: pid, type: 'UNKNOWN_MAPPING', message: (f.unknowns || []).join(', ') });
    return;
  }
  await upsertReportPeriod(reportType, win.start, win.end, systemConfig.period_minutes,
    'AUTO_FINALIZED', f.dataCompleteness || 'COMPLETE', f.dataVersion);
  const resolved = await resolvePeriodExceptions(reportType, pid);
  const entry = { period_id: pid, revision: f.revision, fileName: f.fileName, reused: !!f.reused, resolvedExceptions: resolved };
  (archived ? summary.revised : summary.generated).push(entry);
}

async function runAutonomousReportsInner(sync) {
  const summary = { generated: [], revised: [], current: 0, open: [], exceptions: [], skipped: [], errors: [] };
  const erroredTabs = {};
  (((sync && sync.errors) || [])).forEach(e => {
    if (TAB_NAME_PATTERN.test(String(e.tab))) erroredTabs[e.tab] = String(e.message);
  });
  const known = await knownReadySourceTabs();
  const now = new Date();
  const windows = candidateReportWindows(known, now);
  for (const reportType of Object.keys(REPORT_MODULES)) {
    const module = REPORT_MODULES[reportType];
    const systemConfig = await getSystemConfig(reportType);
    if (!systemConfig) { summary.skipped.push(reportType + ': no SYSTEM_CONFIG row (run setup)'); continue; }
    for (const win of windows) {
      try {
        await processReportWindow(reportType, module, systemConfig, win, known, erroredTabs, now, summary);
      } catch (e) {
        const type = classifyAutonomyError(e);
        await recordException(reportType, win, type, (e && e.message) || e, systemConfig.period_minutes);
        summary.exceptions.push({ period_id: periodId(reportType, win.start, win.end), type, message: String((e && e.message) || e) });
      }
    }
  }
  return summary;
}

async function runAutonomousReports(sync) { // never throws — a reporting failure must not take the sync down
  try {
    return await runAutonomousReportsInner(sync);
  } catch (e) {
    await recordException('', { periodId: '(platform)' }, 'AUTONOMY_FAILURE', (e && e.message) || e).catch(() => {});
    return {
      fatalError: String((e && e.message) || e),
      generated: [], revised: [], current: 0, open: [], exceptions: [], skipped: [],
      errors: [String((e && e.message) || e)]
    };
  }
}

// Open windows for the Dashboard.
async function computeOpenPeriods() {
  const known = await knownReadySourceTabs();
  const now = new Date();
  return candidateReportWindows(known, now).map(win => {
    const names = windowTabNames(win);
    return {
      start: win.start, end: win.end,
      daysIngested: names.filter(n => known[n]).length, daysRequired: 7,
      ended: stripTime(win.end).getTime() + 86400000 <= now.getTime()
    };
  }).filter(w => !w.ended && (w.daysIngested > 0 || w.start <= now));
}

// Narrative edits / mapping fixes outside ingestion route here.
async function markReportPeriodsStale(shiftDates) {
  const days = {};
  (shiftDates || []).forEach(d => {
    const t = new Date(d);
    if (!isNaN(t.getTime())) days[stripTime(t).getTime()] = true;
  });
  let marked = 0;
  for (const ts of Object.keys(days)) {
    const d = new Date(Number(ts));
    const windows = candidateReportWindows(await knownReadySourceTabs(), new Date());
    for (const w of windows) {
      if (d >= w.start && d <= w.end) {
        const pid = periodId('POP_AVAILABILITY', w.start, w.end);
        await (await col('report_periods')).updateOne({ period_id: pid },
          { $set: { status: 'STALE', updated_at: new Date() } });
        marked++;
      }
    }
  }
  return marked;
}

module.exports = {
  runAutonomousReports, computeOpenPeriods, markReportPeriodsStale,
  candidateReportWindows, knownReadySourceTabs, INCOMPLETE_PERIOD_GRACE_HOURS
};
