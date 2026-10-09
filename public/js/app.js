/* Dashboard client — talks only to /api/*. The engine never runs in the browser. */
'use strict';

const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function api(path, opts) {
  const r = await fetch(path, opts ? {
    method: opts.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  } : undefined);
  if (r.status === 302 || r.redirected) return { ok: true, redirected: true };
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { ok: false, error: { message: text.slice(0, 200) } }; }
  return body;
}

function alertBox(msg, isErr) {
  const div = document.createElement('div');
  div.className = 'alert' + (isErr ? ' err' : '');
  div.textContent = msg;
  $('#alerts').appendChild(div);
  setTimeout(() => div.remove(), 8000);
}

function badge(el, ok, label) {
  el.className = 'badge ' + (ok ? 'badge-ok' : 'badge-bad');
  el.textContent = label;
}

async function refresh() {
  const boot = await api('/api/bootstrap');
  if (!boot.ok) {
    badge($('#connBadge'), false, 'API error');
    alertBox(boot.error && boot.error.message || 'Bootstrap failed', true);
    return;
  }
  badge($('#connBadge'), boot.google.connected,
    boot.google.connected ? 'Google connected' : 'Google NOT connected');

  const c = boot.counts || {};
  $('#statCards').innerHTML = [
    ['Active sources', c.sources], ['Source tabs', c.sourceTabs], ['Raw events', c.rawEvents],
    ['Incidents', c.incidents], ['Reports', c.reports],
    ['Open exceptions', c.openExceptions], ['Pending mappings', c.pendingMappings]
  ].map(([l, n]) => `<div class="card"><div class="n">${esc(n ?? 0)}</div><div class="l">${esc(l)}</div></div>`).join('');

  $('#lastSync').textContent = boot.lastSync
    ? JSON.stringify(boot.lastSync, (k, v) => k === '_id' || k === '_k' ? undefined : v, 2)
    : 'No sync run yet.';

  const reports = await api('/api/reports');
  $('#reportsTable tbody').innerHTML = (reports.reports || []).map(r => `
    <tr>
      <td>${esc(r.period_id)}</td>
      <td>${esc(r.status)}</td>
      <td>${esc(r.revision)}</td>
      <td>${esc(r.generated_at ? new Date(r.generated_at).toLocaleString() : '')}</td>
      <td>${esc(r.file_name)}</td>
      <td><a href="/api/reports/${encodeURIComponent(r.period_id)}/download">Download</a></td>
    </tr>`).join('') || '<tr><td colspan="6">No reports yet.</td></tr>';

  const sources = await api('/api/sources');
  $('#sourcesTable tbody').innerHTML = (sources.sources || []).map(s => `
    <tr>
      <td>${esc(s.name || s.drive_file_id)}</td>
      <td>${esc(s.status)}</td>
      <td>${esc(s.discovery_method)}</td>
      <td>${esc(s.tab_count)}</td>
      <td>${esc(s.last_ingested_at ? new Date(s.last_ingested_at).toLocaleString() : '—')}</td>
    </tr>`).join('') || '<tr><td colspan="5">No sources discovered yet.</td></tr>';

  const exc = await api('/api/exceptions');
  $('#exceptionsTable tbody').innerHTML = (exc.exceptions || []).map(x => `
    <tr>
      <td>${esc(x.period_id || '')}</td>
      <td>${esc(x.exception_type || x.type || '')}</td>
      <td>${esc((x.message || x.reason || '').slice(0, 160))}</td>
      <td>${esc(x.status)}</td>
      <td>${x.status === 'OPEN' ? `<button class="btn" data-retry="${esc(x.exception_id)}">Retry</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="5">No exceptions.</td></tr>';
  document.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', async () => {
    const r = await api('/api/exceptions/' + encodeURIComponent(b.dataset.retry) + '/retry', { method: 'POST' });
    alertBox(r.ok ? 'Exception queued for retry.' : (r.error && r.error.message) || 'Retry failed', !r.ok);
    refresh();
  }));

  const map = await api('/api/mappings');
  const assets = map.assets || [];
  $('#mappingsTable tbody').innerHTML = (map.pending || []).map(name => `
    <tr>
      <td class="mono">${esc(name)}</td>
      <td><select data-map-sel="${esc(name)}">
        <option value="">— choose asset —</option>
        ${assets.map(a => `<option value="${esc(a.asset_id)}">${esc(a.canonical_name)} (${esc(a.provider_group)})</option>`).join('')}
      </select></td>
      <td><button class="btn" data-map="${esc(name)}">Map</button></td>
    </tr>`).join('') || '<tr><td colspan="3">Nothing pending review.</td></tr>';
  document.querySelectorAll('[data-map]').forEach(b => b.addEventListener('click', async () => {
    const sel = document.querySelector(`[data-map-sel="${CSS.escape(b.dataset.map)}"]`);
    if (!sel || !sel.value) { alertBox('Choose an asset first.', true); return; }
    const r = await api('/api/mappings', { method: 'POST', body: { source: b.dataset.map, assetId: sel.value } });
    alertBox(r.ok ? `Mapped — ${r.incidentsResolved} incident(s) healed.` : (r.error && r.error.message) || 'Mapping failed', !r.ok);
    refresh();
  }));
}

$('#btnConnect').addEventListener('click', () => { window.location.href = '/api/auth/google'; });
$('#btnSetup').addEventListener('click', async () => {
  $('#btnSetup').disabled = true;
  const r = await api('/api/setup', { method: 'POST', body: {} });
  alertBox(r.ok ? 'Setup complete (idempotent seed applied).' : (r.error && r.error.message) || 'Setup failed', !r.ok);
  $('#btnSetup').disabled = false;
  refresh();
});
$('#btnSync').addEventListener('click', async () => {
  $('#btnSync').disabled = true;
  $('#btnSync').textContent = 'Syncing…';
  const r = await api('/api/sync/run', { method: 'POST', body: {} });
  alertBox(r.ok ? `Sync ${r.sync && r.sync.status || 'done'}.` : (r.error && r.error.message) || 'Sync failed', !r.ok);
  $('#btnSync').disabled = false;
  $('#btnSync').textContent = 'Run Sync Now';
  refresh();
});

if (new URLSearchParams(location.search).get('connected')) {
  alertBox('Google connected successfully.');
}
refresh();
