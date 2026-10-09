'use strict';
// MANDATORY REGRESSION A (Bug #11): hash / rowCount persistence.
// The persisted SOURCE_TABS state must carry the ACTUAL computed content_hash
// and rowCount of the freshly read tab. If the stale tabEntry object were
// persisted (the original bug), a second scan of unchanged content would be
// misclassified CHANGED and re-ingested forever.
const { test, assert, eq, freshDb, makeOutageTab } = require('./helpers');
const { installGoogleMock } = require('./mocks/google');
const { hashHex } = require('../server/lib/hash');

const FILE = 'FILE_HASH';
const TAB = '12_10_2026';

function fixtureRows() {
  return makeOutageTab('12/10/2026', [
    ['Yaba BST', '12/10/2026 02:10', '12/10/2026 05:10', '180', 'Fibre cut', 'POP'],
    ['Kenaz BST', '12/10/2026 09:00', '', '', '', 'POP']
  ]);
}

async function seedSource() {
  const { col } = require('../server/mongodb');
  await (await col('sources')).insertOne({
    source_id: 'SRC_HASH', drive_file_id: FILE, spreadsheet_id: FILE,
    name: 'Operational Log', mime_type: 'application/vnd.google-apps.spreadsheet',
    parent_folder_id: '', source_type: 'OPERATIONAL_OUTAGE_LOG', report_category: 'OUTAGE',
    report_period: [], discovered_at: new Date(), last_seen_at: new Date(),
    last_ingested_at: null, last_modified_time: '2026-10-12T08:00:00.000Z',
    status: 'ACTIVE', discovery_method: 'MANUAL_CONNECT', status_reason: ''
  });
}

test('REGRESSION #11: first ingestion persists the ACTUAL hash + rowCount', async () => {
  await freshDb();
  const values = fixtureRows();
  installGoogleMock({ files: [{ id: FILE, name: 'Operational Log', tabs: { [TAB]: values } }] });
  await seedSource();

  const { syncOperationalSources } = require('../server/ingestion');
  const r1 = await syncOperationalSources({});
  eq(r1.status, 'SUCCESS', 'first sync status');
  assert(r1.rowsNew === 2, 'two rows ingested, got ' + r1.rowsNew);

  const { col } = require('../server/mongodb');
  const st = await (await col('source_tabs')).findOne({ source_id: 'SRC_HASH', tab_name: TAB });
  assert(st, 'source_tabs row persisted');
  eq(st.content_hash, hashHex(JSON.stringify(values)), 'persisted hash == hash of freshly read values');
  eq(st.row_count, values.filter(row => row.some(c => c !== '' && c != null)).length, 'persisted rowCount == computed rowCount');
  eq(st.last_ingest_status, 'INGESTED', 'ingest status');
});

test('REGRESSION #11: unchanged content is UNCHANGED on re-scan (no re-ingestion loop)', async () => {
  await freshDb();
  const values = fixtureRows();
  installGoogleMock({ files: [{ id: FILE, name: 'Operational Log', tabs: { [TAB]: values } }] });
  await seedSource();

  const { syncOperationalSources } = require('../server/ingestion');
  await syncOperationalSources({});
  const r2 = await syncOperationalSources({}); // identical content
  eq(r2.status, 'SUCCESS', 'second sync status');
  eq(r2.tabsUnchanged, 1, 'second sync: tab classified UNCHANGED');
  eq(r2.rowsNew, 0, 'second sync: zero rows re-ingested');
  eq(r2.rowsUpdated, 0, 'second sync: zero rows rewritten');

  const { col } = require('../server/mongodb');
  const st = await (await col('source_tabs')).findOne({ source_id: 'SRC_HASH', tab_name: TAB });
  eq(st.content_hash, hashHex(JSON.stringify(values)), 'hash still the true fingerprint after SEEN re-persist');
  eq(st.last_ingest_status, 'INGESTED', 'SEEN re-persist does not downgrade INGESTED');

  // Third run: if the bug existed (stale hash persisted), this would flip back
  // to CHANGED. It must stay UNCHANGED.
  const r3 = await syncOperationalSources({});
  eq(r3.tabsUnchanged, 1, 'third sync: still UNCHANGED (no hash thrash)');
  eq(r3.rowsNew, 0, 'third sync: zero rows re-ingested');
});

test('REGRESSION #11: edited content flips to CHANGED and persists the NEW hash', async () => {
  await freshDb();
  const values = fixtureRows();
  const mock = installGoogleMock({ files: [{ id: FILE, name: 'Operational Log', tabs: { [TAB]: values } }] });
  await seedSource();

  const { syncOperationalSources } = require('../server/ingestion');
  await syncOperationalSources({});

  const edited = fixtureRows();
  edited.push(['Ajah BST', '12/10/2026 22:00', '12/10/2026 23:00', '60', 'Power', 'POP']);
  mock.setTab(FILE, TAB, edited);

  const r2 = await syncOperationalSources({});
  eq(r2.status, 'SUCCESS', 'sync after edit');
  eq(r2.tabsUpdated, 1, 'edited tab classified CHANGED');
  eq(r2.rowsNew, 1, 'only the new row is created');

  const { col } = require('../server/mongodb');
  const st = await (await col('source_tabs')).findOne({ source_id: 'SRC_HASH', tab_name: TAB });
  eq(st.content_hash, hashHex(JSON.stringify(edited)), 'persisted hash tracks the new content');
  eq(st.row_count, edited.filter(row => row.some(c => c !== '' && c != null)).length, 'rowCount updated');
});
