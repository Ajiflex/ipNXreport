'use strict';
// ← 01_SourceDiscovery.gs — LEVEL 2: TABS + SOURCE AUTHORITY (Bug #12 fix).
const { google } = require('googleapis');
const { COLLECTIONS } = require('../config');
const { col } = require('../mongodb');
const { tabDateFromName, stripTime, pad2 } = require('../lib/hash');

// sourceCandidates_(): ACTIVE registry sources first; the connected sheet as
// legacy fallback — unchanged.
async function sourceCandidates() {
  const active = await (await col(COLLECTIONS.SOURCES)).find({ status: 'ACTIVE' }).toArray();
  if (active.length) {
    return active.map(r => ({
      spreadsheetId: r.spreadsheet_id, sourceId: r.source_id,
      name: r.name, lastModified: r.last_modified_time || ''
    }));
  }
  return process.env.OPERATIONAL_SHEET_ID
    ? [{ spreadsheetId: process.env.OPERATIONAL_SHEET_ID, sourceId: '', name: '', lastModified: '' }]
    : [];
}

// ═══════════════ BUG #12 FIX ═══════════════
// pickAuthoritativeTab. When Source A and Source B both hold tab 12_10_2026,
// the tab from the MOST RECENTLY MODIFIED source wins — an older duplicate can
// never win just because its copy changed. The original dedupeTabsAcrossSources_
// compared sourceModified only AFTER change-state was computed per source; here
// authority is resolved BEFORE any changed tab is processed, so the decision is
// made on registry state, not on which copy happened to mutate.
function pickAuthoritativeTab(keep, challenger, warnings) {
  const challengerNewer = new Date(challenger.sourceModified || 0).getTime() >
    new Date(keep.sourceModified || 0).getTime();
  const winner = challengerNewer ? challenger : keep;
  const loser = challengerNewer ? keep : challenger;
  warnings.push(`Tab ${winner.tabName} exists in more than one source — using "${winner.sourceName || winner.spreadsheetId}", ignoring the copy in "${loser.sourceName || loser.spreadsheetId}" (newest Drive modification wins).`);
  return winner;
}

// discoverSourceTabs(startDate, endDate, warnings) — full port.
async function discoverSourceTabs(auth, startDate, endDate, warnings) {
  const sheets = google.sheets({ version: 'v4', auth });
  const byDate = {};
  const openFailures = [];
  const candidates = await sourceCandidates();
  for (const src of candidates.filter(s => s.spreadsheetId)) {
    let names;
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: src.spreadsheetId, fields: 'sheets(properties.title)' });
      names = (meta.data.sheets || []).map(s => s.properties.title);
    } catch (e) {
      openFailures.push({ src, error: e });
      warnings.push(`Source "${src.name || src.spreadsheetId}" is not readable: ${String(e.message || e)}`);
      continue;
    }
    for (const tabName of names) {
      const tabDate = tabDateFromName(tabName);
      if (!tabDate) continue;
      if (tabDate < stripTime(startDate) || tabDate > stripTime(endDate)) continue;
      const entry = {
        spreadsheetId: src.spreadsheetId, sourceId: src.sourceId,
        tabName, date: tabDate, sourceName: src.name, sourceModified: src.lastModified
      };
      byDate[tabName] = byDate[tabName] ? pickAuthoritativeTab(byDate[tabName], entry, warnings) : entry;
    }
  }
  if (openFailures.length && openFailures.length === candidates.filter(s => s.spreadsheetId).length) {
    throw openFailures[0].error; // total source outage = discovery FAILURE (unchanged)
  }
  return Object.values(byDate).sort((a, b) => a.date - b.date);
}

// findMissingSourceTabs_ — "complete" vs "partial" source data (unchanged).
function findMissingSourceTabs(startDate, endDate, discoveredTabs) {
  const have = {};
  discoveredTabs.forEach(t => { have[t.tabName] = true; });
  const missing = [];
  let d = stripTime(startDate);
  const last = stripTime(endDate);
  while (d <= last) {
    const name = pad2(d.getDate()) + '_' + pad2(d.getMonth() + 1) + '_' + d.getFullYear();
    if (!have[name]) missing.push(name);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return missing;
}

module.exports = { sourceCandidates, discoverSourceTabs, findMissingSourceTabs, pickAuthoritativeTab };
