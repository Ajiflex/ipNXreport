'use strict';
// ← 05_Mapping.gs, full port. Generic MAPPINGS table discriminated by
// mapping_type; unmapped nodes → PENDING_REVIEW, never guessed; mapping heals
// existing incidents via syncIncidentAssets; blank Outage Type → UNCLASSIFIED.
const { COLLECTIONS } = require('../config');
const { col, upsertMany } = require('../mongodb');
const { hashHex, normalizeNodeName, stripTime } = require('../lib/hash');

const MAPPINGS_HEADERS = ['mapping_id', 'mapping_type', 'source_value_normalized',
  'canonical_value', 'status', 'mapped_by', 'mapped_at'];

const mappingKey = o => o.mapping_type + '|' + o.source_value_normalized;

// ← loadMappingIndex_: in-memory snapshot with a PENDING_REVIEW queue.
async function loadMappingIndex() {
  const idx = { node: {}, outage: {}, knownNodeRows: {}, toQueue: [] };
  (await (await col(COLLECTIONS.MAPPINGS)).find({}).toArray()).forEach(m => {
    if (m.mapping_type === 'NODE_NAME') {
      idx.knownNodeRows[m.source_value_normalized] = true;
      if (m.status === 'MAPPED' && m.canonical_value) idx.node[m.source_value_normalized] = m.canonical_value;
    } else if (m.mapping_type === 'OUTAGE_TYPE' && m.status === 'MAPPED') {
      idx.outage[m.source_value_normalized] = m.canonical_value;
    }
  });
  return idx;
}

// ← resolveAsset_: returns null when unmapped; enqueues PENDING_REVIEW exactly once.
function resolveAsset(nodeNameNormalized, index) {
  const hit = index.node[nodeNameNormalized];
  if (hit) return hit;
  if (!index.knownNodeRows[nodeNameNormalized]) {
    index.knownNodeRows[nodeNameNormalized] = true;
    index.toQueue.push(nodeNameNormalized);
  }
  return null; // unmapped = gate closed; caller must not guess
}

async function flushMappingQueue(idx) {
  if (!idx.toQueue.length) return 0;
  const rows = idx.toQueue.map(name => ({
    mapping_id: hashHex('NODE_NAME|' + name), mapping_type: 'NODE_NAME',
    source_value_normalized: name, canonical_value: '', status: 'PENDING_REVIEW',
    mapped_by: '', mapped_at: null
  }));
  idx.toQueue = [];
  await upsertMany(COLLECTIONS.MAPPINGS, mappingKey, rows, existing => existing); // never duplicate a queued name
  return rows.length;
}

// ← resolveCategory_: blank → 'UNCLASSIFIED', else mapped or uppercased raw.
function resolveCategory(rawOutageType, index) {
  const key = String(rawOutageType || '').trim().toUpperCase();
  if (key === '') return 'UNCLASSIFIED'; // never silently merged into a real category
  return (index && index.outage[key]) || key;
}

async function getUnknownNodeNames() {
  return (await (await col(COLLECTIONS.MAPPINGS))
    .find({ mapping_type: 'NODE_NAME', status: 'PENDING_REVIEW' }).toArray())
    .map(m => m.source_value_normalized);
}

// ← getBlockingUnknownNodeNames_: report gate — only unresolved incidents in
// THIS category + range block.
async function getBlockingUnknownNodeNames(qualifyingCategory, startDate, endDate) {
  const idx = await loadMappingIndex();
  const lo = stripTime(startDate), hi = stripTime(endDate);
  const names = {};
  (await (await col(COLLECTIONS.INCIDENTS)).find({ network_category: qualifyingCategory }).toArray())
    .forEach(i => {
      const d = i.shift_date ? stripTime(new Date(i.shift_date)) : null;
      if (!d || d < lo || d > hi) return;
      if (i.asset_id) return;
      if (idx.node[i.node_name_normalized]) return; // mapped since creation — resolvable
      names[i.node_name_normalized] = true;
    });
  return Object.keys(names);
}

// ← syncIncidentAssets_: heal incidents whose node got mapped (any route).
// Idempotent.
async function syncIncidentAssets(index, onlyNode) {
  const idx = index || await loadMappingIndex();
  const now = new Date();
  const fixes = [];
  (await (await col(COLLECTIONS.INCIDENTS)).find({ asset_id: { $in: ['', null] } }).toArray())
    .forEach(i => {
      if (onlyNode && i.node_name_normalized !== onlyNode) return;
      const assetId = idx.node[i.node_name_normalized];
      if (!assetId) return;
      fixes.push({ ...i, asset_id: assetId, updated_at: now });
    });
  if (fixes.length) await upsertMany(COLLECTIONS.INCIDENTS, o => o.incident_id, fixes);
  return fixes.length;
}

// mapNodeName(source, assetId, mappedBy): validates the asset exists in
// ASSETS, upserts MAPPED, and immediately heals incidents.
async function mapNodeName(sourceValue, canonicalAssetId, mappedBy) {
  const source = normalizeNodeName(sourceValue);
  if (!source) throw new Error('mapNodeName: empty node name');
  const asset = await (await col(COLLECTIONS.ASSETS)).findOne({ asset_id: canonicalAssetId });
  if (!asset) throw new Error('mapNodeName: unknown asset_id "' + canonicalAssetId + '" (not in ASSETS)');
  await upsertMany(COLLECTIONS.MAPPINGS, mappingKey, [{
    mapping_id: hashHex('NODE_NAME|' + source), mapping_type: 'NODE_NAME',
    source_value_normalized: source, canonical_value: canonicalAssetId,
    status: 'MAPPED', mapped_by: mappedBy || 'operator', mapped_at: new Date()
  }]);
  const healed = await syncIncidentAssets(null, source); // heal historical incidents immediately
  return { mappingId: hashHex('NODE_NAME|' + source), incidentsResolved: healed };
}

module.exports = {
  MAPPINGS_HEADERS, mappingKey, loadMappingIndex, resolveAsset, flushMappingQueue,
  resolveCategory, getUnknownNodeNames, getBlockingUnknownNodeNames, syncIncidentAssets, mapNodeName
};
