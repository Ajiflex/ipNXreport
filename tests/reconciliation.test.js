'use strict';
// Reconciliation ports: incident creation, resumption across tabs, membership
// idempotency, category separation, mapping gate, UNCLASSIFIED handling.
const { test, assert, eq, freshDb } = require('./helpers');

function ev(over) {
  return {
    source_sheet: '05_10_2026', source_block: 'Day', source_row: 4,
    shift_date: new Date(2026, 9, 5), node_name_raw: 'Yaba BST', node_name_normalized: 'YABA BST',
    outage_time: new Date('2026-10-05T02:00:00Z'), restoration_time: null,
    duration_raw_minutes: null, rfo_text: 'Fibre cut', raw_outage_type: 'POP',
    rfo_shared_within_30: 'Yes', status_raw: 'OPEN', fault_owner: 'NOC',
    service_impacting: 'Yes', reporting_officer: 'A', closed_by: '',
    ...over
  };
}

async function seedMappingAndEvents(events) {
  await freshDb();
  const { upsertRawEvents } = require('../server/ingestion');
  const { col } = require('../server/mongodb');
  const { hashHex } = require('../server/lib/hash');
  await (await col('mappings')).insertOne({
    mapping_id: hashHex('NODE_NAME|YABA BST'), mapping_type: 'NODE_NAME',
    source_value_normalized: 'YABA BST', canonical_value: 'yaba', status: 'MAPPED',
    mapped_by: 'test', mapped_at: new Date()
  });
  await upsertRawEvents(events);
}

test('an open outage observed again next day RESUMES one incident (no duplicate)', async () => {
  await seedMappingAndEvents([
    ev({}),
    ev({ source_sheet: '06_10_2026', source_row: 5, shift_date: new Date(2026, 9, 6),
      restoration_time: new Date('2026-10-06T05:00:00Z'), duration_raw_minutes: 1620, status_raw: 'CLOSED' })
  ]);
  const { reconcileEvents } = require('../server/reconciliation');
  const r = await reconcileEvents(new Date(2026, 9, 5), new Date(2026, 9, 11));
  eq(r.incidentsCreated, 1, 'one incident across both observations');
  const { col } = require('../server/mongodb');
  const inc = (await (await col('incidents')).find({}).toArray())[0];
  eq(inc.status, 'CLOSED', 'restoration closes it');
  eq(inc.asset_id, 'yaba', 'mapping applied');
  eq(Number(inc.duration_minutes), 1620, 'duration from raw fallback');
  eq(JSON.parse(inc.raw_refs).length, 2, 'both raw events are members');
  eq(new Date(inc.shift_date).getTime(), new Date(2026, 9, 5).getTime(), 'shift_date = earliest tab date');

  const r2 = await reconcileEvents(new Date(2026, 9, 5), new Date(2026, 9, 11));
  eq(r2.incidentsCreated, 0, 're-run creates nothing (membership idempotency)');
  eq(r2.incidentsChanged, 0, 're-run changes nothing');
});

test('POP and FIBRE events of the same node stay in separate incidents', async () => {
  await seedMappingAndEvents([
    ev({}),
    ev({ raw_outage_type: 'Fibre', source_row: 6 })
  ]);
  const { reconcileEvents } = require('../server/reconciliation');
  const r = await reconcileEvents(new Date(2026, 9, 5), new Date(2026, 9, 11));
  eq(r.incidentsCreated, 2, 'category-aware separation');
  const { col } = require('../server/mongodb');
  const cats = (await (await col('incidents')).find({}).toArray()).map(i => i.network_category).sort();
  eq(cats, ['FIBRE', 'POP'], 'categories');
});

test('blank Outage Type → UNCLASSIFIED, never merged into a real category', async () => {
  await seedMappingAndEvents([ev({ raw_outage_type: '' })]);
  const { reconcileEvents } = require('../server/reconciliation');
  const r = await reconcileEvents(new Date(2026, 9, 5), new Date(2026, 9, 11));
  eq(r.unclassifiedEvents, 1, 'counted');
  const { col } = require('../server/mongodb');
  const inc = (await (await col('incidents')).find({}).toArray())[0];
  eq(inc.network_category, 'UNCLASSIFIED', 'category');
});

test('unmapped node → PENDING_REVIEW queued once; mapping later heals the incident', async () => {
  await freshDb();
  const { upsertRawEvents } = require('../server/ingestion');
  await upsertRawEvents([ev({ node_name_normalized: 'UNKNOWN SITE X', node_name_raw: 'Unknown Site X' })]);
  const { reconcileEvents } = require('../server/reconciliation');
  const r1 = await reconcileEvents(new Date(2026, 9, 5), new Date(2026, 9, 11));
  eq(r1.newUnknownMappings, 1, 'queued once');
  const r2 = await reconcileEvents(new Date(2026, 9, 5), new Date(2026, 9, 11));
  eq(r2.newUnknownMappings, 0, 'not duplicated on re-run');

  const { col } = require('../server/mongodb');
  let inc = (await (await col('incidents')).find({}).toArray())[0];
  eq(inc.asset_id, '', 'gate open: no asset guessed');

  const { setupPlatform } = require('../server/setup');
  await setupPlatform(null); // seeds assets
  const { mapNodeName } = require('../server/mapping');
  const res = await mapNodeName('Unknown Site X', 'yaba', 'operator');
  assert(res.incidentsResolved >= 1, 'mapping heals the open incident');
  inc = (await (await col('incidents')).find({}).toArray())[0];
  eq(inc.asset_id, 'yaba', 'healed');
});

test('missing restoration AND missing duration leaves the incident OPEN (a missing RFO never closes)', async () => {
  await seedMappingAndEvents([ev({})]);
  const { reconcileEvents } = require('../server/reconciliation');
  await reconcileEvents(new Date(2026, 9, 5), new Date(2026, 9, 11));
  const { col } = require('../server/mongodb');
  const inc = (await (await col('incidents')).find({}).toArray())[0];
  eq(inc.status, 'OPEN', 'still open');
  eq(inc.end_time, null, 'no end time');
  eq(inc.duration_minutes, null, 'no duration');
});
