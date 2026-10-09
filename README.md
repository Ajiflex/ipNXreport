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

## Deploy

1. Push this folder to GitHub and import it into Vercel (root = repo root).
2. Create a MongoDB Atlas cluster; add `MONGODB_URI`.
3. Google Cloud Console: create OAuth credentials (Web), add the redirect URI
   `https://<your-app>.vercel.app/api/auth/google/callback`, enable the Drive
   and Sheets APIs.
4. Set every variable from `.env.example` in Vercel → Settings → Environment.
5. Deploy, then once: open `/api/auth/google` to connect Google, and call
   `POST /api/setup` to seed SYSTEM_CONFIG + the 57-POP master (idempotent).

> **Vercel plan caveat (honest):** the hourly schedule in `vercel.json` is
> honored on **Pro** and above. On the **Hobby** plan Vercel runs crons **once
> per day**. The design is self-healing either way: every run re-fingerprints
> Drive state against persisted `source_tabs.content_hash`, so missed hours are
> caught up automatically on the next run.

## Route → method table

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/auth/google` | GET | Start OAuth (302 to Google) |
| `/api/auth/google/callback` | GET | OAuth callback; stores AES-encrypted refresh token |
| `/api/bootstrap` | GET | Dashboard bootstrap: connection, last sync, counts, exceptions |
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

The hourly tick: Drive discovery → per-tab hash fingerprinting → cross-source
authority (newest Drive modification wins) → idempotent raw upsert → incident
reconciliation → month-anchored 7-day report windows (first month anchors at
the earliest known source tab; a sub-7-day month tail is not a period) →
48-hour incomplete-period grace → generate → validate → finalize → archive →
exceptions auto-resolve. Unknown node names **block** a period instead of
fabricating data; mapping them in the dashboard self-heals the report on the
next run.

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
