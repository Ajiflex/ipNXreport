'use strict';
// Report-generation tests: full pipeline generate → finalize → archive →
// revision/reuse semantics, weekly results replacement, mapping gate.
const { test, assert, eq, freshDb, makeOutageTab } = require('./helpers');
const { installGoogleMock } = require('./mocks/google');

const FILE = 'FILE_REP';
const START = new Date(2026, 9, 5), END = new Date(2026, 9, 11); // Oct 5–11, 2026

function weekTabs() {
  const tabs = {};
  const days = ['05/10/2026', '06/10/2026', '07/10/2026', '08/10/2026', '09/10/2026', '10/10/2026', '11/10/2026'];
  days.forEach(d => {
    const name = d.replace(/\//g, '_');
    tabs[name] = makeOutageTab(d, d === '06/10/2026'
      ? [['Yaba BST', '06/10/2026 02:00', '06/10/2026 05:00', '180', 'Fibre cut at mile 2', 'POP']]
      : []);
  });
  return tabs;
}

async function provision() {
  await freshDb();
  installGoogleMock({ files: [{ id: FILE, name: 'Operational Log', tabs: weekTabs() }] });
  const { col } = require('../server/mongodb');
  await (await col('sources')).insertOne({
    source_id: 'SRC_REP', drive_file_id: FILE, spreadsheet_id: FILE, name: 'Operational Log',
    status: 'ACTIVE', discovery_method: 'MANUAL_CONNECT', last_modified_time: '2026-10-12T00:00:00.000Z'
  });
  const { setupPlatform } = require('../server/setup');
  await setupPlatform(null);
  const { saveTokens } = require('../server/google/auth');
  await saveTokens({ refresh_token: 'r', access_token: 'a', expiry_date: Date.now() + 3600000 });
}

test('generate → calculate → weekly results; finalize → archive; rerun reuses', async () => {
  await provision();
  const { generateReport, finalizeReport } = require('../server/reporting');

  const gen = await generateReport('POP_AVAILABILITY', START, END, {});
  assert(['CALCULATED', 'PENDING_NARRATIVE_REVIEW'].includes(gen.status), 'calculated, got ' + gen.status);
  eq(gen.dataCompleteness, 'COMPLETE', 'complete data');
  assert(gen.dataVersion && gen.dataVersion.length === 32, 'data version computed');

  const { col } = require('../server/mongodb');
  const weekly = await (await col('weekly_results')).find({}).toArray();
  eq(weekly.length, 57, 'weekly results for all 57 POPs');
  const yaba = weekly.find(w => w.asset_id === 'yaba');
  eq(yaba.total_downtime_minutes, 180, 'yaba downtime in weekly results');

  const fin = await finalizeReport('POP_AVAILABILITY', START, END, {});
  eq(fin.status, 'GENERATED', 'finalized');
  eq(fin.revision, 1, 'first revision');
  assert(/POP_AVAILABILITY 20261005_to_20261011\.xlsx$/.test(fin.fileName), 'file name: ' + fin.fileName);
  assert(fin.driveFileId, 'archived to Drive');

  const archived = await (await col('report_archive')).findOne({ report_type: 'POP_AVAILABILITY' });
  eq(archived.status, 'FINAL', 'archive record FINAL');
  eq(archived.data_version, gen.dataVersion, 'archive carries the data version');

  // Unchanged data → GENERATED reuse, no new revision, no new file.
  const gen2 = await generateReport('POP_AVAILABILITY', START, END, {});
  eq(gen2.status, 'GENERATED', 'already-generated short-circuit');
  const fin2 = await finalizeReport('POP_AVAILABILITY', START, END, {});
  eq(fin2.reused, true, 'finalize reuses the archived file');
  eq(fin2.revision, 1, 'no new revision');

  // weekly_results regeneration REPLACES, never appends
  eq((await (await col('weekly_results')).find({}).toArray()).length, 57, 'weekly results still exactly 57');
});

test('mapping gate: unknown node blocks generation with BLOCKED_UNKNOWN_ASSETS', async () => {
  await provision();
  const mock = require('./mocks/google');
  // Add an outage row for an unmapped node.
  const { files } = mock;
  void files;
  const g = installGoogleMock({
    files: [{
      id: FILE, name: 'Operational Log', tabs: (() => {
        const t = weekTabs();
        t['07_10_2026'] = makeOutageTab('07/10/2026', [['Totally Unknown Node', '07/10/2026 02:00', '07/10/2026 03:00', '60', 'x', 'POP']]);
        return t;
      })()
    }]
  });
  void g;
  const { generateReport } = require('../server/reporting');
  const gen = await generateReport('POP_AVAILABILITY', START, END, {});
  eq(gen.status, 'BLOCKED_UNKNOWN_ASSETS', 'gate blocks');
  assert(gen.unknowns.includes('TOTALLY UNKNOWN NODE'), 'unknown node named');
});

test('finalize without calculate fails with a clear error', async () => {
  await provision();
  const { finalizeReport } = require('../server/reporting');
  const { throws } = require('./helpers');
  await throws(() => finalizeReport('POP_AVAILABILITY', new Date(2026, 10, 2), new Date(2026, 10, 8), {}),
    /has not been calculated/, 'finalize requires generate first');
});

test('lock: concurrent generateReport is refused', async () => {
  await provision();
  const { acquireLock } = require('../server/lib/lock');
  const held = await acquireLock('report_engine', 60000);
  eq(held, true, 'first lock acquired');
  const { generateReport } = require('../server/reporting');
  const { throws } = require('./helpers');
  await throws(() => generateReport('POP_AVAILABILITY', START, END, {}), /could not obtain lock/, 'second run refused');
  const { releaseLock } = require('../server/lib/lock');
  await releaseLock('report_engine');
});
