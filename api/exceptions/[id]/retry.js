'use strict';
// POST /api/exceptions/:id/retry — mark the exception RETRYING and kick the
// affected period back into the autonomous pipeline (its next run regenerates).
const { allowMethods, fail, json, requireApiKey } = require('../../_lib');
const { col } = require('../../../server/mongodb');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['POST'])) return;
  if (!requireApiKey(req, res)) return;
  try {
    const id = req.query && req.query.id;
    const c = await col('report_exceptions');
    const existing = await c.findOne({ exception_id: id });
    if (!existing) {
      const e = new Error('Unknown exception_id ' + id);
      e.code = 'NOT_FOUND';
      throw e;
    }
    const now = new Date();
    await c.updateOne({ exception_id: id }, { $set: { status: 'RETRYING', last_seen_at: now } });
    if (existing.period_id) {
      await (await col('report_periods')).updateOne(
        { period_id: existing.period_id },
        { $set: { status: 'STALE', updated_at: now } });
    }
    json(res, 200, { ok: true, exception_id: id, status: 'RETRYING' });
  } catch (e) {
    fail(res, e);
  }
};
