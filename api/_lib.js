'use strict';
// Shared API helpers — every route handler uses these.
// Error shape: { ok: false, error: { code, message } } — no secrets, no stack traces.
const { config } = require('../server/config');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// Explicit method checks — unsupported methods return a JSON 405 + Allow header.
function allowMethods(req, res, methods) {
  if (!methods.includes(req.method)) {
    res.statusCode = 405;
    res.setHeader('Allow', methods.join(', '));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${methods.join('/')}` }
    }));
    return false;
  }
  return true;
}

// Optional internal-access gate: when APP_API_KEY is set, mutating APIs require
// the X-Api-Key header.
function requireApiKey(req, res) {
  let key = '';
  try { key = config().appApiKey; } catch { key = process.env.APP_API_KEY || ''; }
  if (!key) return true; // gate disabled
  if ((req.headers['x-api-key'] || '') === key) return true;
  json(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing X-Api-Key' } });
  return false;
}

// Uniform error responder — internal detail stays server-side.
function fail(res, e, status) {
  const code = e && e.code ? e.code : 'INTERNAL';
  const http = status || (code === 'NOT_FOUND' ? 404 : code === 'GOOGLE_NOT_CONNECTED' ? 428 : 500);
  json(res, http, {
    ok: false,
    error: { code, message: String((e && e.publicMessage) || (e && e.message) || e) }
  });
}

module.exports = { json, allowMethods, requireApiKey, fail };
