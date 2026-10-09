'use strict';
// MANDATORY REGRESSION B (Bug #12): duplicate-source authority.
// When two sources hold the same date tab, the copy from the MOST RECENTLY
// MODIFIED source wins — and an older duplicate whose copy later changes must
// NOT override the authoritative data.
const { test, assert, eq, freshDb, makeOutageTab } = require('./helpers');
const { installGoogleMock } = require('./mocks/google');

const TAB = '12_10_2026';
const FILE_A = 'FILE_OLDER';
const FILE_B = 'FILE_NEWER';

async function seedTwoSources() {
  const { col } = require('../server/mongodb');
  const c = await col('sources');
  const base = {
    mime_type: 'application/vnd.google-apps.spreadsheet', parent_folder_id: '',
    source_type: 'OPERATIONAL_OUTAGE_LOG', report_category: 'OUTAGE', report_period: [],
    discovered_at: new Date(), last_seen_at: new Date(), last_ingested_at: null,
    status: 'ACTIVE', discovery_method: 'DRIVE_SEARCH', status_reason: ''
  };
  await c.insertOne({ ...base, source_id: 'SRC_A', drive_file_id: FILE_A, spreadsheet_id: FILE_A, name: 'Log A (older)', last_modified_time: '2026-10-12T08:00:00.000Z' });
  await c.insertOne({ ...base, source_id: 'SRC_B', drive_file_id: FILE_B, spreadsheet_id: FILE_B, name: 'Log B (newer)', last_modified_time: '2026-10-12T09:00:00.000Z' });
}

function installTwo(tabA, tabB) {
  return installGoogleMock({
    files: [
      { id: FILE_A, name: 'Log A (older)', modifiedTime: '2026-10-12T08:00:00.000Z', tabs: { [TAB]: tabA } },
      { id: FILE_B, name: 'Log B (newer)', modifiedTime: '2026-10-12T09:00:00.000Z', tabs: { [TAB]: tabB } }
    ]
  });
}

test('REGRESSION #12: newest-modified source wins on first ingestion', async () => {
  await freshDb();
  installTwo(
    makeOutageTab('12/10/2026', [['Yaba BST', '12/10/2026 02:10', '12/10/2026 05:10', '180', 'A copy', 'POP']]),
    makeOutageTab('12/10/2026', [
      ['Yaba BST', '12/10/2026 02:10', '12/10/2026 06:40', '270', 'B copy — authoritative', 'POP'],
      ['Kenaz BST', '12/10/2026 09:00', '12/10/2026 10:00', '60', 'B only row', 'POP']
    ])
  );
  await seedTwoSources();
  const { syncOperationalSources } = require('../server/ingestion');
  const r = await syncOperationalSources({});
  eq(r.status, 'SUCCESS', 'sync status');
  assert(r.warnings.some(w => /exists in more than one source/.test(w)), 'duplicate warning emitted');
  eq(r.rowsNew, 2, 'only the authoritative (B) rows are ingested');

  const { col } = require('../server/mongodb');
  const rows = await (await col('raw_events')).find({ source_sheet: TAB }).toArray();
  eq(rows.length, 2, 'raw event count');
  assert(rows.every(x => x.source_spreadsheet_id === FILE_B), 'every ingested row comes from FILE_B');
  assert(rows.some(x => x.rfo_text === 'B copy — authoritative'), 'authoritative content present');
  assert(!rows.some(x => x.rfo_text === 'A copy'), 'non-authoritative content NOT ingested');
});

test('REGRESSION #12: a changed OLDER duplicate never overrides the authoritative copy', async () => {
  await freshDb();
  const mock = installTwo(
    makeOutageTab('12/10/2026', [['Yaba BST', '12/10/2026 02:10', '12/10/2026 05:10', '180', 'A copy', 'POP']]),
    makeOutageTab('12/10/2026', [['Yaba BST', '12/10/2026 02:10', '12/10/2026 06:40', '270', 'B copy — authoritative', 'POP']])
  );
  await seedTwoSources();
  const { syncOperationalSources } = require('../server/ingestion');
  await syncOperationalSources({}); // B ingested; A persisted as SEEN (lost authority)

  // A's copy mutates later (but A is still the OLDER-modified source).
  mock.setTab(FILE_A, TAB, makeOutageTab('12/10/2026', [
    ['Yaba BST', '12/10/2026 02:10', '12/10/2026 05:10', '180', 'A CHANGED copy', 'POP'],
    ['Surulere BST', '12/10/2026 12:00', '12/10/2026 13:00', '60', 'A-only bogus row', 'POP']
  ]));
  const r2 = await syncOperationalSources({});
  eq(r2.status, 'SUCCESS', 'second sync status');
  eq(r2.rowsNew, 0, 'the changed duplicate contributes ZERO new rows');

  const { col } = require('../server/mongodb');
  const rows = await (await col('raw_events')).find({ source_sheet: TAB }).toArray();
  eq(rows.length, 1, 'still exactly the authoritative row');
  eq(rows[0].source_spreadsheet_id, FILE_B, 'authoritative source unchanged');
  eq(rows[0].rfo_text, 'B copy — authoritative', 'authoritative content not overwritten');
  assert(!rows.some(x => x.rfo_text === 'A-only bogus row'), 'bogus duplicate row rejected');

  // The losing copy's fingerprint is persisted (SEEN) so it stops retriggering,
  // and a third run is fully quiet.
  const stA = await (await col('source_tabs')).findOne({ source_id: 'SRC_A', tab_name: TAB });
  assert(stA, 'loser tab state persisted');
  eq(stA.last_ingest_status, 'SEEN', 'loser is SEEN, never INGESTED');
  const r3 = await syncOperationalSources({});
  eq(r3.rowsNew, 0, 'third sync: no rows');
  eq(r3.tabsUnchanged, 2, 'third sync: both copies UNCHANGED');
});

test('REGRESSION #12: if the AUTHORITATIVE source changes, its update wins', async () => {
  await freshDb();
  const mock = installTwo(
    makeOutageTab('12/10/2026', [['Yaba BST', '12/10/2026 02:10', '12/10/2026 05:10', '180', 'A copy', 'POP']]),
    makeOutageTab('12/10/2026', [['Yaba BST', '12/10/2026 02:10', '12/10/2026 06:40', '270', 'B copy — authoritative', 'POP']])
  );
  await seedTwoSources();
  const { syncOperationalSources } = require('../server/ingestion');
  await syncOperationalSources({});

  // B (newer, authoritative) corrects the restoration time.
  mock.setTab(FILE_B, TAB, makeOutageTab('12/10/2026', [
    ['Yaba BST', '12/10/2026 02:10', '12/10/2026 08:00', '350', 'B corrected RFO', 'POP']
  ]));
  mock.setModified(FILE_B, '2026-10-13T09:00:00.000Z');
  const r2 = await syncOperationalSources({});
  eq(r2.status, 'SUCCESS', 'sync status');
  eq(r2.rowsUpdated, 1, 'the authoritative correction is applied');

  const { col } = require('../server/mongodb');
  const rows = await (await col('raw_events')).find({ source_sheet: TAB }).toArray();
  eq(rows.length, 1, 'row count');
  eq(rows[0].rfo_text, 'B corrected RFO', 'authoritative correction persisted');
  eq(Number(rows[0].duration_raw_minutes), 350, 'corrected duration persisted');
});
