'use strict';
// Google OAuth 2.0 — the user authorizes ONCE; the refresh token is stored
// AES-encrypted, server-side only, in MongoDB. Access tokens auto-refresh.
const { google } = require('googleapis');
const crypto = require('crypto');
const { config, COLLECTIONS } = require('../config');
const { col } = require('../mongodb');

// Read-only Sheets + Drive metadata/read — minimal scopes.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly'
];

function oauth2Client() {
  const c = config();
  return new google.auth.OAuth2(c.google.clientId, c.google.clientSecret, c.google.redirectUri);
}

// --- Refresh-token storage: AES-256-CBC encrypted -------------------------
function encrypt(plain) {
  const key = Buffer.from(config().tokenKey, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return iv.toString('hex') + ':' + cipher.update(plain, 'utf8', 'hex') + cipher.final('hex');
}

function decrypt(stored) {
  const [ivHex, data] = stored.split(':');
  const key = Buffer.from(config().tokenKey, 'hex');
  const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  return d.update(data, 'hex', 'utf8') + d.final('utf8');
}

async function saveTokens(tokens) {
  await (await col(COLLECTIONS.TOKENS)).updateOne(
    { key: 'google' },
    {
      $set: {
        key: 'google',
        refresh_token: encrypt(tokens.refresh_token),
        access_token: tokens.access_token ? encrypt(tokens.access_token) : '',
        expiry_date: tokens.expiry_date || 0,
        scopes: SCOPES,
        updated_at: new Date()
      }
    },
    { upsert: true }
  );
}

async function isConnected() {
  const row = await (await col(COLLECTIONS.TOKENS)).findOne({ key: 'google' });
  return !!(row && row.refresh_token);
}

// Auth client with automatic refresh.
async function authorizedClient() {
  const row = await (await col(COLLECTIONS.TOKENS)).findOne({ key: 'google' });
  if (!row || !row.refresh_token) {
    const e = new Error('Google not connected. Open /api/auth/google to authorize.');
    e.code = 'GOOGLE_NOT_CONNECTED';
    throw e;
  }
  const client = oauth2Client();
  client.setCredentials({
    refresh_token: decrypt(row.refresh_token),
    expiry_date: row.expiry_date || 0
  });
  client.on('tokens', async t => {
    await (await col(COLLECTIONS.TOKENS)).updateOne(
      { key: 'google' },
      {
        $set: {
          access_token: t.access_token ? encrypt(t.access_token) : row.access_token,
          expiry_date: t.expiry_date || row.expiry_date,
          updated_at: new Date()
        }
      }
    );
  });
  return client;
}

function authorizationUrl() {
  return oauth2Client().generateAuthUrl({
    access_type: 'offline', // ← refresh token
    prompt: 'consent',      // ensure refresh_token is returned on re-auth
    scope: SCOPES.join(' ')
  });
}

module.exports = { SCOPES, authorizationUrl, saveTokens, isConnected, authorizedClient, oauth2Client };
