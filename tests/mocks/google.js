'use strict';
// Google API mocks. Monkeypatches the `google` export of the real googleapis
// package (same object identity the server modules hold), so Drive/Sheets/OAuth
// calls resolve to the in-memory fixture store.
//
// Fixture shape:
//   files: [{ id, name, mimeType, modifiedTime, trashed, parents: [...],
//             tabs: { tabName: values[][] } }]   // spreadsheets
// Folders are implied by `parents`.
const GSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function createGoogleMock(fixture) {
  const files = new Map(); // id -> file record (spreadsheets and created xlsx)
  (fixture.files || []).forEach(f => files.set(f.id, {
    mimeType: GSHEET_MIME, trashed: false, parents: [], modifiedTime: '2026-10-01T00:00:00.000Z',
    tabs: {}, ...f
  }));
  let createdCount = 0;

  function matchQ(file, q) {
    if (!q) return true;
    const parents = [...q.matchAll(/'([^']+)' in parents/g)].map(m => m[1]);
    if (parents.length && !parents.some(p => (file.parents || []).includes(p))) return false;
    const mime = q.match(/mimeType = '([^']+)'/);
    if (mime && file.mimeType !== mime[1]) return false;
    if (/trashed = false/.test(q) && file.trashed) return false;
    const name = q.match(/name = '([^']+)'/);
    if (name && file.name !== name[1]) return false;
    return true;
  }

  const drive = {
    files: {
      async list({ q } = {}) {
        const out = [...files.values()].filter(f => matchQ(f, q || ''))
          .map(f => ({ id: f.id, mimeType: f.mimeType, name: f.name, parents: f.parents, modifiedTime: f.modifiedTime }));
        return { data: { files: out } };
      },
      async get({ fileId, fields, alt } = {}) {
        const f = files.get(fileId);
        if (!f) { const e = new Error('File not found: ' + fileId); e.code = 404; throw e; }
        if (alt === 'media') {
          const buf = f.content || Buffer.from('');
          return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
        }
        return {
          data: {
            id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime,
            trashed: !!f.trashed, parents: f.parents || [],
            size: String(f.content ? f.content.length : (f.size || 1024))
          }
        };
      },
      async create({ requestBody, media } = {}) {
        let content = Buffer.from('');
        if (media && media.body) {
          if (Buffer.isBuffer(media.body)) content = media.body;
          else { // Readable stream
            const chunks = [];
            for await (const ch of media.body) chunks.push(Buffer.from(ch));
            content = Buffer.concat(chunks);
          }
        }
        const id = 'DRIVE_CREATED_' + (++createdCount);
        files.set(id, {
          id, name: requestBody.name, mimeType: requestBody.mimeType || XLSX_MIME,
          parents: requestBody.parents || [], trashed: false,
          modifiedTime: new Date().toISOString(), content
        });
        return {
          data: {
            id, name: requestBody.name, size: String(content.length),
            mimeType: requestBody.mimeType || XLSX_MIME,
            webViewLink: 'https://drive.mock/' + id
          }
        };
      },
      async update({ fileId, requestBody } = {}) {
        const f = files.get(fileId);
        if (!f) { const e = new Error('File not found: ' + fileId); e.code = 404; throw e; }
        Object.assign(f, requestBody || {});
        return { data: { id: fileId } };
      }
    }
  };

  const sheets = {
    spreadsheets: {
      async get({ spreadsheetId } = {}) {
        const f = files.get(spreadsheetId);
        if (!f || !f.tabs) { const e = new Error('Spreadsheet not found: ' + spreadsheetId); e.code = 404; throw e; }
        return { data: { sheets: Object.keys(f.tabs).map(title => ({ properties: { title } })) } };
      },
      values: {
        async get({ spreadsheetId, range } = {}) {
          const f = files.get(spreadsheetId);
          if (!f || !f.tabs) { const e = new Error('Spreadsheet not found: ' + spreadsheetId); e.code = 404; throw e; }
          const m = String(range).match(/^'([^']+)'(?:!A1:([A-Z]+)(\d+))?$/);
          if (!m) throw new Error('mock: unsupported range ' + range);
          const tab = f.tabs[m[1]];
          if (!tab) { const e = new Error('Tab not found: ' + m[1]); e.code = 400; throw e; }
          let values = tab.map(r => r.slice());
          if (m[2]) { // A1:O40-style bound
            const colCount = m[2].split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
            const rowCount = Number(m[3]);
            values = values.slice(0, rowCount).map(r => r.slice(0, colCount));
          }
          return { data: { values } };
        }
      }
    }
  };

  class OAuth2 {
    constructor(clientId, clientSecret, redirectUri) {
      this.clientId = clientId; this.clientSecret = clientSecret; this.redirectUri = redirectUri;
      this.credentials = {};
      this._handlers = {};
    }
    generateAuthUrl(opts) {
      return 'https://accounts.google.mock/o/oauth2/auth?client_id=' + this.clientId +
        '&redirect_uri=' + encodeURIComponent(this.redirectUri) +
        '&scope=' + encodeURIComponent(opts.scope || '') + '&access_type=' + (opts.access_type || '');
    }
    async getToken(code) {
      if (!code) throw new Error('mock: missing code');
      return { tokens: { refresh_token: 'mock_refresh_' + code, access_token: 'mock_access', expiry_date: Date.now() + 3600000 } };
    }
    setCredentials(c) { this.credentials = c; }
    on(ev, fn) { this._handlers[ev] = fn; }
  }

  return {
    drive, sheets, OAuth2, files,
    // test helpers
    setTab(fileId, tabName, values) {
      const f = files.get(fileId);
      if (!f) throw new Error('mock: no file ' + fileId);
      f.tabs[tabName] = values;
    },
    setModified(fileId, iso) { files.get(fileId).modifiedTime = iso; },
    trashFile(fileId) { files.get(fileId).trashed = true; }
  };
}

// Install the mock into the real googleapis export. Returns the mock.
function installGoogleMock(fixture) {
  const { google } = require('googleapis');
  const mock = createGoogleMock(fixture || {});
  google.drive = () => mock.drive;
  google.sheets = () => mock.sheets;
  google.auth.OAuth2 = mock.OAuth2;
  return mock;
}

module.exports = { createGoogleMock, installGoogleMock, GSHEET_MIME };
