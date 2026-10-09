'use strict';
// GET /api/reports/:id — one archived report by period_id.
const { allowMethods, fail, json } = require('../../_lib');
const { col } = require('../../../server/mongodb');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const id = req.query && req.query.id;
    const r = await (await col('report_archive')).findOne({ period_id: id });
    if (!r) {
      const e = new Error('No archived report for period ' + id);
      e.code = 'NOT_FOUND';
      throw e;
    }
    const { _id, _k, ...report } = r;
    report.superseded_file_ids = JSON.parse(r.superseded_file_ids || '[]');
    json(res, 200, { ok: true, report });
  } catch (e) {
    fail(res, e);
  }
};
