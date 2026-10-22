# LeadForge implementation checklist

## Delivered in this slice
- [x] Responsive B2B SaaS dashboard shell with overview, leads, follow-ups, automations, and settings routes.
- [x] Real typed demo records with an explicit `Demo data` indicator; no fabricated customer claims.
- [x] Lead list with search affordance, stage/source filters, pagination, score, source, consent, and activity states.
- [x] Follow-up review queue with explicit human approval policy and no automatic send path.
- [x] Automation health view with healthy, paused, and needs-setup states.
- [x] Transparent deterministic scoring utility with 0–100 score, configurable factors, evidence, rule version, and qualification band.
- [x] Initial Supabase migration with tenant ownership, foreign keys, unique deduplication constraints, indexes, and RLS policies.
- [x] Version-controlled n8n ingestion workflow template with authenticated webhook placeholder and idempotency validation.
- [x] Route manifest at `/manus-routes.json`.
- [x] Environment-aware Supabase SSR clients, session refresh middleware, protected dashboard routing, sign-in, sign-up, password reset, and OAuth callback routes.
- [x] Zod-validated `/api/leads` GET/POST handler with demo fallback and authenticated organization scoping.
- [x] Secret-free `.env.example`, setup-status endpoint, and runtime verification for auth routes and demo API behavior.
- [x] Connected the active Supabase project, verified its existing RLS-backed schema, and aligned live lead creation with its columns and source constraints.
- [x] Enabled the connected Gmail integration and updated Settings to show Gmail as connected with human approval required before sending.

## Next implementation outcomes
- [ ] Add organization bootstrap, role checks, sign-out, and member invitation flows on top of the SSR auth foundation.
- [ ] Add server-side Zod API handlers for CSV preview/import, lead edits, scoring runs, follow-up approval, and audit writes.
- [ ] Add CSV ingestion provider interface with file/row limits, normalization, duplicate reporting, partial success, and import history.
- [ ] Add remaining n8n workflow exports for qualification, draft generation, approved dispatch, reconciliation, and error reporting.
- [ ] Add configurable AI provider adapter with schema validation, bounded retries, timeout handling, deterministic fallback, and privacy-safe usage logging.
- [ ] Add Gmail OAuth/provider adapter with atomic send claims, content-version approvals, suppression rechecks, idempotency, reconciliation, and test adapter.
- [ ] Replace demo metrics with Supabase-backed aggregate queries and execution health metrics.
- [ ] Add boundary and cross-organization tests; never send real email in automated tests.

## Demo/live boundary
This repository slice is intentionally usable in demo mode. The connected Supabase project is now live-auth ready in this sandbox through an ignored `.env.local`; Gmail, n8n, and AI are not claimed live until their credentials and deployment configuration are supplied and tested. No raw credential is stored in the repository or shown in the UI.

## Local verification

```bash
pnpm install
pnpm lint
pnpm build
```

## Supabase setup

Apply `supabase/migrations/202610180001_leadforge_core.sql` to a new Supabase project using the Supabase CLI or SQL editor. Configure server-only environment variables for the project URL and anon/service keys before enabling live auth or API handlers. Never expose the service-role key to the browser.

## n8n setup

Import the JSON in `n8n/workflows/`, configure an authenticated header credential, set `LEADFORGE_BASE_URL`, and keep workflows inactive until the corresponding application endpoint is deployed. Use n8n credential storage or a secret manager; never export real credentials.
