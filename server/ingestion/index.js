'use strict';
// ← 04_Ingestion.gs — ingestRange + syncOperationalSources, with BOTH mandated
// bug fixes (#11 hash/rowCount persistence, #12 duplicate-source authority).
const { google } = require('googleapis');
const { COLLECTIONS } = require('../config');
const { col, upsertMany } = require('../mongodb');
const { hashHex, tabDateFromName } = require('../lib/hash');
const {
  sourceCandidates, discoverSourceTabs, findMissingSourceTabs, pickAuthoritativeTab
} = require('../discovery');
const { discoverOperationalSources } = require('../google/drive');
const { readSourceTab } = require('../google/sheets');

function computeRawId(rec) { // ← UNCHANGED basis: category-aware identity
  return hashHex([
    rec.source_sheet, rec.source_block, rec.node_name_normalized,
    rec.outage_time ? new Date(rec.outage_time).getTime() : 'NA',
    String(rec.raw_outage_type || '').trim().toUpperCase()
  ].join('|'));
}

async function upsertRawEvents(records) {
  const now = new Date();
  const byId = {}, order = [];
  for (const rec of records) { // same raw_id twice in one batch: last wins (unchanged)
    const id = computeRawId(rec);
    if (!byId[id]) order.push(id);
    byId[id] = { ...rec, raw_id: id, last_seen_at: now, first_seen_at: now };
  }
  const objs = order.map(id => byId[id]);
  return upsertMany(COLLECTIONS.RAW_EVENTS, o => o.raw_id, objs,
    (existing, incoming) => ({ ...incoming, first_seen_at: existing.first_seen_at || incoming.first_seen_at }));
}

// ═══════════════ BUG #11 FIX ═══════════════
// Report025 bug: scanSourceForChanges_ computed t.hash / t.rowCount from the
// freshly read sheet, but the SOURCE_TABS state update consumed
// t.tabEntry.contentHash / t.tabEntry.rowCount — the stale entry object. In
// this port, scanSourceForChanges returns { hash, rowCount } explicitly and
// upsertSourceTabState is called with THOSE values only (never re-derived from
// tabEntry), so first-ingestion persists the true fingerprint and a second
// scan of unchanged content → UNCHANGED with zero re-ingestion.
async function upsertSourceTabState(sourceId, tabName, tabDate, contentHash, rowCount, ingestStatus) {
  const now = new Date();
  const c = await col(COLLECTIONS.SOURCE_TABS);
  const existing = await c.findOne({ source_id: sourceId, tab_name: tabName });
  await c.updateOne({ source_id: sourceId, tab_name: tabName }, {
    $set: {
      source_id: sourceId,
      tab_name: tabName,
      tab_date: tabDate,
      content_hash: contentHash, // ← the value computed in scanSourceForChanges_
      row_count: rowCount,       // ← likewise
      last_seen_at: now,
      last_ingested_at: ingestStatus === 'SEEN' ? ((existing && existing.last_ingested_at) || null) : now,
      last_ingest_status: ingestStatus === 'SEEN' ? ((existing && existing.last_ingest_status) || 'SEEN') : ingestStatus,
      first_seen_at: (existing && existing.first_seen_at) || now
    }
  }, { upsert: true });
}

// scanSourceForChanges_ — per-tab fault tolerant; a failed tab KEEPS its prior
// state and is retried next run (unchanged). Returns state NEW|CHANGED|UNCHANGED.
async function scanSourceForChanges(auth, src) {
  const sheets = google.sheets({ version: 'v4', auth });
  const registry = {};
  (await (await col(COLLECTIONS.SOURCE_TABS)).find({ source_id: src.sourceId }).toArray())
    .forEach(r => { registry[r.tab_name] = r; });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: src.spreadsheetId, fields: 'sheets(properties.title)' });
  const out = [], errors = [];
  for (const s of meta.data.sheets || []) {
    const tabName = s.properties.title;
    const date = tabDateFromName(tabName);
    if (!date) continue;
    const tabEntry = {
      spreadsheetId: src.spreadsheetId, sourceId: src.sourceId, tabName, date,
      sourceName: src.name, sourceModified: src.lastModified
    };
    let records = null;
    try {
      records = await readSourceTab(sheets, tabEntry); // sets tabEntry.contentHash/rowCount
    } catch (e) {
      errors.push({ tab: tabName, message: String(e.message || e) });
      continue; // keep previous SOURCE_TABS state (unchanged behavior)
    }
    const prior = registry[tabName];
    const state = !prior ? 'NEW'
      : (prior.content_hash !== tabEntry.contentHash || Number(prior.row_count) !== tabEntry.rowCount) ? 'CHANGED'
        : 'UNCHANGED';
    out.push({ state, tabEntry, records, hash: tabEntry.contentHash, rowCount: tabEntry.rowCount });
  }
  return { tabs: out, errors };
}

// finishSync → logIngestionRun_ equivalent; write-tolerant, unchanged semantics.
function finishSync(runStart, status, discovery, sourcesScanned, tabsNew, tabsChanged,
  tabsUnchanged, tabsRead, rowsSeen, rowsNew, rowsUpdated, byCategory, reconcile, errors, warnings) {
  const sync = {
    status, discovery, sourcesScanned,
    tabsDiscovered: tabsNew, tabsUpdated: tabsChanged, tabsUnchanged,
    tabsRead, rowsSeen, rowsNew, rowsUpdated, eventsByCategory: byCategory,
    newIncidents: (reconcile && reconcile.incidentsCreated) || 0,
    continuedIncidents: (reconcile && reconcile.incidentsChanged) || 0,
    closedIncidents: (reconcile && reconcile.closedIncidents) || 0,
    newUnknownMappings: (reconcile && reconcile.newUnknownMappings) || 0,
    reconcile, errors, warnings
  };
  col(COLLECTIONS.INGESTION_LOG).then(c => c.insertOne({
    run_id: require('crypto').randomUUID(), started_at: runStart, finished_at: new Date(),
    tabs_read: tabsRead, rows_seen: rowsSeen, rows_new: rowsNew, rows_updated: rowsUpdated,
    missing_tabs: [], errors, warnings, result: status, tabs_new: tabsNew
  })).catch(e => { sync.warnings.push('INGESTION_LOG write failed: ' + e.message); });
  return sync;
}

// ═══════════════ BUG #12 FIX applied (authority BEFORE processing) ═══════════
// Changed tabs are deduplicated across sources via pickAuthoritativeTab
// (server/discovery) BEFORE any ingestion or reconciliation runs.
async function syncOperationalSources(auth) {
  const runStart = new Date();
  const errors = [], warnings = [];
  let discovery = null;
  try {
    discovery = await discoverOperationalSources(auth);
    (discovery.errors || []).forEach(e => warnings.push(`Discovery: ${e.where}: ${e.message}`));
  } catch (e) {
    errors.push({ tab: '(drive discovery)', message: String(e.message || e) });
  }
  const sources = (await sourceCandidates()).filter(s => s.spreadsheetId);
  if (!sources.length) {
    errors.push({ tab: '(sources)', message: 'No operational sources: nothing discovered on Drive and no operational sheet connected.' });
    return finishSync(runStart, 'FAILURE', discovery, 0, 0, 0, 0, 0, 0, 0, 0, {}, null, errors, warnings);
  }

  // Fingerprint every source's tabs; keep every scanned tab (any state) for
  // authority resolution. UNCHANGED tabs are re-persisted with the computed
  // hash/rowCount — BUG #11 fix in action.
  const scannedTabs = [];
  let tabsUnchanged = 0, scannedOk = 0;
  for (const src of sources) {
    let scanned;
    try {
      scanned = await scanSourceForChanges(auth, src);
    } catch (e) {
      errors.push({ tab: `(source ${src.name || src.spreadsheetId})`, message: String(e.message || e) });
      continue;
    }
    scannedOk++;
    (scanned.errors || []).forEach(e => errors.push(e));
    for (const t of scanned.tabs) {
      scannedTabs.push(t);
      if (t.state === 'UNCHANGED') {
        tabsUnchanged++;
        await upsertSourceTabState(src.sourceId, t.tabEntry.tabName, t.tabEntry.date, t.hash, t.rowCount, 'SEEN');
      }
    }
  }
  if (scannedOk === 0) {
    return finishSync(runStart, 'FAILURE', discovery, sources.length, 0, 0, 0, 0, 0, 0, 0, {}, null, errors, warnings);
  }

  // §12 (Bug #12 fix): cross-source authority BEFORE processing, resolved among
  // ALL holders of a tab name — not just the changed ones. Otherwise an older
  // duplicate whose copy changed could be ingested while the authoritative
  // (newest-modified) source is UNCHANGED, silently overriding authority.
  const byName = {};
  for (const t of scannedTabs) {
    (byName[t.tabEntry.tabName] = byName[t.tabEntry.tabName] || []).push(t);
  }
  const deduped = [];
  for (const holders of Object.values(byName)) {
    if (!holders.some(h => h.state !== 'UNCHANGED')) continue; // nothing to process
    let winner = holders[0];
    for (const h of holders.slice(1)) {
      const winnerEntry = pickAuthoritativeTab(winner.tabEntry, h.tabEntry, warnings);
      winner = (winnerEntry === h.tabEntry) ? h : winner;
    }
    for (const h of holders) {
      if (h !== winner && h.state !== 'UNCHANGED') {
        // Duplicate copy changed but lost authority — never ingested; its own
        // fingerprint is persisted as SEEN so it does not re-trigger forever.
        await upsertSourceTabState(h.tabEntry.sourceId, h.tabEntry.tabName, h.tabEntry.date, h.hash, h.rowCount, 'SEEN');
      }
    }
    if (winner.state !== 'UNCHANGED') deduped.push(winner); // authoritative data already stored when UNCHANGED
  }
  deduped.sort((a, b) => a.tabEntry.date - b.tabEntry.date);
  const tabsNew = deduped.filter(t => t.state === 'NEW').length;

  // Upsert changed tabs (idempotent by raw_id).
  const allRecords = [];
  const byCategory = {};
  let tabsRead = 0;
  for (const t of deduped) {
    for (const rec of t.records) {
      allRecords.push(rec);
      const cat = String(rec.raw_outage_type || 'UNCLASSIFIED').toUpperCase() || 'UNCLASSIFIED';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    tabsRead++;
  }
  let rowsNew = 0, rowsUpdated = 0;
  try {
    const res = await upsertRawEvents(allRecords);
    rowsNew = res.created; rowsUpdated = res.updated;
  } catch (e) {
    errors.push({ tab: '(datastore write)', message: String(e.message || e) });
    return finishSync(runStart, 'FAILURE', discovery, sources.length, tabsNew, deduped.length - tabsNew,
      tabsUnchanged, 0, allRecords.length, 0, 0, byCategory, null, errors, warnings);
  }

  // Persist ACTUAL hash/rowCount + INGESTED status (BUG #11 fix).
  for (const t of deduped) {
    if (t.tabEntry.sourceId) {
      await upsertSourceTabState(t.tabEntry.sourceId, t.tabEntry.tabName, t.tabEntry.date, t.hash, t.rowCount, 'INGESTED');
    }
  }
  if (tabsRead > 0) { // touch last_ingested_at on sources (unchanged)
    const c = await col(COLLECTIONS.SOURCES);
    for (const t of deduped) {
      if (t.tabEntry.sourceId) {
        await c.updateOne({ source_id: t.tabEntry.sourceId }, { $set: { last_ingested_at: runStart } });
      }
    }
  }

  // Reconcile the affected span (September rows stay put; an October
  // observation resumes a still-open September incident — see 06).
  let reconcile = null;
  const okDates = deduped.map(t => t.tabEntry.date);
  if (okDates.length) {
    const lo = new Date(Math.min(...okDates)), hi = new Date(Math.max(...okDates));
    const { reconcileEvents } = require('../reconciliation');
    reconcile = await reconcileEvents(lo, hi);
  }
  const status = errors.length ? 'PARTIAL_FAILURE' : 'SUCCESS';
  return finishSync(runStart, status, discovery, sources.length, tabsNew, deduped.length - tabsNew,
    tabsUnchanged, tabsRead, allRecords.length, rowsNew, rowsUpdated, byCategory, reconcile, errors, warnings);
}

// ingestRange(startDate, endDate) — the date-bounded port; outcome contract
// SUCCESS / PARTIAL_FAILURE / FAILURE unchanged. Reads ONLY the authoritative
// copy of each in-range tab (Level-2 discovery already applied Bug #12).
async function ingestRange(startDate, endDate, auth) {
  const warnings = [], errors = [];
  let authClient = auth;
  if (!authClient) {
    const { authorizedClient } = require('../google/auth');
    authClient = await authorizedClient();
  }
  let discovered;
  try {
    discovered = await discoverSourceTabs(authClient, startDate, endDate, warnings);
  } catch (e) {
    errors.push({ tab: '(discovery)', message: String(e.message || e) });
    return finishIngestion('FAILURE', [], warnings, errors, 0, 0, 0, 0);
  }
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const allRecords = [];
  let tabsRead = 0;
  for (const tabEntry of discovered) {
    let records;
    try {
      records = await readSourceTab(sheets, tabEntry); // sets tabEntry.contentHash/rowCount
    } catch (e) {
      errors.push({ tab: tabEntry.tabName, message: String(e.message || e) });
      continue;
    }
    tabsRead++;
    for (const rec of records) allRecords.push(rec);
    // Persist the ACTUAL fingerprint (Bug #11 fix — same contract as sync).
    if (tabEntry.sourceId) {
      await upsertSourceTabState(tabEntry.sourceId, tabEntry.tabName, tabEntry.date,
        tabEntry.contentHash, tabEntry.rowCount, 'INGESTED');
    }
  }
  let rowsNew = 0, rowsUpdated = 0;
  try {
    const res = await upsertRawEvents(allRecords);
    rowsNew = res.created; rowsUpdated = res.updated;
  } catch (e) {
    errors.push({ tab: '(datastore write)', message: String(e.message || e) });
    return finishIngestion('FAILURE', [], warnings, errors, tabsRead, allRecords.length, 0, 0);
  }
  const missingTabs = findMissingSourceTabs(startDate, endDate, discovered);
  const status = errors.length ? 'PARTIAL_FAILURE' : 'SUCCESS';
  return finishIngestion(status, missingTabs, warnings, errors, tabsRead, allRecords.length, rowsNew, rowsUpdated);
}

function finishIngestion(status, missingTabs, warnings, errors, tabsRead, rowsSeen, rowsNew, rowsUpdated) {
  return { status, missingTabs, warnings, errors, tabsRead, rowsSeen, rowsNew, rowsUpdated };
}

module.exports = {
  computeRawId, upsertRawEvents, upsertSourceTabState, scanSourceForChanges,
  syncOperationalSources, ingestRange
};
