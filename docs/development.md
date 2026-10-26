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

Apply the migrations in timestamp order (migration `202610250002` grants API-role table privileges needed to use RLS-protected tables):

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Alternatively, run the files under [`supabase/migrations`](../supabase/migrations/) in timestamp order in the Supabase SQL editor. The first migration contains the current organization and legacy inbound-lead tables; the second adds the opportunity workflow and RLS rules; the third grants API-role table privileges; the fourth adds RentCast search configuration and safe sync claiming; later migrations add manager-confirmed contact inquiries and verified-lead purchase entitlements.

With a running local Supabase stack, apply pending migration files with:

```bash
supabase migration up --local
```

Start the app:

```bash
pnpm dev
```

Create an account at `/sign-up`, confirm it if required by Supabase Auth, and sign in. Use **Settings** to create the organization, save an agent profile, and register sources. Manual sources are enabled on registration. External sources remain disabled until an organization owner/admin verifies permission and explicitly enables them.

## RentCast scheduled discovery

To enable US listings, obtain a RentCast API key and configure it as the server-only `RENTCAST_API_KEY`. Set `CRON_SECRET` and `OWNER_DATA_ENCRYPTION_KEY` as well. In Settings, register a RentCast search with either one 5-digit ZIP code or a city and two-letter state, select sale or long-term rental, and set a result cap of at most 100. An organization owner/admin must approve the source before it can run.

Schedule an authenticated daily POST to `/api/automation/rentcast-sync`. Each approved source can be fetched at most once every 24 hours, including concurrent scheduler calls; each job invocation makes no more than one provider request and prioritizes the least recently synced source. The connector calls only RentCast's fixed API host. It encrypts full addresses and listing-agent/office contacts; it does not represent those contacts as property owners or include them in summaries, snapshots, or audit metadata. Managers may separately compose a one-to-one property inquiry after recording permission or an applicable lawful basis with an evidence reference and confirming each send. Owner inquiries additionally require a verified owner. Emails are not sent automatically; review current provider terms and legal obligations before enabling a source or contacting a listing contact.

## Manual contact inquiries

The opportunity workspace provides a manager-only **Contact** action for an encrypted listing-agent, listing-office, or verified-owner email when one is available. Before sending, the manager records the permission or applicable lawful basis and evidence reference, composes a property-specific message, and confirms that individual send. Owner email also requires a verified owner and a permitted owner-contact record. A contact's opt-out blocks future outreach; outgoing messages include an opt-out link. Duplicate messages are limited to one per contact/listing in seven days, with a workspace limit of 20 messages per 24 hours. This is not a campaign tool and does not make a legal determination on the user's behalf.

## Verified lead sample and purchase

An owner-seller lead must include its original listing/evidence URL and at least one seller email or phone. A manager verifies the claim with an evidence reference and rationale. RentCast does not establish owner-posted status or provide owner contact fields; its contacts remain categorized as listing agent/office.

After an agent requests a verified owner-seller lead and a manager approves it, the organization receives one free sample unlock. Further approved leads cost **$25 USD each**. Checkout uses Stripe Checkout; set `STRIPE_SECRET_KEY`, then configure a Stripe webhook pointing to `/api/stripe/webhook` with `checkout.session.completed` and `checkout.session.expired` events and set its signing secret as `STRIPE_WEBHOOK_SECRET`. For local tests, use Stripe test keys and `stripe listen --forward-to localhost:3000/api/stripe/webhook`. A signed `checkout.session.completed` event is required to unlock the paid contact; redirecting back from Checkout alone does not grant access. Test with a non-production workspace and Stripe test mode before setting live keys. Refunds, subscriptions, and seller payouts are not implemented.

## Safe source testing

1. Use a test Supabase project and a source you control or are approved to process.
2. Register it in Settings with an HTTPS base URL. Copy the returned one-time token directly to a secret manager.
3. Have an owner/admin approve the source.
4. POST a canonical public summary to `/api/ingestion/listings` with `Authorization: Bearer <source-token>`.
5. Verify a sanitized snapshot, source-health record, score factors, and audit row are written.
6. Do not include an owner name, email, phone, full address, or other private details in webhook payloads. The endpoint rejects the private detail schema.

For a manual test, add a listing through the dashboard. Private details are optional and require the encryption key. Keep contact permission unknown unless you have evidence of permission or a documented applicable lawful basis.

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
- only managers can record contact permission or send inquiries, owner inquiries require owner verification, and opt-out links block further sends.

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
- After setting `RENTCAST_API_KEY` and approving a search, schedule a daily authenticated request to `/api/automation/rentcast-sync`.
- Configure Auth email, redirect URLs, and verified-email policy.
- Review all source approvals and user opt-out rules before enabling ingestion.
- For paid lead unlocks, configure Stripe secret keys and the signed webhook endpoint, then test both the free organization sample and a subsequent $25 USD test-mode purchase.
- Keep n8n disabled until its inbound authentication and source-scoped outbound bearer credential are configured.
- Set up database backups, security monitoring, retention rules, and a key recovery/rotation plan.
- Verify `/api/health` and live product routes after deployment; `/api/health` confirms environment configuration only, not a successful database query.
- Test manual contact permission recording, manager confirmation, owner verification, rate limits, delivery, and opt-out behavior in a non-production workspace.
