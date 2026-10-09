'use strict';
// GET /api/reports/:id/download — stream the archived XLSX. The stored Drive
// file is verified BEFORE streaming (exists ∧ not trashed ∧ non-zero ∧ valid
// XLSX) — the isTrashed() equivalent.
const { google } = require('googleapis');
const { allowMethods, fail } = require('../../_lib');
const { col } = require('../../../server/mongodb');
const { authorizedClient } = require('../../../server/google/auth');
const { verifyDriveFile } = require('../../../server/archive');

module.exports = async (req, res) => {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const id = req.query && req.query.id;
    const archived = await (await col('report_archive')).findOne({ period_id: id });
    if (!archived || !['FINAL', 'FINAL_PARTIAL'].includes(archived.status)) {
      const e = new Error('No archived report for period ' + id);
      e.code = 'NOT_FOUND';
      throw e;
    }
    const auth = await authorizedClient();
    const drive = google.drive({ version: 'v3', auth });
    const v = await verifyDriveFile(drive, archived.drive_file_id); // validates before streaming
    const buf = Buffer.from((await drive.files.get(
      { fileId: archived.drive_file_id, alt: 'media' }, { responseType: 'arraybuffer' })).data);
    res.statusCode = 200;
    res.setHeader('Content-Type', archived.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${v.name}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  } catch (e) {
    fail(res, e);
  }
};
