'use strict';
// ← 01_SourceDiscovery.gs — LEVEL 1: SOURCE DISCOVERY (Drive).
// Structural classification, never "first spreadsheet wins".
const { google } = require('googleapis');
const { config, COLLECTIONS } = require('../config');
const { col } = require('../mongodb');
const { hashHex, monthKey, tabDateFromName } = require('../lib/hash');

const GSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function collectFolderSpreadsheets(drive, folderId, candidates, depth) {
  if (depth > 6) return; // ← bounded recursion, unchanged
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,mimeType,name,parents,modifiedTime)'
  });
  for (const f of res.data.files || []) {
    if (f.mimeType === GSHEET_MIME && !candidates[f.id]) candidates[f.id] = 'FOLDER_SCAN';
  }
  const sub = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)'
  });
  for (const s of sub.data.files || []) {
    await collectFolderSpreadsheets(drive, s.id, candidates, depth + 1);
  }
}

// driveFileMeta_ equivalent — Apps Script isTrashed() is replaced by the
// Drive API 'trashed' metadata field.
async function driveFileMeta_(drive, fileId) {
  try {
    const r = await drive.files.get({ fileId, fields: 'id,name,mimeType,modifiedTime,trashed,parents' });
    return {
      name: r.data.name, mimeType: r.data.mimeType, lastUpdated: r.data.modifiedTime,
      trashed: r.data.trashed === true,
      parentFolderId: (r.data.parents || [])[0] || ''
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// classifyOperationalSpreadsheet_ — STRUCTURAL classifier:
// ≥1 DD_MM_YYYY tab + newest tab has a Day/Night dd/mm/yyyy block + NODE NAME header.
async function classifyOperationalSpreadsheet_(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties.title)' });
  const names = (meta.data.sheets || []).map(s => s.properties.title);
  const dateTabs = names.map(n => ({ tabName: n, date: tabDateFromName(n) })).filter(t => t.date);
  if (!dateTabs.length) {
    return { isSource: false, reason: 'no date-named tabs (DD_MM_YYYY)', periods: [], dateTabs: [] };
  }
  dateTabs.sort((a, b) => a.date - b.date);
  const periods = [...new Set(dateTabs.map(t => monthKey(t.date)))].sort();
  const newest = dateTabs[dateTabs.length - 1];
  let hasBlock = false, hasHeader = false;
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `'${newest.tabName}'!A1:O40`, // ← min(lastRow,40) x min(lastCol,15)
      valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING'
    });
    for (const row of r.data.values || []) {
      const text = row.join(' ');
      if (/^(Day|Night) \d{2}\/\d{2}\/\d{4}/.test(text)) hasBlock = true;
      if (row.includes('NODE NAME')) hasHeader = true;
    }
  } catch (e) {
    return {
      isSource: false,
      reason: `date tabs found but newest tab ${newest.tabName} could not be read: ${e.message}`,
      periods, dateTabs
    };
  }
  if (!hasBlock || !hasHeader) {
    return {
      isSource: false,
      reason: `date tabs found but no Day/Night outage structure (NODE NAME header) in newest tab ${newest.tabName}`,
      periods, dateTabs
    };
  }
  return { isSource: true, reason: '', periods, dateTabs };
}

// registerOperationalSource_ — identity is the Drive file id; re-discovery
// updates in place and preserves discovered_at / last_ingested_at /
// MANUAL_CONNECT (unchanged from source).
async function registerOperationalSource_(sheets, drive, fileId, method) {
  const classification = await classifyOperationalSpreadsheet_(sheets, fileId);
  const meta = await driveFileMeta_(drive, fileId);
  const now = new Date();
  const existing = await (await col(COLLECTIONS.SOURCES)).findOne({ drive_file_id: fileId });
  const trashed = meta.trashed === true;
  const record = {
    source_id: existing ? existing.source_id : hashHex('SOURCE|' + fileId),
    drive_file_id: fileId,
    spreadsheet_id: fileId,
    name: meta.name || '',
    mime_type: meta.mimeType || GSHEET_MIME,
    parent_folder_id: meta.parentFolderId || '',
    source_type: classification.isSource ? 'OPERATIONAL_OUTAGE_LOG' : 'UNKNOWN',
    report_category: classification.isSource ? 'OUTAGE' : '',
    report_period: classification.periods,
    discovered_at: (existing && existing.discovered_at) || now,
    last_seen_at: now,
    last_ingested_at: (existing && existing.last_ingested_at) || null,
    last_modified_time: meta.lastUpdated || (existing && existing.last_modified_time) || '',
    status: trashed ? 'TRASHED' : (classification.isSource ? 'ACTIVE' : 'NOT_A_SOURCE'),
    discovery_method: (existing && existing.discovery_method === 'MANUAL_CONNECT')
      ? 'MANUAL_CONNECT' : (method || (existing && existing.discovery_method) || 'DRIVE_SEARCH'),
    status_reason: trashed ? 'file is in the Trash' : (classification.isSource ? '' : classification.reason)
  };
  // Keyed directly on source_id so re-discovery always updates in place,
  // regardless of how the existing row was originally written.
  await (await col(COLLECTIONS.SOURCES)).updateOne(
    { source_id: record.source_id }, { $set: { ...record, _k: record.source_id } }, { upsert: true });
  return record;
}

// ← markSourceUnreadable_: a failed candidate is registered, never dropped.
async function markSourceUnreadable(fileId, method, err) {
  const now = new Date();
  const existing = await (await col(COLLECTIONS.SOURCES)).findOne({ drive_file_id: fileId });
  const record = {
    source_id: existing ? existing.source_id : hashHex('SOURCE|' + fileId),
    drive_file_id: fileId, spreadsheet_id: fileId,
    name: (existing && existing.name) || '', mime_type: GSHEET_MIME, parent_folder_id: '',
    source_type: 'UNKNOWN', report_category: '', report_period: [],
    discovered_at: (existing && existing.discovered_at) || now, last_seen_at: now,
    last_ingested_at: (existing && existing.last_ingested_at) || null,
    last_modified_time: (existing && existing.last_modified_time) || '',
    status: 'UNREADABLE',
    discovery_method: (existing && existing.discovery_method) || method || 'DRIVE_SEARCH',
    status_reason: String(err && err.message || err)
  };
  await (await col(COLLECTIONS.SOURCES)).updateOne(
    { source_id: record.source_id }, { $set: { ...record, _k: record.source_id } }, { upsert: true });
  return record;
}

// discoverOperationalSources() — full port. Never throws for one bad candidate.
async function discoverOperationalSources(auth) {
  const cfg = config();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });
  const result = { scanned: 0, active: 0, notASource: 0, unreadable: 0, errors: [] };
  const candidates = {};
  if (cfg.operationalSheetId) candidates[cfg.operationalSheetId] = 'MANUAL_CONNECT'; // seed only
  if (cfg.operationalFolderId) {
    try {
      await collectFolderSpreadsheets(drive, cfg.operationalFolderId, candidates, 0);
    } catch (e) {
      result.errors.push({ where: 'folder_scan', message: String(e.message || e) });
    }
  } else {
    try {
      let pageToken;
      do {
        const r = await drive.files.list({
          q: `mimeType = '${GSHEET_MIME}' and trashed = false`,
          fields: 'files(id),nextPageToken', pageToken, pageSize: 1000
        });
        for (const f of r.data.files || []) if (!candidates[f.id]) candidates[f.id] = 'DRIVE_SEARCH';
        pageToken = r.data.nextPageToken;
      } while (pageToken);
    } catch (e) {
      result.errors.push({ where: 'drive_search', message: String(e.message || e) });
    }
  }
  for (const [fileId, method] of Object.entries(candidates)) {
    result.scanned++;
    try {
      const rec = await registerOperationalSource_(sheets, drive, fileId, method);
      if (rec.status === 'ACTIVE') result.active++; else result.notASource++;
    } catch (e) {
      result.unreadable++;
      result.errors.push({ where: fileId, message: String(e.message || e) });
      await markSourceUnreadable(fileId, method, e);
    }
  }
  return result;
}

module.exports = {
  discoverOperationalSources, registerOperationalSource: registerOperationalSource_,
  markSourceUnreadable, GSHEET_MIME
};
