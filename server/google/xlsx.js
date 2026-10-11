'use strict';
// XLSX-backed, Sheets-API-compatible client.
// Excel workbooks stored on Drive cannot be read through the Sheets API, so
// discovery/ingestion would silently discard them. This adapter downloads the
// workbook (files.get alt=media) with the SAME Drive OAuth connection and
// serves tab metadata + formatted values through the exact response shapes
// readSourceTab, classifyOperationalSpreadsheet_ and the test mocks already
// consume — no changes to the parsing pipeline are needed downstream.
const ExcelJS = require('exceljs');

function colNameToIndex(letters) {
  return letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}

// Sheets-API-shaped 2D array: each row is an array of FORMATTED strings
// (FORMATTED_VALUE analog), trailing empty cells trimmed, fully-empty rows
// omitted — matching what sheets.spreadsheets.values.get returns.
function worksheetValues(ws) {
  const colCount = ws.actualColumnCount || 0;
  const out = [];
  ws.eachRow({ includeEmpty: false }, row => {
    const vals = [];
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      vals.push(cell.text == null ? '' : String(cell.text));
    }
    while (vals.length && vals[vals.length - 1] === '') vals.pop();
    if (vals.length) out.push(vals);
  });
  return out;
}

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'binary');
  if (data && typeof data.pipe === 'function') {
    const chunks = [];
    for await (const ch of data) chunks.push(Buffer.from(ch));
    return Buffer.concat(chunks);
  }
  return Buffer.from(data); // ArrayBuffer / typed array
}

// Returns an object shaped like google.sheets({...}) for one Drive XLSX file.
// Tab data is fetched lazily once and cached for the lifetime of the client.
function xlsxSheetsClient(drive, fileId) {
  let loadPromise = null;
  function load() {
    if (!loadPromise) {
      loadPromise = (async () => {
        const res = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const buf = await toBuffer(res.data);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        const tabs = {};
        for (const ws of wb.worksheets) tabs[ws.name] = worksheetValues(ws);
        return tabs;
      })();
    }
    return loadPromise;
  }
  return {
    spreadsheets: {
      async get() {
        const tabs = await load();
        return { data: { sheets: Object.keys(tabs).map(title => ({ properties: { title } })) } };
      },
      values: {
        async get({ range } = {}) {
          const tabs = await load();
          const m = String(range || '').match(/^'([^']+)'(?:!A1:([A-Z]+)(\d+))?$/);
          if (!m) throw new Error('xlsx: unsupported range ' + range);
          let values = tabs[m[1]];
          if (!values) { const e = new Error('Tab not found: ' + m[1]); e.code = 400; throw e; }
          values = values.map(r => r.slice());
          if (m[2]) { // A1:O40-style bound
            const cols = colNameToIndex(m[2]);
            const rows = Number(m[3]);
            values = values.slice(0, rows).map(r => r.slice(0, cols));
          }
          return { data: { values } };
        }
      }
    }
  };
}

module.exports = { xlsxSheetsClient };
