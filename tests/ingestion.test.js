'use strict';
// Ingestion ports of the original scenarios: raw_id identity, idempotency,
// outcome contract, missing-tab detection, per-tab fault tolerance.
const { test, assert, eq, freshDb, makeOutageTab } = require('./helpers');
const { installGoogleMock } = require('./mocks/google');

const FILE = 'FILE_ING';

test('raw_id is deterministic and category-aware', async () => {
  const { computeRawId } = require('../server/ingestion');
  const base = {
    source_sheet: '12_10_2026', source_block: 'Day', node_name_normalized: 'YABA BST',
    outage_time: new Date('2026-10-12T02:10:00Z'), raw_outage_type: 'POP'
  };
  eq(computeRawId(base), computeRawId({ ...base }), 'same input → same id');
  assert(computeRawId(base) !== computeRawId({ ...base, raw_outage_type: 'FIBRE' }),
    'POP ≠ FIBRE (category-aware identity)');
  assert(computeRawId(base) !== computeRawId({ ...base, source_block: 'Night' }),
    'Day ≠ Night');
});

test('upsertRawEvents is idempotent and preserves first_seen_at', async () => {
  await freshDb();
  const { upsertRawEvents } = require('../server/ingestion');
  const rec = {
    source_sheet: '12_10_2026', source_block: 'Day', source_row: 4,
    shift_date: new Date(2026, 9, 12), node_name_raw: 'Yaba BST', node_name_normalized: 'YABA BST',
    outage_time: new Date('2026-10-12T02:10:00Z'), restoration_time: null,
    duration_raw_minutes: null, rfo_text: 'Fibre cut', raw_outage_type: 'POP',
    rfo_shared_within_30: 'Yes', status_raw: 'OPEN', fault_owner: 'NOC',
    service_impacting: 'Yes', reporting_officer: 'A', closed_by: ''
  };
  const r1 = await upsertRawEvents([rec]);
  eq(r1, { created: 1, updated: 0 }, 'first upsert creates');
  const { col } = require('../server/mongodb');
  const first = (await (await col('raw_events')).find({}).toArray())[0];

  const r2 = await upsertRawEvents([{ ...rec, rfo_text: 'Fibre cut (updated)' }]);
  eq(r2, { created: 0, updated: 1 }, 'second upsert updates in place');
  const second = (await (await col('raw_events')).find({}).toArray())[0];
  eq(second.first_seen_at.getTime(), first.first_seen_at.getTime(), 'first_seen_at preserved');
  eq(second.rfo_text, 'Fibre cut (updated)', 'update applied');
});

test('ingestRange: SUCCESS contract, missing-tab detection, date bounds', async () => {
  await freshDb();
  installGoogleMock({
    files: [{
      id: FILE, name: 'Log', tabs: {
        '05_10_2026': makeOutageTab('05/10/2026', [['Yaba BST', '05/10/2026 02:00', '05/10/2026 03:00', '60', 'cut', 'POP']]),
        '07_10_2026': makeOutageTab('07/10/2026', []),
        'not_a_date_tab': [['ignored']]
      }
    }]
  });
  const { col } = require('../server/mongodb');
  await (await col('sources')).insertOne({
    source_id: 'SRC_ING', drive_file_id: FILE, spreadsheet_id: FILE, name: 'Log',
    status: 'ACTIVE', discovery_method: 'MANUAL_CONNECT', last_modified_time: '2026-10-08T00:00:00.000Z'
  });

  const { ingestRange } = require('../server/ingestion');
  const r = await ingestRange(new Date(2026, 9, 5), new Date(2026, 9, 11), {});
  eq(r.status, 'SUCCESS', 'readable tabs do not fail the run');
  eq(r.tabsRead, 2, 'two tabs read');
  eq(r.rowsNew, 1, 'one row ingested');
  eq(r.missingTabs, ['06_10_2026', '08_10_2026', '09_10_2026', '10_10_2026', '11_10_2026'],
    'missing daily tabs reported');
});

test('ingestRange: a failing tab → PARTIAL_FAILURE, others still ingested', async () => {
  await freshDb();
  const mock = installGoogleMock({
    files: [{
      id: FILE, name: 'Log', tabs: {
        '05_10_2026': makeOutageTab('05/10/2026', [['Yaba BST', '05/10/2026 02:00', '05/10/2026 03:00', '60', 'cut', 'POP']]),
        '06_10_2026': makeOutageTab('06/10/2026', [])
      }
    }]
  });
  const { col } = require('../server/mongodb');
  await (await col('sources')).insertOne({
    source_id: 'SRC_ING', drive_file_id: FILE, spreadsheet_id: FILE, name: 'Log',
    status: 'ACTIVE', discovery_method: 'MANUAL_CONNECT', last_modified_time: '2026-10-08T00:00:00.000Z'
  });
  // Make 06_10_2026 unreadable by removing it from the tab store after listing:
  // emulate a read failure by deleting the tab content key the values.get needs.
  delete mock.files.get(FILE).tabs['06_10_2026'];
  mock.files.get(FILE).tabs['06_10_2026'] = undefined; // listing shows it, read fails

  const { ingestRange } = require('../server/ingestion');
  const r = await ingestRange(new Date(2026, 9, 5), new Date(2026, 9, 6), {});
  eq(r.status, 'PARTIAL_FAILURE', 'one failing tab → PARTIAL_FAILURE');
  eq(r.rowsNew, 1, 'good tab still ingested');
  assert(r.errors.some(e => e.tab === '06_10_2026'), 'failure attributed to the failing tab');
});

test('readSourceTab: header-mapped columns, block tracking, shift-date ownership', async () => {
  const { readSourceTab } = require('../server/google/sheets');
  const values = [
    ['Header noise'],
    ['Night 12/10/2026'],
    ['NODE NAME', 'RFO', 'OUTAGE TIME', 'Outage Type', 'RESTORATION TIME', 'DURATION'], // shuffled column order
    ['Kenaz BST', 'Power trip', '12/10/2026 01:00', 'POP', '12/10/2026 02:30', '90'],
    ['Day 13/10/2026'],
    ['NODE NAME', 'RFO', 'OUTAGE TIME', 'Outage Type', 'RESTORATION TIME', 'DURATION'],
    ['Yaba BST', 'Fibre', '13/10/2026 09:00', 'POP', '', '']
  ];
  const sheets = { spreadsheets: { values: { async get() { return { data: { values } }; } } } };
  const tabEntry = { spreadsheetId: 'X', tabName: '12_10_2026', date: new Date(2026, 9, 12) };
  const recs = await readSourceTab(sheets, tabEntry);
  eq(recs.length, 2, 'two data rows');
  eq(recs[0].node_name_normalized, 'KENAZ BST', 'normalized');
  eq(recs[0].source_block, 'Night', 'night block tracked');
  eq(recs[0].rfo_text, 'Power trip', 'header-mapped RFO (not index-based)');
  eq(Number(recs[0].duration_raw_minutes), 90, 'duration parsed');
  eq(recs[1].source_block, 'Day', 'block switches');
  eq(recs[1].shift_date.getTime(), new Date(2026, 9, 12).getTime(), 'shift_date = the TAB date, not the timestamp');
  assert(tabEntry.contentHash && tabEntry.contentHash.length === 32, 'contentHash computed');
  eq(tabEntry.rowCount, values.filter(r => r.some(c => c !== '' && c != null)).length, 'rowCount computed');
});
