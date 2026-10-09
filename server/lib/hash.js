'use strict';
// ← deterministic-ID primitives from 03_Datastore.gs.
const crypto = require('crypto');

// ← hashHex_: MD5 hex — the platform's deterministic-id primitive.
function hashHex(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex');
}

const pad2 = n => (n < 10 ? '0' : '') + n;
const monthKey = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1);

const TAB_NAME_PATTERN = /^(\d{2})_(\d{2})_(\d{4})$/; // DD_MM_YYYY — unchanged

function tabDateFromName(name) {
  const m = String(name).match(TAB_NAME_PATTERN);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// yyyyMMdd in the platform timezone (Africa/Lagos for ipNX).
function formatDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Africa/Lagos' })
    .replace(/-/g, '');
}

// ← periodId_: TYPE_YYYYMMDD_YYYYMMDD
function periodId(reportType, startDate, endDate) {
  return reportType + '_' + formatDate(startDate) + '_' + formatDate(endDate);
}

// ← normalizeNodeName_: NBSP fold, whitespace collapse, upper-case.
function normalizeNodeName(raw) {
  return String(raw).replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

module.exports = {
  hashHex, pad2, monthKey, tabDateFromName, stripTime, formatDate, periodId,
  normalizeNodeName, TAB_NAME_PATTERN
};
