'use strict';
// GET /api/reports — the report library (archived periods), newest first.
const { allowMethods, fail, json } = require('../_lib');
const { listArchivedReports } = require('../../server/archive');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const reports = (await listArchivedReports())
      .map(({ _id, _k, ...r }) => r);
    json(res, 200, { ok: true, reports });
  } catch (e) {
    fail(res, e);
  }
};
