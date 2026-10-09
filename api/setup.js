'use strict';
// POST /api/setup — one-time idempotent seed: SYSTEM_CONFIG, the 57-POP master,
// mapping seeds, and (optionally) the connected operational sheet as a
// MANUAL_CONNECT source. Safe to re-run (insert-only).
const { allowMethods, fail, json, requireApiKey } = require('./_lib');
const { setupPlatform } = require('../server/setup');
const { authorizedClient } = require('../server/google/auth');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['POST'])) return;
  if (!requireApiKey(req, res)) return;
  try {
    let auth = null;
    try { auth = await authorizedClient(); } catch { auth = null; } // setup still seeds without Google
    const result = await setupPlatform(auth);
    json(res, 200, { ok: true, setup: result });
  } catch (e) {
    fail(res, e);
  }
};
