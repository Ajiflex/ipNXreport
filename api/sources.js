'use strict';
// GET /api/sources — the SOURCES registry with per-source tab counts.
const { allowMethods, fail, json } = require('./_lib');
const { col } = require('../server/mongodb');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const sources = (await (await col('sources')).find({}).toArray())
      .map(({ _id, _k, ...s }) => s);
    const tabs = await (await col('source_tabs')).find({}).toArray();
    const tabCount = {};
    tabs.forEach(t => { tabCount[t.source_id] = (tabCount[t.source_id] || 0) + 1; });
    sources.forEach(s => { s.tab_count = tabCount[s.source_id] || 0; });
    json(res, 200, { ok: true, sources });
  } catch (e) {
    fail(res, e);
  }
};
