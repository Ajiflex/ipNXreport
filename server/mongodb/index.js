'use strict';
// Serverless-safe MongoDB access (replaces the ds_* helpers of 03_Datastore.gs).
// Serverless rule: NEVER create a new connection per request — the standard
// Vercel/MongoDB cached-connection pattern is used here.
//
// Tests: the suite injects an in-memory adapter via _setTestProvider() so the
// entire server stack runs without a real MongoDB deployment.
const { config, COLLECTIONS } = require('../config');

let cached = null;
let testProvider = null; // { client, db } injected by tests only

function _setTestProvider(provider) {
  testProvider = provider;
  cached = null;
}

async function connect() {
  if (testProvider) return testProvider;
  if (cached) return cached;
  const { MongoClient } = require('mongodb');
  const cfg = config();
  const client = new MongoClient(cfg.mongoUri, { maxPoolSize: 10 });
  await client.connect();
  cached = { client, db: client.db(cfg.mongoDb) };
  return cached;
}

async function db() { return (await connect()).db; }
async function col(name) { return (await connect()).db.collection(name); }

// One-time index creation; createIndexes is idempotent.
async function ensureIndexes() {
  const d = await db();
  const mk = (c, spec, opts) => d.collection(c).createIndexes([{ key: spec, ...(opts || {}) }]);
  await mk(COLLECTIONS.SOURCES, { source_id: 1 }, { unique: true });
  await mk(COLLECTIONS.SOURCES, { drive_file_id: 1 });
  await mk(COLLECTIONS.SOURCES, { status: 1 });
  await mk(COLLECTIONS.SOURCE_TABS, { source_id: 1, tab_name: 1 }, { unique: true });
  await mk(COLLECTIONS.SOURCE_TABS, { tab_date: 1 });
  await mk(COLLECTIONS.SOURCE_TABS, { content_hash: 1 });
  await mk(COLLECTIONS.RAW_EVENTS, { raw_id: 1 }, { unique: true });
  await mk(COLLECTIONS.RAW_EVENTS, { source_sheet: 1 });
  await mk(COLLECTIONS.RAW_EVENTS, { node_name_normalized: 1 });
  await mk(COLLECTIONS.INCIDENTS, { incident_id: 1 }, { unique: true });
  await mk(COLLECTIONS.INCIDENTS, { network_category: 1, shift_date: 1 });
  await mk(COLLECTIONS.INCIDENTS, { asset_id: 1 });
  await mk(COLLECTIONS.MAPPINGS, { mapping_id: 1 }, { unique: true });
  await mk(COLLECTIONS.ASSETS, { asset_id: 1 }, { unique: true });
  await mk('reports', { report_id: 1 }, { unique: true });
  await mk('report_periods', { period_id: 1 }, { unique: true });
  await mk('report_periods', { report_type: 1, period_start: 1, period_end: 1 });
  await mk('report_periods', { status: 1 });
  await mk('weekly_results', { period_id: 1, asset_id: 1 });
  await mk(COLLECTIONS.REPORT_ARCHIVE, { period_id: 1 }, { unique: true });
  await mk(COLLECTIONS.REPORT_EXCEPTIONS, { exception_id: 1 }, { unique: true });
  await mk(COLLECTIONS.REPORT_EXCEPTIONS, { status: 1 });
  await mk(COLLECTIONS.SYNC_RUNS, { run_id: 1 }, { unique: true });
  await mk(COLLECTIONS.SYNC_RUNS, { started_at: -1 });
  await mk(COLLECTIONS.SYNC_RUNS, { status: 1 });
  await mk(COLLECTIONS.INGESTION_LOG, { run_id: 1 });
  await mk(COLLECTIONS.TOKENS, { key: 1 }, { unique: true });
  await mk(COLLECTIONS.LOCKS, { name: 1 }, { unique: true });
}

// ← dsUpsertMany_: bulk upsert keyed on keyFn; mergeFn(existing, incoming)
// decides the stored record; returns { created, updated }.
async function upsertMany(collection, keyFn, objs, mergeFn) {
  if (!objs.length) return { created: 0, updated: 0 };
  const c = await col(collection);
  let created = 0, updated = 0;
  const bulk = c.initializeUnorderedBulkOp();
  const keys = objs.map(keyFn);
  const existing = new Map();
  (await c.find({ _k: { $in: keys } }).toArray())
    .forEach(r => existing.set(r._k, r));
  for (const obj of objs) {
    const k = keyFn(obj);
    const doc = { ...obj, _k: k };
    if (existing.has(k)) {
      const merged = mergeFn ? mergeFn(existing.get(k), doc) : doc;
      const { _id, ...setDoc } = { ...merged, _k: k };
      bulk.find({ _k: k }).updateOne({ $set: setDoc });
      updated++;
    } else {
      bulk.insert(doc);
      created++;
    }
  }
  if (created || updated) await bulk.execute();
  return { created, updated };
}

// ← dsReplaceGroup_: regeneration REPLACES a period's rows, never appends.
async function replaceGroup(collection, groupCol, groupValue, newObjs) {
  const c = await col(collection);
  await c.deleteMany({ [groupCol]: groupValue });
  if (newObjs.length) {
    await c.insertMany(newObjs.map(o => ({ ...o, [groupCol]: groupValue })));
  }
}

module.exports = { connect, db, col, ensureIndexes, upsertMany, replaceGroup, _setTestProvider };
