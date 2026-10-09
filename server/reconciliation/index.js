'use strict';
// ← 06_Reconciliation.gs, faithful port. Events (raw rows) are folded into
// incidents per (node, category); membership idempotency means a re-run never
// duplicates an incident; a September incident is RESUMED by an October
// observation of the same still-open outage.
const { COLLECTIONS } = require('../config');
const { col, upsertMany } = require('../mongodb');
const { hashHex, stripTime } = require('../lib/hash');
const {
  loadMappingIndex, resolveAsset, resolveCategory, flushMappingQueue, syncIncidentAssets
} = require('../mapping');

const INCIDENTS_HEADERS = ['incident_id', 'asset_id', 'node_name_normalized', 'raw_outage_type',
  'network_category', 'shift_date', 'start_time', 'end_time', 'duration_minutes', 'status',
  'rfo_text', 'issue_text', 'resolution_text', 'raw_refs', 'created_at', 'updated_at'];

const toDate = v => (v === '' || v == null) ? null
  : (v instanceof Date ? v : (isNaN(new Date(v).getTime()) ? null : new Date(v)));

const parseRefs = json => {
  try { const r = JSON.parse(json || '[]'); return Array.isArray(r) ? r : []; }
  catch { return []; }
};
const appendRawRef = (refsJson, rawId) => {
  const r = parseRefs(refsJson);
  if (!r.includes(rawId)) r.push(rawId);
  return JSON.stringify(r);
};

// Deterministic order: outage_time (missing=last), then shift_date,
// Day-before-Night, source_row, raw_id — re-runs always process identically.
function compareEvents(a, b) {
  const ka = (toDate(a.outage_time) || { getTime: () => Infinity }).getTime();
  const kb = (toDate(b.outage_time) || { getTime: () => Infinity }).getTime();
  if (ka !== kb) return ka < kb ? -1 : 1;
  const da = (toDate(a.shift_date) || { getTime: () => 0 }).getTime();
  const db = (toDate(b.shift_date) || { getTime: () => 0 }).getTime();
  if (da !== db) return da - db;
  const ba = a.source_block === 'Night' ? 1 : 0, bb = b.source_block === 'Night' ? 1 : 0;
  if (ba !== bb) return ba - bb;
  const ra = Number(a.source_row) || 0, rb = Number(b.source_row) || 0;
  if (ra !== rb) return ra - rb;
  return a.raw_id < b.raw_id ? -1 : a.raw_id > b.raw_id ? 1 : 0;
}

function hydrateIncident(doc) {
  return {
    ...doc,
    shift_date: toDate(doc.shift_date),
    start_time: toDate(doc.start_time),
    end_time: toDate(doc.end_time),
    duration_minutes: (doc.duration_minutes === '' || doc.duration_minutes == null) ? null : Number(doc.duration_minutes),
    asset_id: doc.asset_id || '',
    raw_refs: doc.raw_refs || '[]'
  };
}

function incidentSignature(i) {
  return [
    i.asset_id, i.status,
    i.start_time ? i.start_time.getTime() : '',
    i.end_time ? i.end_time.getTime() : '',
    i.duration_minutes === null ? '' : i.duration_minutes,
    i.rfo_text, i.raw_refs,
    i.shift_date ? i.shift_date.getTime() : ''
  ].join('|');
}

function computeDuration(start, end, rawFallback) {
  let minutes;
  if (start && end) minutes = (new Date(end) - new Date(start)) / 60000;
  else if (rawFallback !== null && rawFallback !== undefined) minutes = rawFallback;
  else return null;
  return Math.abs(minutes - Math.round(minutes)) < 0.01 ? Math.round(minutes) : minutes; // float-noise normalize
}

function applyEventToIncident(inc, ev) {
  const t = toDate(ev.outage_time), s = toDate(ev.shift_date);
  if (t && (!inc.start_time || t.getTime() < inc.start_time.getTime())) inc.start_time = t;
  if (s && (!inc.shift_date || s.getTime() < inc.shift_date.getTime())) inc.shift_date = s;
  inc.raw_refs = appendRawRef(inc.raw_refs, ev.raw_id);
  const restoration = toDate(ev.restoration_time);
  const rawDur = (ev.duration_raw_minutes === '' || ev.duration_raw_minutes == null) ? null : Number(ev.duration_raw_minutes);
  if (restoration || rawDur !== null) { // completion = restoration OR typed duration
    inc.end_time = restoration || inc.end_time; // a missing RFO does NOT close an incident
    inc.duration_minutes = computeDuration(inc.start_time, inc.end_time, rawDur);
    inc.status = 'CLOSED';
    if (ev.rfo_text) inc.rfo_text = ev.rfo_text;
  }
}

function newIncidentFromEvent(ev, nodeName, category, idx) {
  const now = new Date();
  return {
    incident_id: 'INC-' + hashHex(nodeName + '||' + category + '||' + ev.raw_id), // deterministic id
    asset_id: resolveAsset(nodeName, idx) || '', // '' = mapping gate open
    node_name_normalized: nodeName,
    raw_outage_type: ev.raw_outage_type, // verbatim
    network_category: category,
    shift_date: toDate(ev.shift_date), // ownership: the TAB's date, never clock time
    start_time: toDate(ev.outage_time),
    end_time: null, duration_minutes: null, status: 'OPEN',
    rfo_text: ev.rfo_text || '', issue_text: '', resolution_text: '',
    raw_refs: JSON.stringify([ev.raw_id]),
    created_at: now, updated_at: now
  };
}

// Latest OPEN incident of the (node, category) group starting no later than
// the event — evaluated live, so an incident closed earlier in THIS run is
// excluded.
function findResumableIncident(groupIncidents, ev) {
  const t = toDate(ev.outage_time);
  const open = groupIncidents.filter(i => {
    if (i.status !== 'OPEN') return false;
    if (!t || !i.start_time) return true;
    return i.start_time.getTime() <= t.getTime();
  });
  open.sort((a, b) => ((b.start_time ? b.start_time.getTime() : 0) - (a.start_time ? a.start_time.getTime() : 0)));
  return open[0] || null;
}

async function reconcileEvents(startDate, endDate) {
  const lo = stripTime(startDate), hi = stripTime(endDate);
  const raw = await (await col(COLLECTIONS.RAW_EVENTS)).find({
    shift_date: { $gte: lo, $lte: new Date(hi.getFullYear(), hi.getMonth(), hi.getDate(), 23, 59, 59, 999) }
  }).toArray();
  const idx = await loadMappingIndex();
  const byGroup = {};
  let unclassified = 0, missingTime = 0;
  raw.forEach(r => {
    const category = resolveCategory(r.raw_outage_type, idx);
    if (category === 'UNCLASSIFIED') unclassified++;
    if (!toDate(r.outage_time)) missingTime++;
    const key = r.node_name_normalized + '||' + category; // category-aware: POP ≠ Fibre ≠ LDS ≠ OLT ≠ Wireless
    (byGroup[key] = byGroup[key] || { nodeName: r.node_name_normalized, category, events: [] }).events.push(r);
  });

  const existing = (await (await col(COLLECTIONS.INCIDENTS)).find({}).toArray()).map(hydrateIncident);
  const existingByGroup = {}, ownerOf = {};
  existing.forEach(inc => {
    const key = inc.node_name_normalized + '||' + inc.network_category;
    (existingByGroup[key] = existingByGroup[key] || []).push(inc);
    parseRefs(inc.raw_refs).forEach(id => { ownerOf[id] = inc; }); // MEMBERSHIP idempotency (OPEN and CLOSED)
  });

  const touched = {}, referenced = {};
  let created = 0;
  for (const key of Object.keys(byGroup)) {
    const group = byGroup[key];
    const groupIncidents = existingByGroup[key] = existingByGroup[key] || [];
    const events = group.events.slice().sort(compareEvents);
    for (const ev of events) {
      let inc = ownerOf[ev.raw_id] || null; // known event → re-apply to its owner, never a new incident
      let isNew = false;
      if (!inc) {
        inc = findResumableIncident(groupIncidents, ev);
        if (!inc) {
          inc = newIncidentFromEvent(ev, group.nodeName, group.category, idx);
          groupIncidents.push(inc);
          isNew = true;
          created++;
        }
        ownerOf[ev.raw_id] = inc;
      }
      referenced[inc.incident_id] = true;
      const before = incidentSignature(inc);
      applyEventToIncident(inc, ev); // picks up source corrections (restoration filled in, duration edited)
      if (!inc.asset_id) inc.asset_id = resolveAsset(group.nodeName, idx) || '';
      if (isNew || incidentSignature(inc) !== before) {
        if (!isNew) inc.updated_at = new Date();
        touched[inc.incident_id] = inc;
      }
    }
  }
  const queuedUnknowns = await flushMappingQueue(idx);
  const toWrite = Object.values(touched);
  if (toWrite.length) await upsertMany(COLLECTIONS.INCIDENTS, o => o.incident_id, toWrite);
  const assetsResolved = await syncIncidentAssets(idx); // heal via any mapping route
  const closed = toWrite.filter(i => i.status === 'CLOSED').length;
  return {
    groupsProcessed: Object.keys(byGroup).length,
    incidentsCreated: created,
    incidentsChanged: toWrite.length - created,
    incidentsUnchanged: Object.keys(referenced).length - toWrite.length,
    closedIncidents: closed,
    newUnknownMappings: queuedUnknowns,
    assetsResolved,
    unclassifiedEvents: unclassified,
    eventsMissingOutageTime: missingTime
  };
}

async function persistIncident(incident) {
  // Single-incident save keyed directly on incident_id, so it updates in place
  // regardless of how the row was originally written.
  const c = await col(COLLECTIONS.INCIDENTS);
  const { _id, _k, ...doc } = incident;
  await c.updateOne({ incident_id: incident.incident_id },
    { $set: { ...doc, _k: incident.incident_id } }, { upsert: true });
}

module.exports = { INCIDENTS_HEADERS, reconcileEvents, persistIncident, hydrateIncident, computeDuration };
