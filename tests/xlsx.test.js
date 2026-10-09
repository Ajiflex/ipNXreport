'use strict';
// XLSX tests: workbook build, byte validation (PK / OOXML / required sheets),
// Drive archive save + verify, isTrashed-equivalent rejection.
const { test, assert, eq, throws, freshDb } = require('./helpers');
const { installGoogleMock } = require('./mocks/google');

function syntheticCalc() {
  const groups = [['IHS', 30], ['ipNX', 8], ['Others', 19]];
  const perAsset = [];
  groups.forEach(([g, n]) => {
    for (let i = 1; i <= n; i++) {
      const id = g.toLowerCase() + '_' + i;
      perAsset.push({
        asset_id: id, canonical_name: g + ' Site ' + i, provider_group: g,
        total_downtime_minutes: g === 'IHS' && i === 1 ? 180 : 0,
        availability_pct: g === 'IHS' && i === 1 ? 98.21 : 100,
        sla_status: g === 'IHS' && i === 1 ? 'BELOW_SLA' : 'WITHIN_SLA',
        poor_performing: g === 'IHS' && i === 1,
        incident_ids: g === 'IHS' && i === 1 ? ['INC-X'] : [],
        incidents: g === 'IHS' && i === 1 ? [{
          incident_id: 'INC-X', start_time: new Date('2026-10-06T02:00:00Z'),
          end_time: new Date('2026-10-06T05:00:00Z'), duration_minutes: 180,
          rfo_text: 'Fibre cut', issue_text: 'Fibre cut', resolution_text: 'Fibre cut', status: 'CLOSED'
        }] : []
      });
    }
  });
  return {
    perAsset,
    summary: groups.map(([g, n]) => ({
      provider_group: g, total_sites: n, within_sla: n - (g === 'IHS' ? 1 : 0),
      below_sla: g === 'IHS' ? 1 : 0, average_availability: 99.94
    })),
    poorPerforming: perAsset.filter(a => a.poor_performing)
  };
}

test('buildPopWorkbook produces a valid XLSX with the required sheets and 57 sites', async () => {
  const { buildPopWorkbook, validateXlsxBuffer } = require('../server/templates/xlsx');
  const { POP_TEMPLATE_LAYOUT } = require('../server/reporting/popAvailability');
  const buf = Buffer.from(await buildPopWorkbook(new Date(2026, 9, 5), new Date(2026, 9, 11),
    syntheticCalc(), POP_TEMPLATE_LAYOUT, { sla_target: 0.9999 }));
  assert(buf[0] === 0x50 && buf[1] === 0x4b, 'PK signature');
  const v = await validateXlsxBuffer(buf, ['SUMMARY', 'Poor_Performing BTS']);
  assert(v.sheetNames.includes('POP_AVAILABILITY'), 'main sheet');
  assert(v.sheetNames.includes('SUMMARY'), 'summary sheet');
  assert(v.sheetNames.includes('Poor_Performing BTS'), 'poor-performing sheet');

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const main = wb.getWorksheet('POP_AVAILABILITY');
  eq(main.getCell(2, 2).value, 'IHS Site 1', 'first IHS site at row 2 col B');
  eq(main.getCell(2, 11).value, 180, 'downtime in column K');
  eq(main.getCell(2, 15).value, 'Fibre cut', 'RFO in column O');
  const pp = wb.getWorksheet('Poor_Performing BTS');
  eq(pp.getCell(2, 2).value, 'IHS Site 1', 'poor performer listed');
  eq(pp.getCell(2, 4).value, 'Fibre cut', 'issue narrative');
});

test('validateXlsxBuffer rejects garbage and missing sheets', async () => {
  const { validateXlsxBuffer } = require('../server/templates/xlsx');
  await throws(() => validateXlsxBuffer(Buffer.from('not a zip'), []), /bad signature/, 'non-XLSX rejected');
  await throws(() => validateXlsxBuffer(Buffer.from(''), []), /empty/, 'empty rejected');
  const { buildPopWorkbook } = require('../server/templates/xlsx');
  const { POP_TEMPLATE_LAYOUT } = require('../server/reporting/popAvailability');
  const buf = Buffer.from(await buildPopWorkbook(new Date(2026, 9, 5), new Date(2026, 9, 11),
    syntheticCalc(), POP_TEMPLATE_LAYOUT, {}));
  await throws(() => validateXlsxBuffer(buf, ['NO_SUCH_SHEET']), /missing sheet/, 'missing sheet rejected');
});

test('a workbook with != 57 sites is refused (template validation)', async () => {
  const { buildPopWorkbook } = require('../server/templates/xlsx');
  const { POP_TEMPLATE_LAYOUT } = require('../server/reporting/popAvailability');
  const calc = syntheticCalc();
  calc.perAsset = calc.perAsset.filter(a => a.asset_id !== 'others_19'); // 56 sites
  await throws(
    () => buildPopWorkbook(new Date(2026, 9, 5), new Date(2026, 9, 11), calc, POP_TEMPLATE_LAYOUT, {}),
    /expected 57/, '57-site invariant enforced'
  );
});

test('archive round-trip: save → verify → download; trashed file rejected', async () => {
  await freshDb();
  const mock = installGoogleMock({});
  // Connect Google (mock OAuth token store).
  const { saveTokens } = require('../server/google/auth');
  await saveTokens({ refresh_token: 'r', access_token: 'a', expiry_date: Date.now() + 3600000 });

  const { buildPopWorkbook } = require('../server/templates/xlsx');
  const { POP_TEMPLATE_LAYOUT } = require('../server/reporting/popAvailability');
  const buf = Buffer.from(await buildPopWorkbook(new Date(2026, 9, 5), new Date(2026, 9, 11),
    syntheticCalc(), POP_TEMPLATE_LAYOUT, {}));

  const { saveExportToArchive, verifyDriveFile } = require('../server/archive');
  const exported = await saveExportToArchive(buf, 'POP_AVAILABILITY 20261005_to_20261011.xlsx', ['SUMMARY', 'Poor_Performing BTS']);
  assert(exported.fileId, 'file created in archive folder');
  eq(exported.size, buf.length, 'size matches');

  const { google } = require('googleapis');
  const drive = google.drive({ version: 'v3', auth: {} });
  const v = await verifyDriveFile(drive, exported.fileId, ['SUMMARY']);
  assert(v.size > 0, 'stored file verifies');

  mock.trashFile(exported.fileId);
  await throws(() => verifyDriveFile(drive, exported.fileId, []), /Trash/, 'trashed file rejected (isTrashed-equivalent)');

  // never overwrite an existing archive name
  mock.files.get(exported.fileId).trashed = false;
  const again = await saveExportToArchive(buf, 'POP_AVAILABILITY 20261005_to_20261011.xlsx', []);
  assert(again.fileName !== 'POP_AVAILABILITY 20261005_to_20261011.xlsx', 'duplicate name gets a timestamp suffix');
});
