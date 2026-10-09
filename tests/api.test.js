'use strict';
// API tests: every route's method contract (JSON 405), auth gates, happy paths
// through the full pipeline with mocked Google + in-memory Mongo.
const { test, assert, eq, freshDb, makeReq, makeRes, makeOutageTab } = require('./helpers');
const { installGoogleMock } = require('./mocks/google');

const FILE = 'FILE_API';
const START = new Date(2026, 9, 5), END = new Date(2026, 9, 11);

function weekTabs() {
  const tabs = {};
  ['05/10/2026', '06/10/2026', '07/10/2026', '08/10/2026', '09/10/2026', '10/10/2026', '11/10/2026'].forEach(d => {
    tabs[d.replace(/\//g, '_')] = makeOutageTab(d, d === '06/10/2026'
      ? [['Yaba BST', '06/10/2026 02:00', '06/10/2026 05:00', '180', 'Fibre cut', 'POP']]
      : []);
  });
  return tabs;
}

async function provision() {
  await freshDb();
  installGoogleMock({ files: [{ id: FILE, name: 'Operational Log', tabs: weekTabs() }] });
  const { col } = require('../server/mongodb');
  await (await col('sources')).insertOne({
    source_id: 'SRC_API', drive_file_id: FILE, spreadsheet_id: FILE, name: 'Operational Log',
    status: 'ACTIVE', discovery_method: 'MANUAL_CONNECT', last_modified_time: '2026-10-12T00:00:00.000Z'
  });
  const { setupPlatform } = require('../server/setup');
  await setupPlatform(null);
  const { saveTokens } = require('../server/google/auth');
  await saveTokens({ refresh_token: 'r', access_token: 'a', expiry_date: Date.now() + 3600000 });
}

test('405 contract: wrong method on every route returns a JSON 405 + Allow', async () => {
  await freshDb();
  installGoogleMock({});
  const routes = [
    ['../api/bootstrap', 'POST'], ['../api/setup', 'GET'], ['../api/sources', 'DELETE'],
    ['../api/sync/status', 'POST'], ['../api/sync/run', 'GET'], ['../api/reports/index', 'POST'],
    ['../api/reports/[id]/index', 'POST'], ['../api/reports/[id]/download', 'POST'],
    ['../api/exceptions', 'PUT'], ['../api/exceptions/[id]/retry', 'GET'],
    ['../api/mappings', 'DELETE'], ['../api/auth/google/index', 'POST'],
    ['../api/auth/google/callback', 'POST'], ['../api/cron/hourly', 'DELETE']
  ];
  for (const [path, method] of routes) {
    const handler = require(path);
    const res = makeRes();
    await handler(makeReq({ method, query: { id: 'x' } }), res);
    eq(res.statusCode, 405, path + ' with ' + method + ' → 405');
    const body = res.json();
    eq(body.ok, false, path + ' JSON error body');
    eq(body.error.code, 'METHOD_NOT_ALLOWED', path + ' error code');
    assert(res.headers.allow, path + ' Allow header present');
  }
});

test('cron: missing/invalid secret → 401; valid secret runs the full pipeline', async () => {
  await provision();
  const handler = require('../api/cron/hourly');
  let res = makeRes();
  await handler(makeReq({ method: 'POST', headers: { authorization: 'Bearer wrong' } }), res);
  eq(res.statusCode, 401, 'bad secret rejected');
  eq(res.json().error.code, 'UNAUTHORIZED', 'error code');

  res = makeRes();
  await handler(makeReq({ method: 'GET', headers: { authorization: 'Bearer test-cron-secret' } }), res);
  eq(res.statusCode, 200, 'cron accepted (Vercel issues GET)');
  const body = res.json();
  eq(body.ok, true, 'run ok');
  eq(body.sync.status, 'SUCCESS', 'sync succeeded');

  const { col } = require('../server/mongodb');
  const runs = await (await col('sync_runs')).find({}).toArray();
  eq(runs.length, 1, 'sync run recorded');
  eq(runs[0].trigger, 'cron', 'trigger recorded');
  assert(runs[0].eventsIngested >= 1, 'events ingested');
});

test('bootstrap: connection state + counts + exceptions', async () => {
  await provision();
  const handler = require('../api/bootstrap');
  const res = makeRes();
  await handler(makeReq({}), res);
  eq(res.statusCode, 200, 'ok');
  const body = res.json();
  eq(body.ok, true, 'ok flag');
  eq(body.google.connected, true, 'google connected');
  eq(body.counts.sources, 1, 'one active source');
});

test('reports API: library, single report 404, download streams verified XLSX', async () => {
  await provision();
  const { generateReport, finalizeReport } = require('../server/reporting');
  await generateReport('POP_AVAILABILITY', START, END, {});
  const fin = await finalizeReport('POP_AVAILABILITY', START, END, {});
  eq(fin.status, 'GENERATED', 'finalized');
  const pid = 'POP_AVAILABILITY_20261005_20261011';

  const list = require('../api/reports/index');
  let res = makeRes();
  await list(makeReq({}), res);
  eq(res.statusCode, 200, 'library ok');
  eq(res.json().reports.length, 1, 'one report');
  eq(res.json().reports[0].period_id, pid, 'period id');

  const one = require('../api/reports/[id]/index');
  res = makeRes();
  await one(makeReq({ query: { id: pid } }), res);
  eq(res.statusCode, 200, 'single report ok');
  res = makeRes();
  await one(makeReq({ query: { id: 'POP_AVAILABILITY_19990101_19990107' } }), res);
  eq(res.statusCode, 404, 'unknown report → 404');
  eq(res.json().error.code, 'NOT_FOUND', 'error code');

  const dl = require('../api/reports/[id]/download');
  res = makeRes();
  await dl(makeReq({ query: { id: pid } }), res);
  eq(res.statusCode, 200, 'download ok');
  const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
  assert(buf[0] === 0x50 && buf[1] === 0x4b, 'streamed bytes are a real XLSX');
  eq(res.headers['content-disposition'], 'attachment; filename="' + fin.fileName + '"', 'attachment header');
});

test('mappings API: GET pending, POST validates body, maps + heals, unknown asset rejected', async () => {
  await provision();
  const { upsertRawEvents } = require('../server/ingestion');
  const { reconcileEvents } = require('../server/reconciliation');
  await upsertRawEvents([{
    source_sheet: '06_10_2026', source_block: 'Day', source_row: 9, shift_date: new Date(2026, 9, 6),
    node_name_raw: 'Mystery Node', node_name_normalized: 'MYSTERY NODE',
    outage_time: new Date('2026-10-06T04:00:00Z'), restoration_time: new Date('2026-10-06T05:00:00Z'),
    duration_raw_minutes: 60, rfo_text: 'x', raw_outage_type: 'POP',
    rfo_shared_within_30: '', status_raw: 'CLOSED', fault_owner: '', service_impacting: '',
    reporting_officer: '', closed_by: ''
  }]);
  await reconcileEvents(START, END);

  const handler = require('../api/mappings');
  let res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  eq(res.statusCode, 200, 'GET ok');
  assert(res.json().pending.includes('MYSTERY NODE'), 'pending listed');
  eq(res.json().assets.length, 57, 'assets offered');

  res = makeRes();
  await handler(makeReq({ method: 'POST', body: {} }), res);
  eq(res.statusCode, 400, 'empty body → 400');

  res = makeRes();
  await handler(makeReq({ method: 'POST', body: { source: 'Mystery Node', assetId: 'no_such_asset' } }), res);
  eq(res.statusCode, 500, 'unknown asset rejected');
  assert(/unknown asset_id/.test(res.json().error.message), 'clear error');

  res = makeRes();
  await handler(makeReq({ method: 'POST', body: { source: 'Mystery Node', assetId: 'kenaz' } }), res);
  eq(res.statusCode, 200, 'mapped');
  eq(res.json().incidentsResolved, 1, 'incident healed');
  const { col } = require('../server/mongodb');
  const inc = await (await col('incidents')).findOne({ node_name_normalized: 'MYSTERY NODE' });
  eq(inc.asset_id, 'kenaz', 'healed in store');
});

test('exceptions API: list + retry flips to RETRYING and stales the period', async () => {
  await provision();
  const { col } = require('../server/mongodb');
  await (await col('report_exceptions')).insertOne({
    exception_id: 'EXC1', report_type: 'POP_AVAILABILITY', period_id: 'POP_AVAILABILITY_20261005_20261011',
    period_start: START, period_end: END, exception_type: 'UNKNOWN_MAPPING', message: 'x',
    status: 'OPEN', first_seen_at: new Date(), last_seen_at: new Date(), resolved_at: null
  });
  await (await col('report_periods')).insertOne({
    period_id: 'POP_AVAILABILITY_20261005_20261011', report_type: 'POP_AVAILABILITY',
    period_start: START, period_end: END, period_minutes: 10080, status: 'PENDING_EXCEPTION',
    data_completeness: 'NONE', data_version: '', updated_at: new Date()
  });

  const list = require('../api/exceptions');
  let res = makeRes();
  await list(makeReq({}), res);
  eq(res.statusCode, 200, 'list ok');
  eq(res.json().exceptions.length, 1, 'one exception');

  const retry = require('../api/exceptions/[id]/retry');
  res = makeRes();
  await retry(makeReq({ method: 'POST', query: { id: 'nope' } }), res);
  eq(res.statusCode, 404, 'unknown exception → 404');
  res = makeRes();
  await retry(makeReq({ method: 'POST', query: { id: 'EXC1' } }), res);
  eq(res.statusCode, 200, 'retry ok');
  eq(res.json().status, 'RETRYING', 'status');
  const period = await (await col('report_periods')).findOne({ period_id: 'POP_AVAILABILITY_20261005_20261011' });
  eq(period.status, 'STALE', 'period staled for regeneration');
});

test('auth routes: /api/auth/google redirects; callback stores an encrypted token', async () => {
  await freshDb();
  installGoogleMock({});
  const start = require('../api/auth/google/index');
  let res = makeRes();
  await start(makeReq({}), res);
  eq(res.statusCode, 302, 'redirect');
  assert(/^https:\/\/accounts\.google\.mock/.test(res.headers.location), 'google URL');

  const cb = require('../api/auth/google/callback');
  res = makeRes();
  await cb(makeReq({ query: {} }), res);
  eq(res.statusCode, 400, 'missing code → 400');
  res = makeRes();
  await cb(makeReq({ query: { code: 'abc' } }), res);
  eq(res.statusCode, 302, 'callback redirects to dashboard');

  const { col } = require('../server/mongodb');
  const row = await (await col('tokens')).findOne({ key: 'google' });
  assert(row && row.refresh_token, 'refresh token stored');
  assert(row.refresh_token.indexOf('mock_refresh_abc') === -1, 'token is AES-encrypted, not plaintext');

  const { isConnected, authorizedClient } = require('../server/google/auth');
  eq(await isConnected(), true, 'connected');
  const client = await authorizedClient();
  eq(client.credentials.refresh_token, 'mock_refresh_abc', 'decrypts back to the real token');
});
