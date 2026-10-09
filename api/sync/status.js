'use strict';
// GET /api/sync/status — latest sync_runs plus per-source/tab state.
const { allowMethods, fail, json } = require('../_lib');
const { col } = require('../../server/mongodb');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const runs = (await (await col('sync_runs')).find({}).toArray())
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
      .slice(0, 10)
      .map(({ _id, _k, ...r }) => r);
    const tabs = (await (await col('source_tabs')).find({}).toArray())
      .map(({ _id, _k, ...t }) => t);
    json(res, 200, { ok: true, runs, tabs });
  } catch (e) {
    fail(res, e);
  }
};
