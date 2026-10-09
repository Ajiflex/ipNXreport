'use strict';
// ← 09_TemplateEngine.gs adapted to Node/ExcelJS.
// The Apps Script version copies a live Google Sheet template (formatting
// survives structurally). Node has no Google Sheets rendering, so the
// equivalent-preserving approach is: generate the workbook programmatically
// with ExcelJS using the exact layout constants from 08, then validate the
// produced bytes with the same four checks as validateXlsxBlob_ (PK signature,
// [Content_Types].xml, xl/workbook.xml, required sheets). Layout constants,
// column positions, section order, sheet names, and the write-set are
// unchanged from the source.
const ExcelJS = require('exceljs');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function colIdx(letter) {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

async function buildPopWorkbook(startDate, endDate, calc, layout, systemConfig) {
  const wb = new ExcelJS.Workbook();
  const main = wb.addWorksheet('POP_AVAILABILITY');
  main.getColumn(2).width = 28; // B: site names
  const durCol = colIdx(layout.durationCol);          // K
  const detCol = colIdx(layout.outageBlockStartCol);  // L (Occurrence, Resolution, Duration, RFO)
  const header = main.getRow(1);
  header.getCell(1).value = 'S/N';
  header.getCell(2).value = 'SITE';
  header.getCell(durCol).value = 'DOWNTIME (mins)';
  header.getCell(detCol).value = 'OCCURRENCE';
  header.getCell(detCol + 1).value = 'RESOLUTION';
  header.getCell(detCol + 2).value = 'DURATION';
  header.getCell(detCol + 3).value = 'RFO';

  // Two-phase like populatePopWorkbook_: plan + validate first, then write.
  const plan = [];
  for (const section of layout.sections) {
    const sites = calc.perAsset.filter(a => a.provider_group === section.name);
    for (const a of sites) {
      if (a.incidents.length > (section.name === 'IHS' ? 47 : 16)) { // bounded block capacity, same rule
        throw new Error(`"${a.canonical_name}" has ${a.incidents.length} incident(s) but its template block is too small — report NOT generated`);
      }
      plan.push({ section: section.name, asset: a });
    }
    if (sites.length === 0) {
      throw new Error(`Section ${section.name} has no sites — template validation failed, report NOT generated`);
    }
  }
  if (plan.length !== 57) {
    throw new Error('POP template validation failed: ' + plan.length + ' sites planned, expected 57 — report NOT generated');
  }

  let r = 2;
  let sn = 1;
  for (const section of layout.sections) {
    for (const p of plan.filter(x => x.section === section.name)) {
      const a = p.asset;
      const row = main.getRow(r);
      row.getCell(1).value = sn++;
      row.getCell(2).value = a.canonical_name;
      row.getCell(durCol).value = a.total_downtime_minutes;
      a.incidents.forEach((inc, i) => { // outage detail block, 4 columns from L
        const drow = main.getRow(r + i);
        drow.getCell(detCol).value = inc.start_time || '';
        drow.getCell(detCol + 1).value = inc.end_time || '';
        drow.getCell(detCol + 2).value = inc.duration_minutes === null ? '' : inc.duration_minutes;
        drow.getCell(detCol + 3).value = inc.rfo_text || '';
      });
      r += Math.max(1, a.incidents.length); // blocks are adjacent, exactly like the sheet
    }
    r += 1; // blank separator row between provider sections (template fact)
  }

  // SUMMARY — provider_group label semantics preserved.
  const sum = wb.addWorksheet(layout.summarySheet);
  const sh = sum.getRow(1);
  ['PROVIDER', 'TOTAL SITES', 'WITHIN SLA', 'BELOW SLA', 'AVERAGE AVAILABILITY', 'SLA']
    .forEach((h, i) => { sh.getCell(i + 1).value = h; });
  sum.getCell(2, 6).value = '99.99%'; // displayed sla_target — fixed template value
  calc.summary.forEach((s, i) => {
    const row = sum.getRow(2 + i);
    row.getCell(1).value = s.provider_group;
    row.getCell(2).value = s.total_sites;
    row.getCell(3).value = s.within_sla;
    row.getCell(4).value = s.below_sla;
    row.getCell(5).value = s.average_availability;
  });

  // Poor_Performing BTS — [S/N, SITE, AVAILABILITY, ISSUE, RESOLUTION], TIMELINE
  // blank (matches sample).
  const pp = wb.addWorksheet(layout.poorPerformingSheet);
  const ph = pp.getRow(1);
  ['S/N', 'SITE', 'AVAILABILITY', 'ISSUE', 'RESOLUTION', 'TIMELINE']
    .forEach((h, i) => { ph.getCell(i + 1).value = h; });
  const { longestIncident } = require('../reporting/popAvailability');
  calc.poorPerforming.forEach((a, i) => {
    const longest = longestIncident(a.incidents);
    const row = pp.getRow(2 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = a.canonical_name;
    row.getCell(3).value = a.availability_pct + '%';
    row.getCell(4).value = longest ? (longest.issue_text || '') : '';
    row.getCell(5).value = longest ? (longest.resolution_text || '') : '';
  });

  return wb.xlsx.writeBuffer();
}

// ← validateXlsxBlob_: identical checks (PK, OOXML members, sheet names).
async function validateXlsxBuffer(buffer, requiredSheets) {
  if (!buffer || !buffer.length) throw new Error('XLSX validation failed: file is empty');
  const b = Buffer.from(buffer);
  if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4b) {
    throw new Error('XLSX validation failed: not a ZIP/OOXML file (bad signature)');
  }
  const check = new ExcelJS.Workbook();
  let sheetNames;
  try {
    await check.xlsx.load(b);
    sheetNames = check.worksheets.map(w => w.name);
  } catch (e) {
    throw new Error('XLSX validation failed: cannot open archive (' + e.message + ')');
  }
  if (!sheetNames.length) throw new Error('XLSX validation failed: workbook lists no sheets');
  const missing = (requiredSheets || []).filter(n => !sheetNames.includes(n));
  if (missing.length) throw new Error('XLSX validation failed: missing sheet(s) ' + missing.join(', '));
  return { sheetNames };
}

/**
 * ← populateTemplateAndExport(): generate → validate → save to Drive archive
 * folder → verify the STORED file → return descriptor. Any failure throws and
 * the bad Drive file is trashed; nothing is archived. (isTrashed-equivalent
 * protection lives in archive.js.)
 */
async function populateTemplateAndExport(reportType, startDate, endDate, calc, spec) {
  if (!spec.fileName || !/\.xlsx$/.test(spec.fileName)) {
    throw new Error('spec.fileName must end in .xlsx');
  }
  const { getSystemConfig } = require('../reporting');
  const systemConfig = await getSystemConfig(reportType);
  const buffer = await buildPopWorkbook(startDate, endDate, calc, spec.layout, systemConfig);
  const check = await validateXlsxBuffer(buffer, spec.requiredSheets || []);
  const { saveExportToArchive } = require('../archive');
  return saveExportToArchive(Buffer.from(buffer), spec.fileName, check.sheetNames);
}

module.exports = { buildPopWorkbook, validateXlsxBuffer, populateTemplateAndExport, XLSX_MIME };
