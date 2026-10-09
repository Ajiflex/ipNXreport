'use strict';
// GET /api/auth/google — start the OAuth flow (302 redirect to Google).
const { allowMethods, fail } = require('../../_lib');
const { authorizationUrl } = require('../../../server/google/auth');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    res.statusCode = 302;
    res.setHeader('Location', authorizationUrl());
    res.end();
  } catch (e) {
    fail(res, e);
  }
};
