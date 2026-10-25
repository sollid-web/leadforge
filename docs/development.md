# Development guide

## Requirements

- Node.js 20+
- pnpm 11 (the repository pins its package manager in `package.json`)
- A Supabase project to exercise authenticated product flows
- Supabase CLI for local databases or applying remote migrations

## Install and configure

```bash
pnpm install
cp .env.example .env.local
```

Fill the Supabase URL, anon key, server-only service-role key, and a newly generated `OWNER_DATA_ENCRYPTION_KEY`. Generate that key with:

```bash
openssl rand -base64 32
```

For scheduled source-health checks, also set a random server-only `CRON_SECRET` (for example, `openssl rand -hex 32`). Configure your hosting scheduler or an external cron to POST to `/api/automation/source-health` hourly with `Authorization: Bearer <CRON_SECRET>`. The handler uses persisted ingestion timestamps only; it does not fetch source URLs. Sources become degraded after 24 hours and failed after 72 hours without a successful ingestion.

Do not commit `.env.local`, paste credentials into logs, or put server-only keys in `NEXT_PUBLIC_*` variables.

Apply the migrations in timestamp order:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Alternatively, run both files under [`supabase/migrations`](../supabase/migrations/) in the Supabase SQL editor. The first migration contains the current organization and legacy inbound-lead tables; the second adds the opportunity workflow and RLS rules.

Start the app:

```bash
pnpm dev
```

Create an account at `/sign-up`, confirm it if required by Supabase Auth, and sign in. Use **Settings** to create the organization, save an agent profile, and register sources. Manual sources are enabled on registration. External sources remain disabled until an organization owner/admin verifies permission and explicitly enables them.

## Safe source testing

1. Use a test Supabase project and a source you control or are approved to process.
2. Register it in Settings with an HTTPS base URL. Copy the returned one-time token directly to a secret manager.
3. Have an owner/admin approve the source.
4. POST a canonical public summary to `/api/ingestion/listings` with `Authorization: Bearer <source-token>`.
5. Verify a sanitized snapshot, source-health record, score factors, and audit row are written.
6. Do not include an owner name, email, phone, full address, or other private details in webhook payloads. The endpoint rejects the private detail schema.

For a manual test, add a listing through the dashboard. Private details are optional and require the encryption key. Keep contact permission unknown unless you have evidence of permission.

## Database / security checks

The repository does not currently ship automated integration tests. Before merging schema or access-control changes, use a non-production Supabase project and test:

- an authenticated member cannot access another organization;
- only managers can ingest, match, suppress, or decide requests;
- only an active agent with a matching record can request detail access;
- the matched agent cannot retrieve details before approval;
- a different agent cannot retrieve another agent's approved details;
- suppression blocks details and revokes relevant approvals;
- an invalid, disabled, or cross-source webhook token is rejected;
- private payload columns contain ciphertext, not raw contact details.
- the scheduled source-health endpoint rejects missing/invalid bearer credentials and updates only active, approved external sources.

## Required local checks

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

`pnpm build` can require network access for Next.js font assets on a clean build. Record environmental failures rather than treating them as passes.

## Deployment checklist

- Apply migrations before deploying application code.
- Use separate Supabase projects and encryption keys per environment.
- Set server-only keys only in hosting secret storage.
- Set `CRON_SECRET` in hosting secrets and configure an hourly authenticated request to `/api/automation/source-health`.
- Configure Auth email, redirect URLs, and verified-email policy.
- Review all source approvals and user opt-out rules before enabling ingestion.
- Keep n8n disabled until its inbound authentication and source-scoped outbound bearer credential are configured.
- Set up database backups, security monitoring, retention rules, and a key recovery/rotation plan.
- Verify `/api/health` and live product routes after deployment; `/api/health` confirms environment configuration only, not a successful database query.
