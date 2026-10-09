'use strict';
// ← 00_Config.gs. Env vars replace Apps Script Script Properties.
// validateConfiguration_ equivalent: `required()` throws one clear error
// naming every missing variable when the platform boots without it.

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing environment variable: ' + name);
  return v;
}

function config() {
  return {
    operationalSheetId: process.env.OPERATIONAL_SHEET_ID || '',
    operationalFolderId: process.env.GOOGLE_OPERATIONAL_FOLDER_ID || '',
    archiveFolderId: process.env.GOOGLE_ARCHIVE_FOLDER_ID || '',
    mongoUri: required('MONGODB_URI'),
    mongoDb: process.env.MONGODB_DB_NAME || 'ipnx_report',
    google: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
      redirectUri: required('GOOGLE_REDIRECT_URI')
    },
    cronSecret: required('CRON_SECRET'),
    tokenKey: required('TOKEN_ENCRYPTION_KEY'),
    appBaseUrl: process.env.APP_BASE_URL || '',
    appApiKey: process.env.APP_API_KEY || ''
  };
}

// TABS-equivalent: Mongo collection names.
const COLLECTIONS = {
  RAW_EVENTS: 'raw_events',
  MAPPINGS: 'mappings',
  ASSETS: 'assets',
  INCIDENTS: 'incidents',
  REPORT_PERIODS: 'report_periods',
  WEEKLY_RESULTS: 'weekly_results',
  REPORT_ARCHIVE: 'report_archive',
  SYSTEM_CONFIG: 'config',
  INGESTION_LOG: 'ingestion_log',
  SOURCES: 'sources',
  SOURCE_TABS: 'source_tabs',
  REPORT_EXCEPTIONS: 'report_exceptions',
  SYNC_RUNS: 'sync_runs',
  LOCKS: 'locks',
  TOKENS: 'tokens'
};

// ← SYSTEM_CONFIG_HEADERS + seedSystemConfig_(): the ONLY place tunables live.
// The engine never hard-codes thresholds.
const SYSTEM_CONFIG_HEADERS = [
  'report_type', 'qualifying_category', 'period_minutes', 'sla_target',
  'poor_performing_threshold', 'narrative_requires_review', 'template_key'
];

function seedSystemConfig() {
  return [{
    report_type: 'POP_AVAILABILITY',
    qualifying_category: 'POP',
    period_minutes: 10080, // 7 days
    sla_target: 0.9999,
    poor_performing_threshold: 0.9900, // deliberately independent of sla_target
    narrative_requires_review: true,
    template_key: 'POP_AVAILABILITY'
  }];
}

module.exports = { config, required, COLLECTIONS, SYSTEM_CONFIG_HEADERS, seedSystemConfig };
