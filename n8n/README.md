# LeadForge Autopilot workflow pack (disabled)

This directory contains importable n8n workflow exports. They are intentionally inactive (`active: false`) and contain no secret values. This pack automates only the LeadForge integrations that already have server-side endpoints. It is **not yet the complete autonomous sales funnel**: do not activate it as an end-to-end Autopilot.

## Included exports

| Export | Disabled workflow | What it actually does | External effect after deliberate activation |
|---|---|---|---|
| `workflows/leadforge-rentcast-discovery.json` | Approved RentCast discovery | Every two hours, calls `POST /api/automation/rentcast-sync`. The app currently makes at most one RentCast provider request per invocation and enforces a 24-hour per-source claim. This gives up to 12 source attempts/day, not a guarantee every source is synced daily. | Reads the configured RentCast API and writes normalized listing/contact data into the configured LeadForge database. |
| `workflows/leadforge-source-health.json` | Source health monitor | Every six hours, calls `POST /api/automation/source-health`. | Recalculates health metadata from last successful ingestion and writes health/audit records. It does not ping provider APIs. |
| `workflows/lead-discovery-and-ingestion.json` | Approved public listing intake | Authenticated webhook, allowlists public summary fields, rejects private-contact payloads, and forwards to `POST /api/ingestion/listings` with a source-scoped token. | Writes/deduplicates a public listing summary for a matching approved and active source. It does not crawl websites. |

The export names are generic. The import process is: in n8n choose **Workflows → Import from File**, import each JSON, then save it while leaving it inactive. Before activation, edit the `YOUR-LEADFORGE-APP.example` URL and attach the specific n8n Header Auth credentials described below. Credential IDs are deliberately not embedded; n8n assigns them in the target instance.

## Required LeadForge application configuration

Set server-side values through the deployment provider's secret manager, never in workflow JSON, source control, browser code, or chat. Configure only services actually being used.

| Variable | Needed for | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All database-backed app paths | Use the selected staging project first. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Auth/app client | At least one supported public key is required. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side ingestion and scheduled jobs | Server-only. Never put this in n8n or client-side settings. |
| `OWNER_DATA_ENCRYPTION_KEY` | Private provider details | Required by RentCast sync because it stores encrypted provider contact details. |
| `NEXT_PUBLIC_APP_URL` | App URL validation and external links | Set to the HTTPS staging/production origin as appropriate. |
| `CRON_SECRET` | RentCast and source-health endpoints | Generate a unique high-entropy value for each environment. Store its bearer form only in the n8n credential store. |
| `RENTCAST_API_KEY` | RentCast sync only | Configure only after confirming account terms and authorized use. |
| `UNTERA_API_KEY` | Optional interactive Untera features | Not used by these workflow exports. |
| `UNTERA_COMMERCIAL_USE_AUTHORIZED` | Optional Untera commercial usage | Set to `true` only when documented permission is held. |
| `UNTERA_LISTING_REUSE_AUTHORIZED` | Optional Untera listing storage/reuse | Set to `true` only when explicit reuse/redistribution permission is held. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Existing reviewed email features | These exports do not send email. |
| `RESEND_WEBHOOK_SECRET`, `RESEND_INBOUND_DOMAIN` | Existing inbound Resend processing | Resend events should go directly to the signed LeadForge endpoint; no n8n relay is required. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Existing legacy single-lead checkout | These exports do not process payment. Batch offers are not integrated with Stripe yet. Use Stripe test credentials in staging only. |
| `LEADFORGE_SCRAPER_WORKER_URL`, `LEADFORGE_SCRAPER_WORKER_TOKEN` | Optional, separately deployed scraper-worker bridge | Not used by these n8n workflows. The worker remains opt-in and dry-run by default; do not activate live collection without source authorization. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Optional reply drafting | Draft generation is not an autonomous send and is not used by these exports. |
| `OPENSTREETMAP_CONTACT_EMAIL` | Optional geocoding/provider etiquette | Not used by these exports. |

`NODE_ENV` is deployment-managed. Consult the repository `.env.example` as a local naming reference; values must be supplied by the operator's secret manager.

## n8n credentials and non-secret settings

Create these credential records in the target n8n instance after importing:

1. **LeadForge CRON Bearer** — HTTP Header Auth; header `Authorization`; value `Bearer <the same environment-specific CRON_SECRET>`. Attach it only to the two scheduled calls.
2. **LeadForge feed ingress** — Header Auth credential for the partner/source that is allowed to call the intake webhook. Give it only to that producer.
3. **LeadForge source token — `<source name>`** — HTTP Header Auth credential with the one-time bearer token for one specific approved, active LeadForge source. Attach it only to the intake workflow's outbound request. Do not reuse a token across organizations or sources.

Do not store Supabase service-role, Stripe secret, or Resend API keys in these workflows. Do not enable n8n environment-variable access from Code nodes for this pack; it does not need it. Set the public app URL in each HTTP node after import.

## n8n deployment requirements

Use a supported, patched n8n release and HTTPS. For a self-hosted instance, configure these values in the n8n deployment environment (the exact hosting platform may supply host/port values itself):

| n8n variable | Requirement |
|---|---|
| `N8N_ENCRYPTION_KEY` | Required and stable across restarts/restores; protects n8n-stored credentials. Store only in the n8n secret manager. |
| `N8N_HOST` | Public DNS hostname for the n8n instance. |
| `N8N_PROTOCOL` | `https` in the deployed environment. |
| `WEBHOOK_URL` | Public HTTPS base URL used to construct the feed-ingress webhook URL. |
| `N8N_PORT` | Only when required by the selected self-hosting platform/reverse-proxy setup. Keep the editor behind the HTTPS proxy. |

Also configure a persistent database/volume. Protect the editor with authentication and network access controls; keep execution data retention conservative, back up encrypted credentials and workflow definitions, and restore-test backups. Do not expose the editor or an unauthenticated webhook on a public network without TLS and ingress controls. The workflow exports do not require `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` or access to the n8n process environment.

Use separate n8n instances or at least separate credentials and app secrets for staging and production. Start with a staging LeadForge deployment and test-only provider accounts. Workflow retries are bounded to three tries; repeated HTTP failures should be investigated in n8n execution history, not bypassed by repeated manual replay. The app ingestion endpoint deduplicates listing identities, but a provider call may still consume provider quota on retries.

## Current implementation boundary: lifecycle coverage

| Stage | Current LeadForge capability | Autopilot status |
|---|---|---|
| Discover property listings | Approved RentCast API sync; approved feed intake; separate manager-dispatched scraper worker | Two disabled n8n exports can schedule RentCast/health. No website crawling is included. |
| Qualify and deduplicate | Normalization, dedupe, scoring, and batch qualification helpers/APIs | Ingestion performs normalization/scoring/dedupe. There is no unattended policy-driven city-batch creation and approval service. |
| Match agents | Explainable matching API and persisted batch matches | Manager-triggered today; no service-authenticated scheduled matching stage. |
| Prepare personalized offer | Offer templates use persisted batch facts and matching; offer creation is manager-authenticated | Draft generation is available, but no unattended pricing policy/offer service exists. |
| Send offer and follow-ups | Individual reviewed email paths exist for a separate business-prospect workflow | Batch-offer outbound send and reply routing/follow-up policy are not implemented. No offer email is sent by this pack. |
| Verify payment | Signed Stripe webhook and checkout for legacy single-lead purchases; batch-offer payment reconciliation is manual | Batch offers have no Stripe checkout/webhook integration. Do not mark a batch payment as automatically verified. |
| Deliver purchased batch | Paid/delivered state, account linking, and buyer delivery API exist | Delivery is not autonomously chained to verified batch-offer payment. Confirm release policy and two-buyer isolation in staging first. |
| Exceptions and business decisions | Audit records and per-workflow errors | No unified exception queue/alert route is wired to these exports. n8n retry failures remain in n8n execution history. |

### Required work before full-funnel activation

The following application capabilities are prerequisites, not environment-variable toggles:

- A tenant-scoped Autopilot policy/configuration model (source allowlist, eligible market, qualification/freshness rules, pricing/currency, exclusive/shared disclosure, contact-use permissions, and approval thresholds), default-off with audit history.
- Idempotent, service-authenticated APIs/job records for qualification, exception capture, batch formation, matching, draft offers, and follow-up scheduling. Preserve human approval for configurable business decisions and route ambiguous/low-confidence cases to an exception queue.
- A consent/suppression-aware batch-offer sender and inbound reply correlation. Sending must be disabled until staging tests prove the recipient, template, unsubscribe/opt-out, rate limit, and idempotency behavior.
- Stripe test-mode checkout and signed batch-offer payment webhook that atomically verifies amount/currency/offer, is replay-safe, and never treats an n8n callback or operator note as proof of payment.
- A transactional paid-to-delivered handoff that releases only the purchased batch to its linked buyer after confirmed payment, with explicit decision on whether `paid` alone is sufficient for buyer read access.
- A persistent, tenant-scoped exception/status surface with safe retries and operator notifications.
- Security tests for cross-organization, cross-agent, unpaid, refunded, suppressed, and already-sold listing cases, plus staging end-to-end tests.

A future full Autopilot can run routine discovery, qualification, matching, policy-compliant offers/follow-ups, verified payment events, and delivery in the background; it should stop for human decisions and route failures to exceptions. Those automation APIs/controls do not exist yet, so no sales/payment workflow export is represented here as executable.

## Staged activation checklist

### Stage 0 — keep everything disabled

- Confirm which organization and disposable Supabase staging project are the intended targets. Never run migrations against an unverified project.
- Deploy the app to staging and apply only reviewed migrations through the verified project's normal release procedure. These n8n exports do not apply migrations.
- Confirm the staging app health/setup status and the exact `NEXT_PUBLIC_APP_URL`; verify no production secrets are present in the staging deployment.
- Import exports. Confirm all show **Inactive**, edit placeholder URLs, and attach credentials from staging only.

### Stage 1 — test one data source without schedules

- Register one permitted test source in staging; verify source type, approved host, organization, source status, and data-use rights.
- Execute the RentCast workflow manually once with an authorized test account, then inspect run records, dedupe, encrypted private details, and source health. Ensure no email/offer/payment/delivery occurred.
- Invoke the feed webhook only with synthetic public summary data. Verify a payload containing `privateDetails`, `ownerContact`, or `sellerContact` is rejected and no private data reaches LeadForge.
- Run source-health once and verify it changes health metadata only. Confirm the source-health output is interpreted as ingestion recency, not live provider health.

### Stage 2 — enable bounded data operations

- Only after Stage 1 passes, activate source health and then the RentCast schedule in staging. Monitor execution errors, API quotas, daily source coverage, and listing counts.
- Keep the partner webhook inactive until its ingress credential, per-source outbound token, source host, and producer are each validated.

### Stage 3 — business workflow activation (blocked until implemented)

- Do not activate sales automation yet. First implement and test the required policy APIs, offer communications, batch Stripe handling, delivery release, exception queue, and agent-isolation tests listed above.
- Then use Stripe test mode and a sandbox email domain with synthetic buyer/listing records. Exercise the full discovery → qualification → match → offer → reply/follow-up → test payment event → delivery → metrics flow, including negative tests.
- Require explicit owner sign-off on source licenses, agent contact/marketing basis, pricing and distribution rules, buyer-release semantics, and production rollout. Only after a successful staging report may a production operator activate specific workflows.

## Disable / recovery

To stop scheduled work, deactivate the relevant workflow in n8n first. For an exposed source, disable/revoke its LeadForge source token and mark the source inactive. For provider incidents, remove/rotate the provider secret in the deployment secret manager. Preserve failed execution IDs and LeadForge run/audit IDs for diagnosis; do not blindly replay payment or delivery events.
