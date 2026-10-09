'use strict';
// GET  /api/mappings — PENDING_REVIEW node names + current NODE_NAME mappings.
// POST /api/mappings — map a node name to an asset; heals affected incidents
//                      immediately.
const { allowMethods, fail, json, requireApiKey } = require('./_lib');
const { col } = require('../server/mongodb');
const { getUnknownNodeNames, mapNodeName } = require('../server/mapping');

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    try {
      const pending = await getUnknownNodeNames();
      const mappings = (await (await col('mappings'))
        .find({ mapping_type: 'NODE_NAME' }).toArray())
        .map(({ _id, _k, ...m }) => m);
      const assets = (await (await col('assets')).find({ active: true }).toArray())
        .map(({ _id, _k, ...a }) => a);
      return json(res, 200, { ok: true, pending, mappings, assets });
    } catch (e) {
      return fail(res, e);
    }
  }
  if (req.method === 'POST') {
    if (!requireApiKey(req, res)) return;
    try {
      const body = req.body || {};
      if (!body.source || !body.assetId) {
        return json(res, 400, {
          ok: false,
          error: { code: 'BAD_REQUEST', message: 'Body must include { source, assetId }' }
        });
      }
      const result = await mapNodeName(body.source, body.assetId, body.mappedBy || 'operator');
      // Mapping a node can unblock a waiting period — mark it stale so the next
      // autonomous run regenerates it.
      try {
        const { markReportPeriodsStale } = require('../server/autonomous');
        const affected = (await (await col('incidents'))
          .find({ node_name_normalized: String(body.source).trim().toUpperCase() }).toArray())
          .map(i => i.shift_date).filter(Boolean);
        await markReportPeriodsStale(affected);
      } catch { /* non-fatal: the hourly watermark also catches it */ }
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      return fail(res, e);
    }
  }
  return allowMethods(req, res, ['GET', 'POST']); // emits the JSON 405
};
