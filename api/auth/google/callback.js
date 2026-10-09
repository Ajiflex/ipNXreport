'use strict';
// GET /api/auth/google/callback — OAuth redirect target. Exchanges the code,
// stores the AES-encrypted refresh token, then redirects to the dashboard.
const { allowMethods, fail } = require('../../_lib');
const { oauth2Client, saveTokens } = require('../../../server/google/auth');
const { config } = require('../../../server/config');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const code = (req.query && req.query.code) || '';
    if (!code) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'Missing OAuth code' } }));
      return;
    }
    const { tokens } = await oauth2Client().getToken(code);
    if (!tokens.refresh_token) {
      const e = new Error('Google did not return a refresh token — re-authorize with consent prompt.');
      e.code = 'NO_REFRESH_TOKEN';
      throw e;
    }
    await saveTokens(tokens);
    const base = config().appBaseUrl || '/';
    res.statusCode = 302;
    res.setHeader('Location', base + (base.includes('?') ? '&' : '?') + 'connected=1');
    res.end();
  } catch (e) {
    fail(res, e);
  }
};
