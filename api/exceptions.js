'use strict';
// GET /api/exceptions — the PENDING/OPEN exception queue.
const { allowMethods, fail, json } = require('./_lib');
const { col } = require('../server/mongodb');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const exceptions = (await (await col('report_exceptions')).find({}).toArray())
      .sort((a, b) => new Date(b.last_seen_at || b.created_at || 0) - new Date(a.last_seen_at || a.created_at || 0))
      .map(({ _id, _k, ...x }) => x);
    json(res, 200, { ok: true, exceptions });
  } catch (e) {
    fail(res, e);
  }
};
