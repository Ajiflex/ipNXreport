# ipNX Network Reporting Platform — Vercel + MongoDB

Autonomous weekly **POP Availability** reporting, migrated 1:1 from the Report025
Google Apps Script system to a Vercel + MongoDB stack. It discovers operational
outage spreadsheets on Google Drive, detects changes by content hash, reconciles
rows into incidents, calculates per-site availability against thresholds from
`SYSTEM_CONFIG` (never hard-coded), generates validated XLSX reports, archives
them to Drive, and serves a small dashboard.

## What runs where

- **Frontend** — static dashboard in `public/` (vanilla JS; only ever calls
  `/api/*`, never runs the engine).
- **API** — Vercel serverless functions in `api/`.
- **Engine** — `server/` (config, MongoDB repo layer, Google OAuth/Drive/Sheets,
  discovery, ingestion, mapping, reconciliation, reporting, POP module, XLSX
  templates, archive, setup, autonomous orchestration).
- **Scheduler** — Vercel Cron → `POST/GET /api/cron/hourly` (Bearer-guarded).
  The deployed schedule is **daily** (`23 6 * * *` in `vercel.json`); see the
  plan caveat below.

## Deploy

1. Push this folder to GitHub and import it into Vercel (root = repo root).
2. Create a MongoDB Atlas cluster; add `MONGODB_URI`.
3. Google Cloud Console: create OAuth credentials (Web), add the redirect URI
   `https://&lt;your-app&gt;.vercel.app/api/auth/google/callback`, enable the Drive
   and Sheets APIs.
4. Set every variable from `.env.example` in Vercel → Settings → Environment.
   `GOOGLE_OPERATIONAL_FOLDER_ID` defaults to the permanent outage-source root;
   every monthly workbook (Google Sheets **or Excel**) added inside that folder
   — at any nesting level, including shared-drive content — is discovered
   automatically on the next sync. No per-month sharing, uploads, or source IDs.
5. Deploy, then once: open `/api/auth/google` to connect Google, and call
   `POST /api/setup` to seed SYSTEM_CONFIG + the 57-POP master (idempotent).

&gt; **Vercel plan caveat (honest):** the deployed cron schedule is **daily**.
&gt; Vercel's **Hobby** plan permits only one cron invocation per day and rejects
&gt; hourly crons (`0 * * * *`) at deploy time. On **Pro** and above the schedule
&gt; in `vercel.json` may be restored to hourly — no code change needed. The
&gt; design is self-healing either way: every run re-fingerprints Drive state
&gt; against persisted `source_tabs.content_hash`, so missed intervals are caught
&gt; by the next run.

## API

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/auth/google` | GET | Start OAuth (offline access → refresh token) |
| `/api/auth/google/callback` | GET | OAuth callback; stores AES-encrypted tokens |
| `/api/setup` | POST | One-time idempotent seed (`X-Api-Key` when `APP_API_KEY` set) |
| `/api/sources` | GET | Source registry + tab counts |
| `/api/sync/status` | GET | Latest sync runs + per-tab state |
| `/api/sync/run` | POST | Manual lock-guarded pipeline run (`X-Api-Key` gated) |
| `/api/reports` | GET | Report library (archived periods) |
| `/api/reports/:id` | GET | One archived report by period id |
| `/api/reports/:id/download` | GET | Verified XLSX download (exists ∧ ¬trashed ∧ non-zero ∧ valid) |
| `/api/exceptions` | GET | Exception queue |
| `/api/exceptions/:id/retry` | POST | Re-queue an exception (`X-Api-Key` gated) |
| `/api/mappings` | GET, POST | Review + map node names (heals incidents) |
| `/api/cron/hourly` | GET, POST | Vercel Cron target, `Authorization: Bearer $CRON_SECRET` |

Every route returns JSON errors as `{ ok:false, error:{ code, message } }`;
unsupported methods return a JSON **405** with an `Allow` header.

## Data model (MongoDB collections)

`sources` · `source_tabs` (content_hash + row_count fingerprint per tab) ·
`raw_events` (deterministic `raw_id`) · `incidents` · `mappings` · `assets`
(57 POPs: IHS 30 / ipNX 8 / Others 19) · `config` (SYSTEM_CONFIG rows) ·
`report_periods` · `weekly_results` · `report_archive` (revisions +
superseded file ids) · `report_exceptions` · `sync_runs` · `ingestion_log` ·
`locks` (distributed, TTL) · `tokens` (AES-encrypted Google tokens).

## Autonomy

Every scheduled tick: Drive discovery (paginated, shared-drive-safe scan of the
configured root folder; Google Sheets **and Excel** workbooks; month-year file
labels resolved case-insensitively) → per-tab hash fingerprinting →
cross-source authority (newest Drive modification wins) → idempotent raw
upsert → incident reconciliation → month-anchored 7-day report windows (first
month anchors at the earliest known source tab; a sub-7-day month tail is not
a period) → 48-hour incomplete-period grace → generate → validate → finalize →
archive → exceptions auto-resolve. Unknown node names **block** a period
instead of fabricating data; mapping them in the dashboard self-heals the
report on the next run.

## Development & tests

```bash
npm install
npm test    # in-memory Mongo adapter + Google mocks; no real DB needed
npm run lint  # static Vercel structure validation + route table
```

The test suite includes the two mandated regression tests: **hash/rowCount
persistence** (a re-scan of unchanged content never re-ingests) and
**duplicate-source authority** (a changed older duplicate never overrides the
newest-modified authoritative source).
