'use strict';
// ← 01_SourceDiscovery.gs — LEVEL 1: SOURCE DISCOVERY (Drive).
// Structural classification, never "first spreadsheet wins".
const { google } = require('googleapis');
const { config, COLLECTIONS } = require('../config');
const { col } = require('../mongodb');
const { hashHex, monthKey, tabDateFromName, pad2 } = require('../lib/hash');
const { xlsxSheetsClient } = require('./xlsx');

const GSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Valid outage-source formats: native Google Sheets AND Excel workbooks.
const SOURCE_MIMES = [GSHEET_MIME, XLSX_MIME];

// Shared-Drive-safe listing options. A plain files.list silently OMITS files
// that live on a shared drive (or under a folder on one) — a connected,
// authorized account still sees zero results. These flags make them visible.
const SHARED_DRIVE_OPTS = { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives' };

// ═══════════════ MONTH-YEAR FILE IDENTIFICATION ═══════════════
// Robust, case-insensitive, future-proof: any month name (full or abbreviated)
// with any 4-digit year, in either order, with any common separator — so
// "September 2026", "sept_2026.xlsx", "2026 October" all resolve, and future
// months/years require no code changes.
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function monthYearFromName(name) {
  if (!name) return null;
  const base = String(name).replace(/\.[^.]*$/, '').trim().toLowerCase();
  let m = base.match(/^([a-z]{3,9})\s*[-_.]?\s*(\d{4})$/);
  let word = m && m[1];
  let year = m && Number(m[2]);
  if (!m) { // reversed: "2026 september"
    m = base.match(/^(\d{4})\s*[-_.]?\s*([a-z]{3,9})$/);
    year = m && Number(m[1]);
    word = m && m[2];
  }
  if (!m || !word) return null;
  const idx = MONTH_NAMES.findIndex(mn => mn.startsWith(word));
  if (idx < 0) return null;
  return { year, month: idx + 1, period: year + '-' + pad2(idx + 1) };
}

// Paginated files.list — a folder with more than one page of children must not
// silently truncate (previously only the first page was ever scanned).
async function listAllFiles(drive, q) {
  const out = [];
  let pageToken;
  do {
    const r = await drive.files.list({
      q,
      fields: 'files(id,mimeType,name,parents,modifiedTime),nextPageToken',
      pageSize: 1000,
      pageToken,
      ...SHARED_DRIVE_OPTS
    });
    out.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function collectFolderSpreadsheets(drive, folderId, candidates, depth) {
  if (depth > 6) return; // ← bounded recursion, unchanged
  const entries = await listAllFiles(drive, `'${folderId}' in parents and trashed = false`);
  for (const f of entries) {
    if (SOURCE_MIMES.includes(f.mimeType) && !candidates[f.id]) {
      candidates[f.id] = { method: 'FOLDER_SCAN', mimeType: f.mimeType, name: f.name };
    }
  }
  for (const f of entries) {
    if (f.mimeType === FOLDER_MIME) {
      await collectFolderSpreadsheets(drive, f.id, candidates, depth + 1);
    }
  }
}

// driveFileMeta_ equivalent — Apps Script isTrashed() is replaced by the
// Drive API 'trashed' metadata field.
async function driveFileMeta_(drive, fileId) {
  try {
    const r = await drive.files.get({
      fileId, fields: 'id,name,mimeType,modifiedTime,trashed,parents',
      supportsAllDrives: true
    });
    return {
      name: r.data.name, mimeType: r.data.mimeType, lastUpdated: r.data.modifiedTime,
      trashed: r.data.trashed === true,
      parentFolderId: (r.data.parents || [])[0] || ''
    };
  } catch (e) {
    return { error: String(e.message || e), code: e.code };
  }
}

// Tab-reading client for either supported source format. Google Sheets use the
// Sheets API; Excel workbooks use the XLSX adapter (same interface).
async function sourceTabClient(sheets, drive, fileId, mimeType) {
  if (mimeType === XLSX_MIME) return xlsxSheetsClient(drive, fileId);
  return sheets;
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

// registerOperationalSource_ — discovered candidates are registered (upserted)
// into the SOURCES registry so downstream syncs pick them up with no manual
// source-ID entry. Works for both Google Sheets and Excel workbooks.
async function registerOperationalSource_(sheets, drive, fileId, method, mimeType) {
  const meta = await driveFileMeta_(drive, fileId);
  if (meta.error) throw new Error(meta.error);
  const trashed = meta.trashed;
  const client = await sourceTabClient(sheets, drive, fileId, meta.mimeType || mimeType);
  const classification = await classifyOperationalSpreadsheet_(client, fileId);
  const now = new Date();
  const existing = await (await col(COLLECTIONS.SOURCES)).findOne({ drive_file_id: fileId });
  const record = {
    source_id: existing ? existing.source_id : hashHex('SOURCE|' + fileId),
    drive_file_id: fileId,
    spreadsheet_id: fileId,
    name: meta.name || '',
    mime_type: meta.mimeType || mimeType || GSHEET_MIME,
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

function classifyDriveError(e) {
  const code = e && e.code;
  if (code === 404) return 'NOT_FOUND';
  if (code === 401) return 'AUTH_EXPIRED';
  if (code === 403) return 'PERMISSION';
  return 'LIST_FAILED';
}

// discoverOperationalSources() — full port, extended:
//   • persistent folder root (config) with explicit diagnostics distinguishing
//     inaccessible folder / auth failure / empty folder / no matching files
//   • paginated, shared-drive-safe recursive folder scan
//   • BOTH Google Sheets and Excel workbooks are discovered (Excel was
//     previously discarded silently → "Active sources: 0" despite a connected
//     account)
//   • month-year labels resolved from file names for diagnostics
// Never throws for one bad candidate.
async function discoverOperationalSources(auth) {
  const cfg = config();
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });
  const result = { scanned: 0, active: 0, notASource: 0, unreadable: 0, errors: [], found: [] };
  const candidates = {}; // fileId -> { method, mimeType, name }
  const add = (id, method, mimeType, name) => {
    if (!candidates[id]) candidates[id] = { method, mimeType, name };
  };

  if (cfg.operationalSheetId) add(cfg.operationalSheetId, 'MANUAL_CONNECT', GSHEET_MIME, '');

  if (cfg.operationalFolderId) {
    // Verify the root itself is reachable BEFORE scanning so the UI can tell
    // "folder not shared / token expired" apart from "folder has no files".
    let folderAccessible = true;
    try {
      await drive.files.get({
        fileId: cfg.operationalFolderId,
        fields: 'id,name,mimeType',
        supportsAllDrives: true
      });
    } catch (e) {
      folderAccessible = false;
      const kind = classifyDriveError(e);
      const hint = kind === 'NOT_FOUND'
        ? ' Folder not found — verify GOOGLE_OPERATIONAL_FOLDER_ID.'
        : kind === 'PERMISSION'
          ? ' Permission denied — share the folder with the connected Google account.'
          : kind === 'AUTH_EXPIRED'
            ? ' Credentials expired — reconnect Google at /api/auth/google.'
            : '';
      result.errors.push({
        where: 'folder_access', kind,
        message: `Discovery root folder is not accessible: ${String(e.message || e)}.${hint}`
      });
    }
    if (folderAccessible) {
      try {
        await collectFolderSpreadsheets(drive, cfg.operationalFolderId, candidates, 0);
      } catch (e) {
        result.errors.push({
          where: 'folder_scan', kind: classifyDriveError(e),
          message: `Folder scan failed: ${String(e.message || e)}`
        });
      }
      const discoveredCount = Object.keys(candidates).length -
        (cfg.operationalSheetId && candidates[cfg.operationalSheetId] ? 1 : 0);
      if (discoveredCount === 0) {
        result.errors.push({
          where: 'folder_scan', kind: 'NO_MATCHING_FILES',
          message: `Folder is reachable but contains no Google Sheets or Excel workbooks (including subfolders, including shared-drive content).`
        });
      }
    }
  } else {
    // Fallback: full-drive search (paginated, shared-drive-safe), both formats.
    try {
      for (const mime of SOURCE_MIMES) {
        const files = await listAllFiles(drive, `mimeType = '${mime}' and trashed = false`);
        for (const f of files) add(f.id, 'DRIVE_SEARCH', f.mimeType, f.name);
      }
    } catch (e) {
      result.errors.push({ where: 'drive_search', kind: classifyDriveError(e), message: String(e.message || e) });
    }
  }

  for (const [fileId, info] of Object.entries(candidates)) {
    result.scanned++;
    try {
      const rec = await registerOperationalSource_(sheets, drive, fileId, info.method, info.mimeType);
      const label = monthYearFromName(rec.name);
      result.found.push({
        fileId, name: rec.name, status: rec.status, mimeType: rec.mime_type,
        monthYear: label ? label.period : '',
        periods: rec.report_period || [],
        reason: rec.status_reason || ''
      });
      if (rec.status === 'ACTIVE') result.active++; else result.notASource++;
    } catch (e) {
      result.unreadable++;
      result.errors.push({ where: fileId, kind: 'UNREADABLE', message: String(e.message || e) });
      await markSourceUnreadable(fileId, info.method, e);
    }
  }
  return result;
}

module.exports = {
  discoverOperationalSources, registerOperationalSource: registerOperationalSource_,
  markSourceUnreadable, monthYearFromName, listAllFiles,
  GSHEET_MIME, XLSX_MIME
};
