'use strict';
// Test harness: env setup, fresh in-memory DB, mock req/res, tiny assert kit.
const crypto = require('crypto');

function setupEnv() {
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://memory.invalid:27017';
  process.env.MONGODB_DB_NAME = 'ipnx_report_test';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.GOOGLE_ARCHIVE_FOLDER_ID = 'ARCHIVE_FOLDER';
  delete process.env.OPERATIONAL_SHEET_ID;
  delete process.env.GOOGLE_OPERATIONAL_FOLDER_ID;
  delete process.env.APP_API_KEY;
}

async function freshDb() {
  const { createMemoryMongo } = require('./memory_mongo');
  const mongodb = require('../server/mongodb');
  mongodb._setTestProvider(createMemoryMongo());
  return mongodb;
}

// --- tiny framework ---
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`ASSERT EQ FAILED: ${msg || ''}\n  expected: ${e}\n  actual:   ${a}`);
}
async function throws(fn, re, msg) {
  try { await fn(); } catch (e) {
    if (re && !re.test(String(e.message || e))) {
      throw new Error(`ASSERT THROWS FAILED: ${msg || ''} — wrong error: ${e.message}`);
    }
    return e;
  }
  throw new Error('ASSERT THROWS FAILED: ' + (msg || '') + ' — nothing thrown');
}

async function run() {
  let pass = 0, failCount = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log('  PASS  ' + t.name);
    } catch (e) {
      failCount++;
      failures.push({ name: t.name, error: e });
      console.log('  FAIL  ' + t.name);
      console.log('        ' + String(e.stack || e).split('\n').slice(0, 4).join('\n        '));
    }
  }
  console.log('');
  console.log(`RESULT: ${pass} passed, ${failCount} failed, ${tests.length} total`);
  return { pass, fail: failCount, total: tests.length, failures };
}

// --- mock req/res for API handler tests ---
function makeReq(opts) {
  return {
    method: (opts && opts.method) || 'GET',
    headers: (opts && opts.headers) || {},
    query: (opts && opts.query) || {},
    body: (opts && opts.body) || undefined
  };
}
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(data) { this.body = data; },
    json() { return typeof this.body === 'string' ? JSON.parse(this.body) : this.body; }
  };
  return res;
}

// A well-formed outage tab: Day block + header + given rows.
// rows: [nodeName, outageTime, restorationTime, duration, rfo, outageType]
function makeOutageTab(dateLabel, rows) {
  const values = [
    ['ipNX NOC DAILY OUTAGE LOG'],
    ['Day ' + dateLabel],
    ['S/N', 'NODE NAME', 'OUTAGE TIME', 'RESTORATION TIME', 'DURATION', 'RFO',
      'Outage Type', 'RFO shared within 30 mins', 'STATUS', 'FAULT OWNER',
      'SERVICE IMPACTING', 'REPORTING OFFICER', 'CLOSED BY']
  ];
  rows.forEach((r, i) => {
    values.push([
      String(i + 1), r[0], r[1] || '', r[2] || '', r[3] || '', r[4] || '',
      r[5] || '', 'Yes', r[2] ? 'CLOSED' : 'OPEN', 'NOC', 'Yes', 'Officer A', r[2] ? 'Officer B' : ''
    ]);
  });
  return values;
}

module.exports = { setupEnv, freshDb, test, assert, eq, throws, run, makeReq, makeRes, makeOutageTab };
