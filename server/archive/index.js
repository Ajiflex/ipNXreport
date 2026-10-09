'use strict';
// ← 10_Archive.gs, port. Drive-file verification = the isTrashed() equivalent:
// a stored file id is NEVER assumed permanently valid.
const { google } = require('googleapis');
const { config, COLLECTIONS } = require('../config');
const { col, upsertMany } = require('../mongodb');
const { periodId } = require('../lib/hash');
const { validateXlsxBuffer, XLSX_MIME } = require('../templates/xlsx');

async function verifyDriveFile(drive, fileId, requiredSheets) {
  let meta;
  try {
    meta = await drive.files.get({ fileId, fields: 'id,name,size,mimeType,trashed' });
  } catch (e) {
    throw new Error('Archived file validation failed: file does not exist or is inaccessible (' + e.message + ')');
  }
  if (meta.data.trashed) throw new Error('Archived file validation failed: file is in the Trash on Drive');
  if (!(Number(meta.data.size) > 0)) throw new Error('Archived file validation failed: file is empty');
  if (meta.data.mimeType !== XLSX_MIME) {
    throw new Error('Archived file validation failed: MIME ' + meta.data.mimeType);
  }
  const buf = Buffer.from((await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' })).data);
  await validateXlsxBuffer(buf, requiredSheets || []); // the STORED file re-opens and passes
  return { name: meta.data.name, size: Number(meta.data.size) };
}

// ← saveExportToArchive_: never overwrite an existing archive name.
async function saveExportToArchive(buffer, fileName, sheetNames) {
  const auth = await require('../google/auth').authorizedClient();
  const drive = google.drive({ version: 'v3', auth });
  const folderId = config().archiveFolderId;
  if (!folderId) throw new Error('GOOGLE_ARCHIVE_FOLDER_ID is not configured');
  let finalName = fileName;
  const dup = await drive.files.list({
    q: `name = '${finalName.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`
  });
  if ((dup.data.files || []).length) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    finalName = fileName.replace(/\.xlsx$/, '') + ' ' + stamp + '.xlsx';
  }
  const created = await drive.files.create({
    requestBody: { name: finalName, parents: [folderId], mimeType: XLSX_MIME },
    media: { mimeType: XLSX_MIME, body: require('stream').Readable.from(buffer) },
    fields: 'id,name,size,mimeType,webViewLink'
  });
  const fileId = created.data.id;
  try {
    await verifyDriveFile(drive, fileId, sheetNames); // verify the STORED file before archiving metadata
    return {
      fileId, fileName: finalName, size: Number(created.data.size), mimeType: XLSX_MIME,
      sheetNames, url: created.data.webViewLink
    };
  } catch (e) {
    await drive.files.update({ fileId, requestBody: { trashed: true } }).catch(() => {});
    throw e;
  }
}

// ← archiveGeneratedReport_: ONE logical record per period; revision++,
// previous file ids kept in superseded_file_ids (in-place upsert, no duplicates).
async function archiveGeneratedReport(reportType, startDate, endDate, exported, dataVersion, revision, completeness) {
  if (!exported || !exported.fileId) throw new Error('archiveGeneratedReport: no exported file to archive');
  const id = periodId(reportType, startDate, endDate);
  const prior = await (await col(COLLECTIONS.REPORT_ARCHIVE)).findOne({ period_id: id });
  let superseded = [];
  if (prior) {
    try { superseded = JSON.parse(prior.superseded_file_ids || '[]'); } catch { superseded = []; }
    if (prior.drive_file_id && prior.drive_file_id !== exported.fileId) superseded.push(prior.drive_file_id);
  }
  const record = {
    period_id: id, report_type: reportType, period_start: startDate, period_end: endDate,
    generated_at: new Date(), drive_file_id: exported.fileId,
    status: completeness === 'PARTIAL' ? 'FINAL_PARTIAL' : 'FINAL',
    file_name: exported.fileName, file_size_bytes: exported.size, mime_type: exported.mimeType,
    data_version: dataVersion, data_completeness: completeness, revision,
    superseded_file_ids: JSON.stringify(superseded)
  };
  await upsertMany(COLLECTIONS.REPORT_ARCHIVE, o => o.period_id, [record]);
  return record;
}

// Report library, newest first.
async function listArchivedReports(reportType) {
  return (await (await col(COLLECTIONS.REPORT_ARCHIVE))
    .find(reportType ? { report_type: reportType } : {}).toArray())
    .sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at))
    .map(r => ({ ...r, superseded_file_ids: JSON.parse(r.superseded_file_ids || '[]') }));
}

// "Download last week's report" never re-runs the pipeline.
async function getArchivedReport(reportType, startDate, endDate) {
  const id = periodId(reportType, startDate, endDate);
  const r = await (await col(COLLECTIONS.REPORT_ARCHIVE)).findOne({ period_id: id });
  return (r && (r.status === 'FINAL' || r.status === 'FINAL_PARTIAL')) ? r : null;
}

// Download path — validates BEFORE streaming (missing/trashed handled cleanly).
async function downloadArchivedReport(reportType, startDate, endDate) {
  const archived = await getArchivedReport(reportType, startDate, endDate);
  if (!archived) {
    const e = new Error('No archived report for this period');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const auth = await require('../google/auth').authorizedClient();
  const drive = google.drive({ version: 'v3', auth });
  const v = await verifyDriveFile(drive, archived.drive_file_id);
  const buf = Buffer.from((await drive.files.get(
    { fileId: archived.drive_file_id, alt: 'media' }, { responseType: 'arraybuffer' })).data);
  return { buffer: buf, fileName: v.name, mimeType: XLSX_MIME };
}

module.exports = {
  saveExportToArchive, archiveGeneratedReport, listArchivedReports, getArchivedReport,
  downloadArchivedReport, verifyDriveFile
};
