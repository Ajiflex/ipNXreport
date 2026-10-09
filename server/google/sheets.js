'use strict';
// ← 02_RowReader.gs — readSourceTab, full port.
// Header-text-mapped columns (never fixed indices); content hash = MD5 of the
// full getValues() JSON; rowCount = non-empty rows; shift_date = the TAB's date.
const { hashHex, normalizeNodeName } = require('../lib/hash');

const KNOWN_HEADERS = ['S/N', 'NODE NAME', 'OUTAGE TIME', 'RESTORATION TIME', 'DURATION', 'RFO',
  'Outage Type', 'RFO shared within 30 mins', 'STATUS', 'FAULT OWNER',
  'SERVICE IMPACTING', 'REPORTING OFFICER', 'CLOSED BY']; // unchanged

function parseSheetDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const toNumberOrNull = v => (v === null || v === '' || v === undefined || isNaN(v)) ? null : Number(v);

// values come from sheets.spreadsheets.values.get (FORMATTED_VALUE strings).
// tabEntry gains contentHash + rowCount — the ACTUAL computed fingerprint.
async function readSourceTab(sheets, tabEntry) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: tabEntry.spreadsheetId,
    range: `'${tabEntry.tabName}'`,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  const values = r.data.values || [];
  tabEntry.contentHash = hashHex(JSON.stringify(values)); // ← computed HERE
  tabEntry.rowCount = values.filter(row => row.some(c => c !== '' && c != null)).length;

  const records = [];
  let currentBlock = null, headerMap = null;
  for (let ri = 0; ri < values.length; ri++) {
    const row = values[ri];
    const rowText = row.join(' ');
    if (/^Day \d{2}\/\d{2}\/\d{4}/.test(rowText)) { currentBlock = 'Day'; headerMap = null; continue; }
    if (/^Night \d{2}\/\d{2}\/\d{4}/.test(rowText)) { currentBlock = 'Night'; headerMap = null; continue; }
    if (!currentBlock) continue;
    if (!headerMap && row.includes('NODE NAME')) {
      headerMap = {};
      row.forEach((cell, i) => {
        const t = String(cell || '').trim();
        if (KNOWN_HEADERS.includes(t)) headerMap[t] = i;
      });
      continue;
    }
    if (!headerMap) continue;
    const get = h => headerMap[h] === undefined ? null : row[headerMap[h]];
    const nodeName = get('NODE NAME');
    if (!nodeName) continue;
    records.push({
      source_spreadsheet_id: tabEntry.spreadsheetId,
      source_sheet: tabEntry.tabName,
      source_block: currentBlock,
      source_row: ri + 1,
      shift_date: tabEntry.date, // ← shift-date ownership: the TAB's date, not the timestamp
      node_name_raw: String(nodeName).trim(),
      node_name_normalized: normalizeNodeName(nodeName),
      outage_time: parseSheetDate(get('OUTAGE TIME')),
      restoration_time: parseSheetDate(get('RESTORATION TIME')),
      duration_raw_minutes: toNumberOrNull(get('DURATION')),
      rfo_text: String(get('RFO') || '').trim(),
      raw_outage_type: String(get('Outage Type') || '').trim(), // verbatim — POP/Fibre/LDS/OLT/Wireless survive
      rfo_shared_within_30: String(get('RFO shared within 30 mins') || '').trim(),
      status_raw: String(get('STATUS') || '').trim(),
      fault_owner: String(get('FAULT OWNER') || '').trim(),
      service_impacting: String(get('SERVICE IMPACTING') || '').trim(),
      reporting_officer: String(get('REPORTING OFFICER') || '').trim(),
      closed_by: String(get('CLOSED BY') || '').trim()
    });
  }
  return records;
}

module.exports = { readSourceTab, KNOWN_HEADERS };
