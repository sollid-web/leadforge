# LeadForge

LeadForge is an early-stage real-estate opportunity discovery and agent-routing MVP. It ingests manually entered or explicitly approved listing summaries, normalizes and deduplicates them, applies explainable quality signals, and ranks organization agents by service area, specialty, and budget.

The product is intentionally not a scraper or bulk messaging tool. It does not contact property owners. Agents receive summary-only opportunities, and private property or owner details remain encrypted and inaccessible until an agent requests access and an organization manager explicitly approves that request. The matched agent's detail access is audited.

**Project status:** working MVP foundation, not a complete or production-certified SaaS. Live database behavior requires a Supabase project and the migrations in this repository. No sample records are used as operational data.

## Current product flows

1. An authenticated user creates an organization from **Settings**. The creator becomes its owner.
2. A manager manually records an opportunity or an owner/admin registers and approves an external source.
3. A manager enters a normalized source record, or a configured source submits a summary-only webhook payload.
4. LeadForge normalizes fields, checks an organization-scoped dedupe key, stores a sanitized source snapshot, calculates evidence-based scores, and records source health and an audit event.
5. A manager can verify an owner-listed claim against an evidence reference, then calculate ranked agent matches. Agents can see matched summaries and explicitly request details.
6. A manager approves or rejects each request with a reason. Approval is scoped to the requesting agent; the detail endpoint checks the match, interest, approval, active-agent state, and current suppression state.
7. A detail response is decrypted on the server and emitted with `Cache-Control: private, no-store`; the reveal is audit logged. Suppression blocks later reveals and revokes related approvals.

Optional agent email is sent through Resend only after the agent opts in and a manager manually confirms each summary message. It includes no private owner/property details and requires provider configuration. Automatic owner outreach, AI scoring, and a source crawler are not implemented. The n8n export is a disabled webhook orchestration template.

## Stack

- Next.js App Router, React, TypeScript, and Tailwind CSS
- Supabase Auth, Postgres, and row-level security
- Zod request validation
- Node.js AES-256-GCM encryption for private listing metadata
- Optional n8n workflow template for an approved source webhook

## Local setup

Requirements: Node.js 20 or newer, pnpm 11, and a Supabase project for live workflows.

```bash
pnpm install
cp .env.example .env.local
# Set the Supabase values and generate OWNER_DATA_ENCRYPTION_KEY as described below.
pnpm dev
```

Apply both ordered SQL migrations to a new Supabase project using the SQL editor or Supabase CLI:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Then create an account at `/sign-up`, confirm the email if confirmation is enabled, sign in, and create your organization in **Settings**. Managers can configure their own agent profile and register listing sources there.

### Environment

See [`.env.example`](./.env.example). Required for the core application:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable/anon key; browser-exposed by design and constrained by RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key used by source-token ingestion, scheduled health checks, and confirmed-email recipient lookup |
| `OWNER_DATA_ENCRYPTION_KEY` | Base64-encoded 32-byte AES key for private detail payloads |
| `NEXT_PUBLIC_APP_URL` | Public application URL used in agent notification links |
| `RESEND_API_KEY` | Optional server-only Resend credential for manager-confirmed agent summary emails |
| `RESEND_FROM_EMAIL` | Verified sender address used for agent summary emails |
| `CRON_SECRET` | Optional server-only bearer secret for scheduled source-health checks |

Generate an encryption key with `openssl rand -base64 32`. Never use a real key in a committed file. Keep `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_DATA_ENCRYPTION_KEY`, `RESEND_API_KEY`, and `CRON_SECRET` in deployment secret storage; none belongs in a `NEXT_PUBLIC_` variable. Losing the encryption key makes encrypted private details unrecoverable. Key rotation is an operational procedure and is not automated by this MVP.

## Source and privacy rules

- Manual entry is available to organization managers and is scoped to the authenticated organization.
- External sources are created inactive and unapproved. An owner/admin must verify their permission and HTTPS source URL before enabling them.
- External source registration returns a random, source-scoped bearer token once. Store it in a secret manager. The database stores only its SHA-256 hash.
- `POST /api/ingestion/listings` accepts public listing fields only and authenticates the source token. It cannot accept the private-detail object.
- `POST /api/automation/source-health` is a scheduled-job endpoint. Configure `CRON_SECRET` and call it hourly with `Authorization: Bearer …`; it marks sources degraded after 24 hours and failed after 72 hours without successful ingestion. It checks stored ingestion timestamps only and never fetches arbitrary source URLs.
- No listing website is fetched or scraped by the app. Do not ingest data unless the source terms and applicable law permit it.
- Private address and owner fields entered through the authenticated app are AES-GCM encrypted before database storage. Contact permission starts as `unknown`; the app does not send owner messages.
- Full detail access is restricted to the matched agent with an approved interest request. Every reveal, approval, source decision, and suppression is audited.
- A verified opt-out can suppress an opportunity and mark owner contact permission as opted out.

For security boundaries, limitations, and vulnerability reporting, see [`SECURITY.md`](./SECURITY.md). For the schema and request lifecycle see [`docs/architecture-plan.md`](./docs/architecture-plan.md).

## API overview

| Route | Purpose |
| --- | --- |
| `GET/POST /api/organizations` | List memberships / bootstrap an organization |
| `GET/POST /api/sources` | List or register sources |
| `POST /api/sources/:id/approval` | Owner/admin activates or disables a source |
| `GET/POST /api/listings` | List summaries / manager manual ingestion |
| `POST /api/ingestion/listings` | Source-token webhook ingestion (service role required) |
| `POST /api/automation/source-health` | Scheduled status calculation for approved external sources (requires `CRON_SECRET`) |
| `POST /api/listings/:id/matches` | Rank active agent profiles and save matches |
| `POST /api/listings/:id/verification` | Record a manager's owner-claim verification decision and evidence |
| `GET /api/matches` | Return matched summary opportunities for the current agent |
| `POST /api/matches/:id/interest` | Submit an explicit agent request |
| `GET /api/interest-requests` | Manager approval queue |
| `POST /api/interest-requests/:id/approval` | Manager decision with recorded reason |
| `GET /api/listings/:id/details` | Return details only after matched-agent approval |
| `POST /api/listings/:id/suppression` | Suppress a listing and revoke future detail access |
| `GET/POST /api/agents` | Create an agent profile for an organization member |
| `GET/PATCH /api/agents/preferences` | Read or update an agent's explicit email-notification opt-in |
| `POST /api/matches/:id/email` | Manager-confirmed summary email to an opted-in agent |
| `GET /api/health` | Reports runtime configuration, not a database connectivity guarantee |

All request handlers validate payloads server-side and scope data to an authenticated organization, validated source token, or the scheduled-job secret. The app does not yet expose CSV import, agent invitations, billing, bulk campaigns, or a source crawler.

## Validation

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

There is no automated integration test suite or seeded demo tenant in this repository. Database-backed end-to-end verification requires a configured Supabase project and test accounts.

## Deployment notes

1. Set all environment variables in the hosting provider's secret store and use separate Supabase projects for development and production.
2. Apply migrations before deploying code that uses the new schema.
3. Configure allowed Supabase Auth redirect URLs and enforce verified email addresses.
4. Test cross-organization RLS, manager/agent role boundaries, detail gating, audit insertion, suppression, and webhook token revocation in a non-production project.
5. Keep the n8n workflow inactive until the source is approved, the one-time token is stored securely, and a sanitized ingestion has been verified. Disable it on source withdrawal.
6. Configure a scheduler to call `POST /api/automation/source-health` hourly using `CRON_SECRET`; review degraded/failed source states in Settings.
7. For agent summary emails, verify the sender domain with Resend and set `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `NEXT_PUBLIC_APP_URL`. Test opt-in, manual confirmation, and delivery in a non-production workspace.
8. Configure backups and a tested encryption-key recovery/rotation process before storing any real owner contact data.

No public deployment or production readiness claim is made by this repository.
