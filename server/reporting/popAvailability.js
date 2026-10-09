'use strict';
// ← 08_Module_PopAvailability.gs, full port — the 57-POP master module.
// Business rules (validated against real 05–11 Sept data): availability =
// (period_minutes - downtime)/period_minutes*100; sla displayed 0.9999;
// poor threshold < 0.9900 — all read from SYSTEM_CONFIG, never hard-coded here.
const { COLLECTIONS } = require('../config');
const { col } = require('../mongodb');
const { stripTime } = require('../lib/hash');
const { hydrateIncident, persistIncident } = require('../reconciliation');

const POP_TEMPLATE_LAYOUT = { // ← physical template facts, unchanged
  sections: [
    { name: 'IHS', rowStart: 2, rowEnd: 48 },
    { name: 'ipNX', rowStart: 50, rowEnd: 66 },
    { name: 'Others', rowStart: 68, rowEnd: 88 }
  ],
  siteNameCol: 2, durationCol: 'K', outageBlockStartCol: 'L', outageBlockWidth: 4,
  summarySheet: 'SUMMARY', poorPerformingSheet: 'Poor_Performing BTS'
};

const round2 = n => Math.round(n * 100) / 100;

function compareIncidents(a, b) {
  const ta = a.start_time ? a.start_time.getTime() : Infinity;
  const tb = b.start_time ? b.start_time.getTime() : Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.incident_id < b.incident_id ? -1 : a.incident_id > b.incident_id ? 1 : 0;
}

async function calculate(startDate, endDate, systemConfig, opts) {
  const persistNarratives = !opts || opts.persistNarratives !== false;
  const lo = stripTime(startDate), hi = stripTime(endDate);
  const warnings = [];
  const assets = await (await col(COLLECTIONS.ASSETS)).find({ asset_type: 'POP', active: true }).toArray();
  const activeIds = {};
  assets.forEach(a => { activeIds[a.asset_id] = true; });
  const inRange = (await (await col(COLLECTIONS.INCIDENTS))
    .find({ network_category: systemConfig.qualifying_category }).toArray())
    .map(hydrateIncident)
    .filter(i => {
      const d = i.shift_date ? stripTime(i.shift_date) : null;
      return d && d >= lo && d <= hi;
    });
  const incidents = [];
  inRange.forEach(i => {
    if (!i.asset_id) {
      warnings.push(`Incident ${i.incident_id} (${i.node_name_normalized}) has no mapped asset and was excluded.`);
      return;
    }
    if (!activeIds[i.asset_id]) {
      warnings.push(`Incident ${i.incident_id} maps to non-active POP asset "${i.asset_id}" — downtime NOT counted.`);
      return;
    }
    incidents.push(i);
  });
  const open = incidents.filter(i => i.status === 'OPEN');
  if (open.length) {
    warnings.push(open.length + ' incident(s) still OPEN (no restoration recorded); downtime not counted: ' +
      open.map(i => i.node_name_normalized).join(', '));
  }
  const byAsset = {};
  incidents.forEach(inc => { (byAsset[inc.asset_id] = byAsset[inc.asset_id] || []).push(inc); });

  // All 57 POPs are always represented — one entry per asset, zero downtime included.
  const perAsset = assets.map(asset => {
    const assetIncidents = (byAsset[asset.asset_id] || []).slice().sort(compareIncidents);
    const totalDowntime = assetIncidents.reduce((s, i) => s + (Number(i.duration_minutes) || 0), 0);
    const availabilityPct = (systemConfig.period_minutes - totalDowntime) / systemConfig.period_minutes * 100;
    return {
      asset_id: asset.asset_id, canonical_name: asset.canonical_name,
      provider_group: asset.provider_group,
      total_downtime_minutes: round2(totalDowntime),
      availability_pct: round2(availabilityPct),
      sla_status: availabilityPct >= systemConfig.sla_target * 100 ? 'WITHIN_SLA' : 'BELOW_SLA',
      poor_performing: availabilityPct < systemConfig.poor_performing_threshold * 100,
      incident_ids: assetIncidents.map(i => i.incident_id),
      incidents: assetIncidents
    };
  });
  const poorPerforming = perAsset.filter(a => a.poor_performing);
  if (persistNarratives) await buildNarrativeCandidates(poorPerforming); // fills BLANK fields only
  return {
    perAsset, summary: buildProviderSummary(perAsset), poorPerforming,
    needsNarrativeReview: poorPerforming.length > 0, warnings
  };
}

function buildProviderSummary(perAsset) {
  const groups = {};
  perAsset.forEach(a => {
    const g = groups[a.provider_group] = groups[a.provider_group] || { total: 0, withinSla: 0, belowSla: 0, sum: 0 };
    g.total++;
    g.sum += a.availability_pct;
    if (a.sla_status === 'WITHIN_SLA') g.withinSla++; else g.belowSla++;
  });
  return Object.keys(groups).map(g => ({
    provider_group: g, total_sites: groups[g].total,
    within_sla: groups[g].withinSla, below_sla: groups[g].belowSla,
    average_availability: round2(groups[g].sum / groups[g].total)
  }));
}

function longestIncident(incidents) {
  return incidents.slice().sort((x, y) => {
    const d = (Number(y.duration_minutes) || 0) - (Number(x.duration_minutes) || 0);
    return d !== 0 ? d : compareIncidents(x, y);
  })[0];
}

// Candidate narrative = the site's largest incident's OWN RFO text. Strictly
// factual, filled into BLANK fields only — never invents causes/timelines;
// fields stay blank when the source has no RFO (matches the sample).
async function buildNarrativeCandidates(poorPerformingAssets) {
  for (const a of poorPerformingAssets) {
    const longest = longestIncident(a.incidents);
    if (!longest) continue;
    const rfo = longest.rfo_text || '';
    if (!rfo) continue;
    let changed = false;
    if (!longest.issue_text) { longest.issue_text = rfo; changed = true; }
    if (!longest.resolution_text) { longest.resolution_text = rfo; changed = true; }
    if (changed) await persistIncident(longest);
  }
}

async function populateTemplate(startDate, endDate, calc, exportOpts) {
  const { populateTemplateAndExport } = require('../templates/xlsx');
  return populateTemplateAndExport('POP_AVAILABILITY', startDate, endDate, calc, {
    fileName: exportOpts.fileName,
    requiredSheets: [POP_TEMPLATE_LAYOUT.summarySheet, POP_TEMPLATE_LAYOUT.poorPerformingSheet],
    layout: POP_TEMPLATE_LAYOUT
  });
}

// Read-only check that a candidate can hold a full report (connect-template step).
async function validateTemplate() { // Node equivalent: validates against the 57-POP master in ASSETS
  const assets = await (await col(COLLECTIONS.ASSETS)).find({ asset_type: 'POP', active: true }).toArray();
  const errors = [];
  if (assets.length !== 57) errors.push('ASSETS register holds ' + assets.length + ' POPs, expected 57');
  const groups = { IHS: 0, ipNX: 0, Others: 0 };
  assets.forEach(a => { if (groups[a.provider_group] !== undefined) groups[a.provider_group]++; });
  if (groups.IHS !== 30) errors.push('IHS count is ' + groups.IHS + ', expected 30');
  if (groups.ipNX !== 8) errors.push('ipNX count is ' + groups.ipNX + ', expected 8');
  if (groups.Others !== 19) errors.push('Others count is ' + groups.Others + ', expected 19');
  return {
    ok: errors.length === 0, errors,
    sheetNames: ['POP_AVAILABILITY', 'SUMMARY', 'Poor_Performing BTS'],
    siteRows: assets.length
  };
}

module.exports = { calculate, populateTemplate, validateTemplate, POP_TEMPLATE_LAYOUT, longestIncident };
