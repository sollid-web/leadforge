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

Fill the Supabase URL, publishable key (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; older projects can use `NEXT_PUBLIC_SUPABASE_ANON_KEY`), server-only service-role key, and a newly generated `OWNER_DATA_ENCRYPTION_KEY`. The URL and key must come from the same Supabase project. Generate the encryption key with:

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

Alternatively, run the files under [`supabase/migrations`](../supabase/migrations/) in timestamp order in the Supabase SQL editor. The first migration contains the current organization and legacy inbound-lead tables; the second adds the opportunity workflow and RLS rules; the third grants API-role table privileges; later migrations add RentCast search configuration, manager-confirmed contact inquiries, verified-lead purchases, the business-prospect pipeline, owner-direct listing/source/contact provenance (`202610260006`), and Untera search diagnostics/rate limits (`202610260007`).

With a running local Supabase stack, apply pending migration files with:

```bash
supabase migration up --local
```

Start the app:

```bash
pnpm dev
```

Create an account at `/sign-up`, confirm it if required by Supabase Auth, and sign in. Use **Settings** to create the organization, save an agent profile, and register sources. Manual sources are enabled on registration. External sources remain disabled until an organization owner/admin verifies permission and explicitly enables them.

## Business prospect discovery

Open **Business prospects** and search a city, region, or country for real-estate agents, brokerages, or property-management companies. The app geocodes the submitted area with Nominatim and searches nearby OpenStreetMap records through Overpass. Results are deduplicated per organization by OpenStreetMap object ID and organized into review stages with internal notes. Only manager-level workspace members can search or edit the prospect pipeline. Searches are limited to one per workspace every 30 seconds, and a shared database throttle respects the public Nominatim service's one-request-per-second policy.

This uses community-mapped business records, not a verified agent directory. Coverage and listed business contact details vary by location and may be missing or stale. Results do not mean a business opted in or has interest in purchasing leads; the workflow does not automatically contact prospects. Data is attributed to [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) and subject to the [Open Database License](https://opendatacommons.org/licenses/odbl/). Review those terms before exporting or redistributing prospect data. For Nominatim client identification, configure `OPENSTREETMAP_CONTACT_EMAIL` with a monitored application contact address. No external API key is required.

## Untera international property discovery

The opportunity workspace has a user-triggered Untera search UI. It retrieves country coverage from Untera's source registry; no list of countries is hard-coded. The current provider documentation advertises coverage across 80+ countries and 190+ sources, but this app presents only country codes returned by the authenticated source registry. A registry response and successful live search are required before claiming coverage for a particular country.

To configure it, request an API key through [Untera's developer documentation](https://untera.io/developers), then set the following **server-only** environment values:

```dotenv
UNTERA_API_KEY=...
UNTERA_COMMERCIAL_USE_AUTHORIZED=false
UNTERA_LISTING_REUSE_AUTHORIZED=false
```

Do not set either authorization flag to `true` until you have confirmed in writing that the applicable Untera plan permits this commercial use. `UNTERA_COMMERCIAL_USE_AUTHORIZED=true` enables live source-registry and search requests. `UNTERA_LISTING_REUSE_AUTHORIZED=true` additionally enables fetching detail records and importing them to the organization database. The provider's public free-tier description is for prototypes, research, and side projects; its publicly accessible terms do not clearly grant the commercial lead resale, retention, or redistribution rights. Upgrade or obtain explicit provider confirmation before activation for a lead-sales business. Do not treat public listing visibility as reuse permission.

Then sign in as an organization manager, visit **Settings → Approved listing sources**, select **Public listing API → Untera**, register the source, and have an owner/admin approve and activate it. On the **Opportunities** page, load coverage, choose a country from the returned registry, set supported filters, and run a live search. Results are marked as live-only and are not persisted until **Import to saved opportunities** is explicitly selected. The provider requires visible **Powered by Untera** attribution. Catalog/search requests are server-side; the API key is never returned to the browser. Requests are paced and globally rate-limited in the database.

Poster metadata is not proof of property ownership: an explicit provider owner label becomes `OWNER_UNVERIFIED`, an unrecognized or absent poster remains `UNKNOWN`, and nothing is promoted to `OWNER_VERIFIED` by this integration. The default live search shows only provider records explicitly categorized as owner candidates; switch the poster filter to explore the broader set. Contact data, when supplied, is omitted from search responses and fetched only server-side during an explicitly permitted import. It is encrypted, provenance-tracked, and is not treated as outreach consent. If the provider does not return a usable original URL or required city/transaction information, the app refuses import rather than inventing fields. No portal scraping is performed.

Migration `202610260007_untera_discovery.sql` must be applied before using the Untera features. It adds collection-run diagnostics and a database-backed provider rate limit; it does not alter or delete existing listing records. Automated tests use mocked HTTP responses and do not establish that the live API is configured or functioning. Without a configured API key and confirmed authorization, live testing is blocked.

## Business prospect email

Configure `RESEND_API_KEY`, a verified `RESEND_FROM_EMAIL`, and `NEXT_PUBLIC_APP_URL` before sending. From a prospect card with a listed email, choose **Compose business email**, review/edit the individual message and recipient, tick the confirmation, then confirm the send. Messages are sent through Resend, recorded with the manager, and include an opt-out link. Address-level opt-outs are honored across the workspace. The application enforces one message per prospect per 30 days and a maximum of 20 prospect emails per workspace per 24 hours. Failed provider attempts are recorded; inspect the delivery/audit state before retrying. There is no bulk sender.

### Inbound replies and AI drafts

To route prospect replies into EstatelQ, configure a Resend receiving domain (Resend-managed or a verified custom domain) and set `RESEND_INBOUND_DOMAIN` to its hostname. Set `RESEND_WEBHOOK_SECRET` to the signing secret from a Resend webhook subscribed to `email.received` at `https://YOUR_APP_URL/api/webhooks/resend/inbound`. Outbound prospect introductions use a unique reply address when this domain is configured. Apply migrations `202610260004` and `202610260005` before using the email/reply workflow; received email bodies are stored in the organization-scoped manager inbox and attachments are not downloaded or retained.

Optionally set the server-only `OPENAI_API_KEY` (and, if needed, `OPENAI_MODEL`). A manager can select **Generate AI draft** on a received reply, edit it, check the review confirmation, and send it. AI is called only on that manager action, uses the original introduction and reply as context, and never sends a message on its own. The selected email text is sent to OpenAI for drafting; review its current API data-use terms before enabling the key. Do not include secrets or sensitive owner/property details in these messages. Messages are sent through Resend; configure and test receiving DNS, the webhook, OpenAI access, and delivery in a non-production workspace before relying on the flow.

## RentCast scheduled discovery

To enable US listings, obtain a RentCast API key and configure it as the server-only `RENTCAST_API_KEY`. Set `CRON_SECRET` and `OWNER_DATA_ENCRYPTION_KEY` as well. In Settings, register a RentCast search with either one 5-digit ZIP code or a city and two-letter state, select sale or long-term rental, and set a result cap of at most 100. An organization owner/admin must approve the source before it can run.

Schedule an authenticated daily POST to `/api/automation/rentcast-sync`. Each approved source can be fetched at most once every 24 hours, including concurrent scheduler calls; each job invocation makes no more than one provider request and prioritizes the least recently synced source. The connector calls only RentCast's fixed API host. It encrypts full addresses and listing-agent/office contacts; it does not represent those contacts as property owners or include them in summaries, snapshots, or audit metadata. Managers may separately compose a one-to-one property inquiry after recording permission or an applicable lawful basis with an evidence reference and confirming each send. Owner inquiries additionally require a verified owner. Emails are not sent automatically; review current provider terms and legal obligations before enabling a source or contacting a listing contact.

## Manual contact inquiries

The opportunity workspace provides a manager-only **Contact** action for an encrypted listing-agent, listing-office, or verified-owner email when one is available. Before sending, the manager records the permission or applicable lawful basis and evidence reference, composes a property-specific message, and confirms that individual send. Owner email also requires a verified owner and a permitted owner-contact record. A contact's opt-out blocks future outreach; outgoing messages include an opt-out link. Duplicate messages are limited to one per contact/listing in seven days, with a workspace limit of 20 messages per 24 hours. This is not a campaign tool and does not make a legal determination on the user's behalf.

## Verified lead sample and purchase

An owner-seller lead must include its original listing/evidence URL and at least one seller email or phone. A manager verifies the claim with an evidence reference and rationale. RentCast does not establish owner-posted status or provide owner contact fields; its contacts remain categorized as listing agent/office.

After an agent requests a verified owner-seller lead and a manager approves it, the organization receives one free sample unlock. Further approved leads cost **$25 USD each**. Checkout uses Stripe Checkout; set `STRIPE_SECRET_KEY`, then configure a Stripe webhook pointing to `/api/stripe/webhook` with `checkout.session.completed` and `checkout.session.expired` events and set its signing secret as `STRIPE_WEBHOOK_SECRET`. For local tests, use Stripe test keys and `stripe listen --forward-to localhost:3000/api/stripe/webhook`. A signed `checkout.session.completed` event is required to unlock the paid contact; redirecting back from Checkout alone does not grant access. Test with a non-production workspace and Stripe test mode before setting live keys. Refunds, subscriptions, and seller payouts are not implemented.

## Owner-direct listing ingestion and CSV

Apply migration `202610260006_owner_direct_discovery.sql` before deploying the expanded opportunity workspace. The migration adds listing-type and recency fields, poster classification/evidence, source relationships, encrypted contact provenance, review history, and collection-run records. By default, the dashboard shows only owner-verified and owner-unverified listings; other poster categories, including unknown and agent, require an explicit filter. Classification depends on source evidence and is not inferred from an owner claim. Owner verification is a manager-only review requiring a method, evidence reference, and rationale, and is recorded in both verification and poster-review history.

Use **Import authorized CSV** for an owner-submitted or otherwise permitted dataset. Uploads are bounded to 2 MB and 100 rows. Required headers are `title,property_type,area,city,country_code`; optional headers include `source_name,source_url,external_id,description,listing_type,region,price,currency,bedrooms,bathrooms,published_at,listing_updated_at,poster_type,poster_evidence,poster_method,public_contact_context,address,owner_name,owner_email,owner_phone,listing_agent_name,listing_agent_email,listing_agent_phone`. `poster_type` cannot assert `OWNER_VERIFIED`; public contact context must refer to the source listing and does not establish permission for outreach. Each row is sent through authenticated server-side validation and receives normal deduplication and source attribution. Failed rows are reported individually. The CSV importer is a transfer path, not a provider or source of live discoveries.

The RentCast adapter is limited to US listings. It preserves provider-supplied agent/office contacts as such and does not verify owner identity or supply owner contacts. No Nigeria owner-direct feed is currently connected or tested. Use owner-submitted records or an authorized dataset there; do not scrape sites or bypass source restrictions.

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
node --experimental-strip-types --test tests/listing-discovery.test.mjs
pnpm build
```

The focused unit tests use Node.js 22's built-in TypeScript stripping and cover listing URL deduplication, intake classification restrictions, contact identity fingerprints, and CSV parsing. The app itself supports Node.js 20+. Database-backed integration tests are not configured; cross-tenant/RLS and provider-failure scenarios require a non-production Supabase project.

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


## Legacy scraper CSV bridge

The Leads workspace supports a preview-first import of the historical scraper CSV shape (`id`, `type`, `source`, `city`, `title`, `price`, `location`, `date_posted`, `link`, `owner_name`, `phone`, `notes`, and `email`). Legacy rows are accepted only when their source is already configured as an approved, active `approved_feed` or `partner_feed`, the source has an HTTPS base URL, and each listing URL has the same host. The import reuses `/api/listings` and its existing tenant checks, source links, deduplication, scoring, and audit behavior. Rows with missing source, URL, city, country, or sale/rental status are rejected in the preview; missing property type is placed in the explicit `other` bucket with a warning. A source's FSBO label may map only to `OWNER_UNVERIFIED`; the CSV cannot assert `OWNER_VERIFIED`.

Scraped name/phone/email fields are stored as encrypted `other` contacts, not as owners or agents. Their publication context records that the scraper extracted the details from a listing, while identity/role remains unverified and contact permission remains unknown. This is not evidence of marketing consent. The import processes only the uploaded file and does not execute the Python crawler, enrichment, or skip-tracing scripts.

Live site collection is not started by this CSV bridge. The scraper's old command-line entry point now delegates to the isolated worker adapter and defaults to a no-network dry run; actual collection requires the explicit `--collect` flag plus a non-empty authorization reference. LeadForge offers the optional separate worker dispatcher documented below, but it is not configured or deployed by this patch and does not start automatically.


## Agent directory, lead batches, offers, and purchases

Apply `202610270001_agent_sales_pipeline.sql` after the source/contact provenance migrations. It adds organization-scoped agent buyer records and interaction history; listing-backed batch snapshots; explainable agent matches; manual offer, payment-evidence, and delivery records; exclusive/shared sale constraints; manager-only RLS and audited atomic transitions. The migration also extends collection-run records with bounded worker configuration/progress and authorization-reference fields.

Open **Agent directory** to add buyers manually or import the supplied CSV template. Directory records are encrypted where contact values are stored and do not automatically send messages. Link a directory record only to an existing organization agent member with a verified Supabase email that exactly matches the recorded contact email; buyer-side delivery checks that link and the offer's paid state. The directory is not an external agent-discovery integration.

Open **Lead offers** to select existing owner-indicated listings, create a snapshot, review per-row rejections, and approve only if at least 20 records still qualify. The server requires a same-city, same-country, same-currency batch, approved active listing sources, HTTPS original URLs, current freshness, owner-indicated metadata, and no existing active sale. It will not scrape to fill a short batch or silently discard rejected records. Matching is deterministic and explainable; it requires exact country plus exact city or an explicitly recorded service area and honors currency, transaction/property preferences, budget and volume caps, and opt-outs.

Pricing is entered by a manager and stored in currency minor units. Message templates are editable and use saved batch facts; source and owner status may still be unverified. “Sent” is an operator confirmation only—there is no message sender in this workflow. Manual payment evidence is not gateway-verified and must be independently checked. In-app lead delivery becomes available only for a paid offer whose directory record is linked to the signed-in buyer account. Contacts are released only with their source/provenance/permission status; contact availability is never treated as permission to market. A shared batch is disclosed as shared and can be offered to more than one buyer; an exclusive batch is protected by an atomic listing-sale registry.

The dashboard uses persisted records only. Qualified owner counts require a fresh (14-day default), active listing with a currently approved/active source and the appropriate owner classification. Offer response/interest conversion is grouped by city and pricing mode; source grouping reflects all source names represented in the batch and is not causal attribution. Revenue and refunds remain separated by currency and reflect manual evidence records, not a payment-provider feed.

### Optional separate Python scraper worker

The worker code lives in the isolated scraper repository, not in the LeadForge Next.js app. Apply the LeadForge database migration and deploy the worker as a separate container only after reviewing the source permissions, privacy/retention terms, network controls, and source-specific caps. Build from the scraper repository root with `docker build -f worker/Dockerfile -t leadforge-scraper-worker .`. The image starts only the authenticated dispatcher and never collects at boot. Configure the app's server-only `LEADFORGE_SCRAPER_WORKER_URL` to its TLS `/runs` endpoint and `LEADFORGE_SCRAPER_WORKER_TOKEN` to a randomly generated secret of at least 32 characters; set the same value as worker `LEADFORGE_WORKER_TOKEN`. Mount `LEADFORGE_ARTIFACT_DIR` as a private persistent volume with a written retention/deletion policy. Keep the worker on a private network or behind TLS; do not expose its port directly to the public internet.

The worker supports only `craigslist`, `forsalebyowner`, and `byowner`, with approved LeadForge source names exactly `Craigslist`, `ForSaleByOwner.com`, and `ByOwner.com` and matching HTTPS hosts. Current configured Florida search labels are Miami, Fort Lauderdale, West Palm Beach, Broward, Boca Raton, Hialeah, and Palm Beach; each source supports only a subset. The adapters support US sale listings only, a maximum of 50 results per requested run, and no reliable property-type filter. The dashboard intentionally does not offer rentals or specific property-type filters. A manager must pick an approved active external source, enter an authorization reference, and confirm the terms/permission attestation each time; this is an operator declaration, not an automated legal review. The worker stops on validation errors or access blocks and does not evade them. It does not invoke enrichment or skip-tracing scripts.

Each run receives a UUID recorded against the approved source, reports bounded progress/errors via the shared token, and writes a private CSV artifact. Run counts show `imported=0` until a manager downloads the manifest and submits it through the Opportunities CSV preview, reviews field warnings/rejections, and explicitly imports selected records. Do not rely on historical CSVs checked into the old scraper repository as fresh leads. No worker URL/token is configured in this code change; no container was built/started and no collection was dispatched.
