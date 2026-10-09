'use strict';
// POP module tests: the 57-POP master shape, availability math, SLA/poor
// thresholds from SYSTEM_CONFIG (never hard-coded), narrative candidates.
const { test, assert, eq, freshDb } = require('./helpers');

const START = new Date(2026, 9, 5), END = new Date(2026, 9, 11);

async function seededDb() {
  await freshDb();
  const { setupPlatform } = require('../server/setup');
  await setupPlatform(null);
  const { col } = require('../server/mongodb');
  const cfg = await (await col('config')).findOne({ report_type: 'POP_AVAILABILITY' });
  return cfg;
}

test('setup seeds exactly 57 POPs: IHS 30, ipNX 8, Others 19', async () => {
  await seededDb();
  const { validateTemplate } = require('../server/reporting/popAvailability');
  const v = await validateTemplate();
  eq(v.ok, true, 'template validation: ' + v.errors.join('; '));
  eq(v.siteRows, 57, '57 POPs');
});

test('setup is idempotent (re-run seeds nothing twice)', async () => {
  await freshDb();
  const { setupPlatform } = require('../server/setup');
  const r1 = await setupPlatform(null);
  eq(r1.assets.created, 57, 'first setup creates 57 assets');
  const r2 = await setupPlatform(null);
  eq(r2.assets.created, 0, 'second setup creates nothing');
  const { col } = require('../server/mongodb');
  eq((await (await col('assets')).find({}).toArray()).length, 57, 'still 57');
});

test('availability math: downtime, SLA and poor-performing from SYSTEM_CONFIG', async () => {
  const cfg = await seededDb();
  const { col } = require('../server/mongodb');
  const now = new Date();
  // 180 min outage on yaba; 10080-180 → 98.2142…% → BELOW 0.9999 SLA and < 0.9900 poor threshold.
  await (await col('incidents')).insertOne({
    incident_id: 'INC-TEST1', asset_id: 'yaba', node_name_normalized: 'YABA BST',
    raw_outage_type: 'POP', network_category: 'POP', shift_date: new Date(2026, 9, 6),
    start_time: new Date('2026-10-06T02:00:00Z'), end_time: new Date('2026-10-06T05:00:00Z'),
    duration_minutes: 180, status: 'CLOSED', rfo_text: 'Fibre cut at mile 2',
    issue_text: '', resolution_text: '', raw_refs: '[]', created_at: now, updated_at: now
  });
  const { calculate } = require('../server/reporting/popAvailability');
  const calc = await calculate(START, END, cfg, { persistNarratives: true });
  eq(calc.perAsset.length, 57, 'all 57 POPs represented');
  const yaba = calc.perAsset.find(a => a.asset_id === 'yaba');
  eq(yaba.total_downtime_minutes, 180, 'downtime');
  eq(yaba.availability_pct, Math.round((10080 - 180) / 10080 * 10000) / 100, 'availability pct');
  eq(yaba.sla_status, 'BELOW_SLA', 'below 99.99%');
  eq(yaba.poor_performing, true, 'below 99.00% poor threshold');
  const clean = calc.perAsset.find(a => a.asset_id === 'kenaz');
  eq(clean.availability_pct, 100, 'zero downtime → 100%');
  eq(clean.sla_status, 'WITHIN_SLA', 'within SLA');
  eq(clean.poor_performing, false, 'not poor');
  eq(calc.needsNarrativeReview, true, 'poor performers trigger review flag');
  // summary
  const ihs = calc.summary.find(s => s.provider_group === 'IHS');
  eq(ihs.total_sites, 30, 'IHS group total');
  // narrative candidate: largest incident's own RFO fills BLANK fields only
  const { col: col2 } = require('../server/mongodb');
  const inc = await (await col2('incidents')).findOne({ incident_id: 'INC-TEST1' });
  eq(inc.issue_text, 'Fibre cut at mile 2', 'issue narrative = own RFO');
  eq(inc.resolution_text, 'Fibre cut at mile 2', 'resolution narrative = own RFO');
});

test('threshold independence: poor threshold is NOT sla_target', async () => {
  const cfg = await seededDb();
  // 60 min downtime → 99.4048% — below SLA (99.99) but above poor (99.00).
  const { col } = require('../server/mongodb');
  await (await col('incidents')).insertOne({
    incident_id: 'INC-TEST2', asset_id: 'kenaz', node_name_normalized: 'KENAZ BST',
    raw_outage_type: 'POP', network_category: 'POP', shift_date: new Date(2026, 9, 7),
    start_time: new Date('2026-10-07T02:00:00Z'), end_time: new Date('2026-10-07T03:00:00Z'),
    duration_minutes: 60, status: 'CLOSED', rfo_text: 'Power',
    issue_text: '', resolution_text: '', raw_refs: '[]', created_at: new Date(), updated_at: new Date()
  });
  const { calculate } = require('../server/reporting/popAvailability');
  const calc = await calculate(START, END, cfg, { persistNarratives: false });
  const kenaz = calc.perAsset.find(a => a.asset_id === 'kenaz');
  eq(kenaz.sla_status, 'BELOW_SLA', 'below SLA');
  eq(kenaz.poor_performing, false, 'but NOT poor-performing (independent threshold)');
});

test('out-of-range and non-POP incidents do not count; OPEN downtime not counted', async () => {
  const cfg = await seededDb();
  const { col } = require('../server/mongodb');
  const now = new Date();
  await (await col('incidents')).insertMany([
    { incident_id: 'INC-OUT', asset_id: 'yaba', node_name_normalized: 'YABA BST', raw_outage_type: 'POP',
      network_category: 'POP', shift_date: new Date(2026, 8, 20), start_time: new Date('2026-09-20T02:00:00Z'),
      end_time: new Date('2026-09-20T05:00:00Z'), duration_minutes: 180, status: 'CLOSED', rfo_text: '',
      issue_text: '', resolution_text: '', raw_refs: '[]', created_at: now, updated_at: now },
    { incident_id: 'INC-FIBRE', asset_id: 'yaba', node_name_normalized: 'YABA BST', raw_outage_type: 'Fibre',
      network_category: 'FIBRE', shift_date: new Date(2026, 9, 6), start_time: new Date('2026-10-06T02:00:00Z'),
      end_time: new Date('2026-10-06T05:00:00Z'), duration_minutes: 180, status: 'CLOSED', rfo_text: '',
      issue_text: '', resolution_text: '', raw_refs: '[]', created_at: now, updated_at: now },
    { incident_id: 'INC-OPEN', asset_id: 'yaba', node_name_normalized: 'YABA BST', raw_outage_type: 'POP',
      network_category: 'POP', shift_date: new Date(2026, 9, 6), start_time: new Date('2026-10-06T02:00:00Z'),
      end_time: null, duration_minutes: null, status: 'OPEN', rfo_text: '',
      issue_text: '', resolution_text: '', raw_refs: '[]', created_at: now, updated_at: now }
  ]);
  const { calculate } = require('../server/reporting/popAvailability');
  const calc = await calculate(START, END, cfg, { persistNarratives: false });
  const yaba = calc.perAsset.find(a => a.asset_id === 'yaba');
  eq(yaba.total_downtime_minutes, 0, 'out-of-range, non-POP and OPEN contribute nothing');
  assert(calc.warnings.some(w => /still OPEN/.test(w)), 'OPEN warning surfaced');
});
