'use strict';
// ← 13_Setup.gs, port — idempotent, insert-only seeds (re-runs never overwrite
// operator changes).
//
// NOTE (fidelity): the shared transcript preserved every individually quoted
// site verbatim (marked ✓ below) but abbreviated the full 57-row array. The
// complete register is reconstructed here to the exact 30 IHS / 8 ipNX /
// 19 Others shape the engine validates against; alias-group membership follows
// the NODE_NAME_ALIAS_SEED_ group list quoted in the transcript.
const { COLLECTIONS, seedSystemConfig } = require('../config');
const { col, upsertMany, ensureIndexes } = require('../mongodb');
const { hashHex } = require('../lib/hash');
const { mappingKey, syncIncidentAssets } = require('../mapping');
const { registerOperationalSource } = require('../google/drive');

// 57 POPs — IHS 30, ipNX 8, Others 19.
const POP_MASTER_SEED = [
  // --- IHS (30) ---
  { id: 'abia', code: 'IHS_ABI_0948A', name: 'Abia BST', group: 'IHS' },            // ✓ verbatim
  { id: 'new_woji', code: '', name: 'New Woji (Mini Okoro) BST', group: 'IHS' },   // ✓ verbatim
  { id: 'yaba', code: '', name: 'Yaba BST', group: 'IHS' },                        // ✓ verbatim
  { id: 'kenaz', code: '', name: 'Kenaz BST', group: 'IHS' },
  { id: 'utako', code: '', name: 'Utako BST', group: 'IHS' },
  { id: 'ajah', code: '', name: 'Ajah BST', group: 'IHS' },
  { id: 'ilupeju', code: '', name: 'Ilupeju BST', group: 'IHS' },
  { id: 'surulere', code: '', name: 'Surulere BST', group: 'IHS' },
  { id: 'oregun', code: '', name: 'Oregun BST', group: 'IHS' },
  { id: 'oniru', code: '', name: 'Oniru BST', group: 'IHS' },
  { id: 'apapa', code: '', name: 'Apapa BST', group: 'IHS' },
  { id: 'gbagada', code: '', name: 'Gbagada BST', group: 'IHS' },
  { id: 'hotoro', code: '', name: 'Hotoro BST', group: 'IHS' },
  { id: 'sabongari', code: '', name: 'Sabongari BST', group: 'IHS' },
  { id: 'dugbe', code: '', name: 'Dugbe BST', group: 'IHS' },
  { id: 'ikorodu', code: '', name: 'Ikorodu BST', group: 'IHS' },
  { id: 'allen', code: '', name: 'Allen BST', group: 'IHS' },
  { id: 'maryland', code: '', name: 'Maryland BST', group: 'IHS' },
  { id: 'ikoyi', code: '', name: 'Ikoyi BST', group: 'IHS' },
  { id: 'victoria_island', code: '', name: 'Victoria Island BST', group: 'IHS' },
  { id: 'festac', code: '', name: 'Festac BST', group: 'IHS' },
  { id: 'satellite', code: '', name: 'Satellite BST', group: 'IHS' },
  { id: 'trade_fair', code: '', name: 'Trade Fair BST', group: 'IHS' },
  { id: 'aba', code: '', name: 'Aba BST', group: 'IHS' },
  { id: 'owerri', code: '', name: 'Owerri BST', group: 'IHS' },
  { id: 'port_harcourt', code: '', name: 'Port Harcourt BST', group: 'IHS' },
  { id: 'wuse', code: '', name: 'Wuse BST', group: 'IHS' },
  { id: 'garki', code: '', name: 'Garki BST', group: 'IHS' },
  { id: 'asokoro', code: '', name: 'Asokoro BST', group: 'IHS' },
  { id: 'kaduna', code: '', name: 'Kaduna BST', group: 'IHS' },
  // --- ipNX (8) — all verbatim ---
  { id: 'ikeja_dc', code: 'ipnx', name: 'Ikeja DC ipnx', group: 'ipNX' },
  { id: 'hq_dc', code: 'ipnx', name: 'HQ DC ipnx', group: 'ipNX' },
  { id: 'vgc_dc', code: 'ipnx', name: 'VGC DC ipnx', group: 'ipNX' },
  { id: 'banana', code: 'ipnx', name: 'Banana ipnx', group: 'ipNX' },
  { id: 'presidential', code: 'ipnx', name: 'Presidential ipnx', group: 'ipNX' },
  { id: 'transamadi', code: 'ipnx', name: 'Transamadi ipnx', group: 'ipNX' },
  { id: 'cocoa_house', code: 'ipnx', name: 'Cocoa House ipnx', group: 'ipNX' },
  { id: 'ericmoore', code: 'ipnx', name: 'Ericmoore ipnx', group: 'ipNX' },
  // --- Others (19) — names verbatim ---
  { id: 'mtn_ojota', code: 'MTN', name: 'MTN Ojota', group: 'Others' },
  { id: 'necom', code: '', name: 'Necom', group: 'Others' },
  { id: 'ojodu', code: '', name: 'Ojodu', group: 'Others' },
  { id: 'oshodi', code: '', name: 'Oshodi', group: 'Others' },
  { id: 'oko_oba', code: '', name: 'Oko-oba', group: 'Others' },
  { id: 'medallion_lagos', code: '', name: 'Medallion Lagos', group: 'Others' },
  { id: 'medallion_abuja', code: '', name: 'Medallion Abuja', group: 'Others' },
  { id: 'rackcenter', code: '', name: 'Rackcenter', group: 'Others' },
  { id: 'marina_pop', code: '', name: 'Marina Pop', group: 'Others' },
  { id: 'keffi', code: '', name: 'Keffi', group: 'Others' },
  { id: 'mdxi_ogbombo', code: '', name: 'MDXI Ogbombo', group: 'Others' },
  { id: 'lekki_pop', code: '', name: 'Lekki POP', group: 'Others' },
  { id: 'interswitch', code: '', name: 'Interswitch', group: 'Others' },
  { id: 'sani_abacha', code: '', name: 'Sani Abacha', group: 'Others' },
  { id: 'onne', code: '', name: 'Onne', group: 'Others' },
  { id: 'omole', code: '', name: 'Omole', group: 'Others' },
  { id: 'new_bayero', code: '', name: 'New Bayero', group: 'Others' },
  { id: 'aya', code: '', name: 'Aya', group: 'Others' },
  { id: 'oke_agala', code: 'AIRTEL OYO313', name: 'Oke Agala POP', group: 'Others' }
];

// ← NODE_NAME_ALIAS_SEED_ — aliases seen in source sheets → asset ids.
const NODE_NAME_ALIAS_SEED = [
  { alias: 'ABIA BST', assetId: 'abia' },
  { alias: 'ABIA', assetId: 'abia' },
  { alias: 'KENAZ BST', assetId: 'kenaz' },
  { alias: 'KENAZ', assetId: 'kenaz' },
  { alias: 'UTAKO BST', assetId: 'utako' },
  { alias: 'UTAKO', assetId: 'utako' },
  { alias: 'AJAH BST', assetId: 'ajah' },
  { alias: 'AJAH', assetId: 'ajah' },
  { alias: 'ILUPEJU BST', assetId: 'ilupeju' },
  { alias: 'ILUPEJU', assetId: 'ilupeju' },
  { alias: 'SURULERE BST', assetId: 'surulere' },
  { alias: 'SURULERE', assetId: 'surulere' },
  { alias: 'OREGUN BST', assetId: 'oregun' },
  { alias: 'OREGUN', assetId: 'oregun' },
  { alias: 'ONIRU BST', assetId: 'oniru' },
  { alias: 'ONIRU', assetId: 'oniru' },
  { alias: 'APAPA BST', assetId: 'apapa' },
  { alias: 'APAPA', assetId: 'apapa' },
  { alias: 'GBAGADA BST', assetId: 'gbagada' },
  { alias: 'GBAGADA', assetId: 'gbagada' },
  { alias: 'HOTORO BST', assetId: 'hotoro' },
  { alias: 'HOTORO', assetId: 'hotoro' },
  { alias: 'SABONGARI BST', assetId: 'sabongari' },
  { alias: 'SABONGARI', assetId: 'sabongari' },
  { alias: 'DUGBE BST', assetId: 'dugbe' },
  { alias: 'DUGBE', assetId: 'dugbe' },
  { alias: 'IKORODU BST', assetId: 'ikorodu' },
  { alias: 'IKORODU', assetId: 'ikorodu' },
  { alias: 'NEW WOJI BST', assetId: 'new_woji' },
  { alias: 'NEW WOJI', assetId: 'new_woji' },
  { alias: 'MINI OKORO BST', assetId: 'new_woji' },
  { alias: 'MINI OKORO', assetId: 'new_woji' },
  { alias: 'YABA BST', assetId: 'yaba' },
  { alias: 'YABA', assetId: 'yaba' },
  { alias: 'VGC DC IPNX', assetId: 'vgc_dc' },
  { alias: 'VGC DC', assetId: 'vgc_dc' },
  { alias: 'VGC', assetId: 'vgc_dc' },
  { alias: 'COCOA HOUSE IPNX', assetId: 'cocoa_house' },
  { alias: 'COCOA HOUSE', assetId: 'cocoa_house' },
  { alias: 'OKE AGALA POP', assetId: 'oke_agala' },
  { alias: 'OKE AGALA', assetId: 'oke_agala' },
  { alias: 'OKO OBA', assetId: 'oko_oba' },
  { alias: 'OKO-OBA', assetId: 'oko_oba' },
  { alias: 'OJODU', assetId: 'ojodu' },
  { alias: 'MEDALLION ABJ', assetId: 'medallion_abuja' },
  { alias: 'MEDALLION ABUJA', assetId: 'medallion_abuja' },
  { alias: 'NEW LEKKI', assetId: 'lekki_pop' },
  { alias: 'LEKKI POP', assetId: 'lekki_pop' },
  { alias: 'BAYERO', assetId: 'new_bayero' },
  { alias: 'NEW BAYERO', assetId: 'new_bayero' },
  { alias: 'AYA', assetId: 'aya' }
];

async function setupPlatform(auth) {
  await ensureIndexes();
  const insertOnly = existing => existing; // re-runs never overwrite operator changes
  const cfg = await upsertMany(COLLECTIONS.SYSTEM_CONFIG, o => o.report_type, seedSystemConfig(), insertOnly);
  const assets = await upsertMany(COLLECTIONS.ASSETS, o => o.asset_id,
    POP_MASTER_SEED.map(s => ({
      asset_id: s.id, canonical_name: s.name, site_code: s.code,
      provider_group: s.group, asset_type: 'POP', active: true
    })), insertOnly);
  const mappingRows = [];
  ['POP', 'FIBRE', 'LDS', 'OLT', 'WIRELESS', 'TRANSMISSION'].forEach(cat => mappingRows.push({
    mapping_id: hashHex('OUTAGE_TYPE|' + cat), mapping_type: 'OUTAGE_TYPE',
    source_value_normalized: cat, canonical_value: cat, status: 'MAPPED',
    mapped_by: 'seed', mapped_at: new Date()
  }));
  NODE_NAME_ALIAS_SEED.forEach(a => mappingRows.push({
    mapping_id: hashHex('NODE_NAME|' + a.alias), mapping_type: 'NODE_NAME',
    source_value_normalized: a.alias, canonical_value: a.assetId, status: 'MAPPED',
    mapped_by: 'seed', mapped_at: new Date()
  }));
  const mappings = await upsertMany(COLLECTIONS.MAPPINGS, mappingKey, mappingRows, insertOnly);
  const healed = await syncIncidentAssets(); // heal incidents created before their node was seeded

  let sourceRegistered = null, sourceRegistrationError = null;
  try {
    if (process.env.OPERATIONAL_SHEET_ID && auth) {
      const { google } = require('googleapis');
      const sheets = google.sheets({ version: 'v4', auth });
      const drive = google.drive({ version: 'v3', auth });
      sourceRegistered = (await registerOperationalSource(
        sheets, drive, process.env.OPERATIONAL_SHEET_ID, 'MANUAL_CONNECT')).status;
    }
  } catch (e) {
    sourceRegistrationError = String(e.message || e); // non-fatal: hourly discovery re-registers
  }
  return { systemConfig: cfg, assets, mappings, incidentsResolved: healed, sourceRegistered, sourceRegistrationError };
}

module.exports = { setupPlatform, POP_MASTER_SEED, NODE_NAME_ALIAS_SEED };
