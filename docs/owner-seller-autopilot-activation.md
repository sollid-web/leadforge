# LeadForge owner-seller Autopilot: deployment and activation

## What the workflow does

Once deployed and scheduled, LeadForge can routinely discover candidate owner-posted **sale** leads through the isolated worker, receive its bearer-authenticated callback, validate and deduplicate the manifest, encrypt contact fields, and place eligible candidates in the manager owner-review flow. Explicit agent/broker matches are rejected before contact extraction; records lacking a source signal are held in a contact-free manager exception queue. The primary path is scheduled discovery; manual entry and CSV import remain exceptional fallbacks.

Automation does **not** verify ownership, mark seller contact permission, send agent outreach, approve a sale batch, confirm payment, or deliver a paid lead. Managers retain those ownership and business decisions. A scraped result is stored as `OWNER_UNVERIFIED`; contact permission remains `unknown` until a human decision is recorded. Agents cannot read the review contact view or another agent's restricted/purchased lead data.

The worker supports only its configured US sale sources and city/area labels. A source/city pair outside the adapter’s configured coverage is rejected before dispatch. Source permission is an organization assertion backed by a recorded reference, scope and expiry; the software does not determine a site's legal terms or permission automatically.

## Workflow and gates

1. An owner/admin/manager registers the supported external source, confirms its exact HTTPS base URL, and approves/activates the source.
2. In **Dashboard → Leads → Owner-seller scraper schedule**, the manager records the permission reference, authorized collection scope, city, result cap, cadence (24–168 hours) and permission expiry. The UI displays only city labels implemented for that source.
3. An external scheduler calls `POST /api/automation/owner-discovery`. The endpoint validates `CRON_SECRET`, worker configuration, callback origin and AES encryption readiness before atomically claiming one due policy.
4. LeadForge dispatches an authenticated job to the isolated worker. Live collection is disabled unless **both** the LeadForge app flag and worker flag are explicitly set to `true`; either missing or false flag produces an offline dry-run callback with zero leads and no source requests. The callback is authenticated with the worker bearer token; it is not a cryptographic webhook signature.
5. When live collection is explicitly enabled, the worker returns a bounded manifest. Its shared source-aware filter rejects clear agent/broker evidence before contact extraction, treats configured owner-search/source paths only as unverified candidate evidence, and marks records without a configured owner signal for a contact-free hold. LeadForge rechecks the run scope, current source approval, adapter host, supported city, authorization expiry, result cap and sale intent; it encrypts contacts for eligible candidates with AES-256-GCM. Source-page wording and heuristics do not prove legal ownership. The worker's temporary artifacts need a separate private retention/deletion policy.
6. A manager opens **Review owner/contact** for each candidate, examines the original posting and independent evidence, and records an ownership verification decision. The system never promotes the scrape's owner claim to verified automatically. After a successful human verification, LeadForge prepares a one-lead outreach draft for reviewed, market-compatible agent prospects who have contact on file, have not opted out, and have not used their linked trial. The draft includes no seller contact details.
7. The batch qualifier and `approve_lead_batch` RPC require `owners.verification_status = 'verified'`, a contact on file that has not opted out, an approved active source, fresh records, and the remaining batch rules. Standard agent-sale batches still require at least 20 leads.
8. The verified-lead trial path remains separate from bulk sale batches: after human ownership verification, the first eligible no-charge sample is limited to **one per agent** and linked to that agent. The new unapplied migration replaces the earlier per-organization sample cap and stores trial outreach drafts. Drafts appear under **Dashboard → Offers** and can be copied or dismissed by a manager; edit the copied text before manually sending it through an authorized channel. This implementation never sends them. A reply, trial eligibility, price/terms, payment state and delivery remain explicit business decisions. The sample never exposes an unverified candidate; later access for the same agent follows the payment-required flow.

## Required server configuration

Use a secret manager or private deployment settings; never commit secret values. The names below match `.env.example`.

### LeadForge application

- `NEXT_PUBLIC_APP_URL`: the canonical public HTTPS origin for callbacks, e.g. `https://app.example.com` (no path/query).
- `SUPABASE_SERVICE_ROLE_KEY`: server-only service-role credential for scoped scheduler claims and ingestion; do not expose it to the browser.
- `OWNER_DATA_ENCRYPTION_KEY`: base64-encoded 32-byte AES key. Generate with `openssl rand -base64 32`; store securely and back it up under the organization's key-rotation procedure.
- `CRON_SECRET`: random secret of at least 32 characters used by the external scheduler. Generate, for example, with `openssl rand -hex 32`.
- `LEADFORGE_SCRAPER_WORKER_URL`: the worker's HTTPS `/runs` endpoint.
- `LEADFORGE_SCRAPER_WORKER_TOKEN`: the same random 32+ character token configured as `LEADFORGE_WORKER_TOKEN` on the worker.
- `LEADFORGE_SCRAPER_LIVE_COLLECTION_ENABLED=false`: keep false during staging and all dry-run validation. Change to exactly `true` only for an explicitly approved live collection deployment.
- Existing Supabase public URL/key variables must target the **verified** project environment.

### Isolated scraper worker

Set `LEADFORGE_WORKER_TOKEN` to match the LeadForge worker token. Configure `LEADFORGE_WORKER_HOST`, `LEADFORGE_WORKER_PORT`, and a private mounted `LEADFORGE_ARTIFACT_DIR` (default `/data/artifacts`). Keep `LEADFORGE_WORKER_LIVE_COLLECTION_ENABLED=false` for dry-run testing. Live collection requires this worker-side flag **and** the LeadForge app-side flag to be true. Run the worker behind TLS or a private network with TLS termination; do not expose its port publicly. Set a finite artifact-retention/deletion policy and restrict volume access. The worker does not write contacts to LeadForge directly; it calls the app callback with counts/progress, and the app fetches the artifact over the authenticated worker endpoint.

## Staging deployment sequence

1. **Verify the target Supabase project before migration.** Confirm the selected organization/project reference in the Supabase CLI and deployment settings; compare it to the intended staging project. Do not run migrations against an unverified project. The migration `202610280001_owner_discovery_automation.sql` is new for this change and is not applied by this repository update.
2. Back up the staging database and apply the pending migration to staging only. Confirm the new `owner_discovery_policies`, `scraper_candidate_holds`, and `trial_outreach_drafts` tables, `held_count`, ingestion columns, `claim_due_owner_discovery_policy()` function, replacement `approve_lead_batch()` and `prepare_owner_lead_access()` functions, and the `lead_purchases_one_sample_per_agent` index exist. Review the query/RLS/role grants before production rollout.
3. Deploy the LeadForge application code and configure the application environment variables above. Keep live collection false.
4. Build and deploy the isolated worker from the Scraper repository root:

   ```sh
   docker build -f worker/Dockerfile -t leadforge-scraper-worker .
   ```

   Mount the private artifact volume and configure the worker token plus `LEADFORGE_WORKER_LIVE_COLLECTION_ENABLED=false`. The image is not built or deployed by these code changes.
5. Verify the worker from a trusted network using its bearer token: `GET /health` should return `status: "ok"` and `busy: false`. Verify the app's `NEXT_PUBLIC_APP_URL` is the public HTTPS callback origin and that the worker can reach it.
6. Configure an external platform cron / n8n schedule to call the app every 15 minutes. The application endpoint claims at most one due policy per request, so concurrent ticks are safe; the worker itself accepts one job at a time. Store `CRON_SECRET` in the scheduler's secret store:

   ```sh
   curl --fail-with-body -X POST \
     -H "Authorization: Bearer ${CRON_SECRET}" \
     "${LEADFORGE_APP_URL}/api/automation/owner-discovery"
   ```

   Configure the cron provider to use secret interpolation rather than embedding the value in a checked-in file or URL. The scheduler is application-owned; this change does not install a hosted cron service or activate the existing disabled n8n pack.
7. Create/approve the authorized source and enable one policy in the manager UI. With both live flags false, the scheduled worker should validate configuration and report `dry_run`, with no source requests, no manifest ingestion, and zero lead/contact counts. Confirm that the callback and run-status record update correctly.
8. Before any live collection, the source-specific written permission, exact scope, host, city, cadence, expiry, retention and privacy review must be complete. Then explicitly enable both live flags in staging and run one narrowly scoped authorized test (result cap 1) only after an owner/authorized administrator approves that action. Inspect the encrypted candidate in the manager review UI; do not send outreach or payment during this test.
9. Only after staging evidence is reviewed should the migration and code be promoted to the verified production project. Enable the production live flags only after an authorized business owner confirms the source scope and operational readiness.

### Health checks and retries

The worker's authenticated `GET /health` reports process readiness and whether its single job slot is busy; it does not prove that a source is reachable. LeadForge stores per-run progress, heartbeat, imported/duplicate/rejected/held counts, source health and policy outcome. A failed run is not automatically retried immediately: an enabled policy becomes eligible at its next configured cadence (24–168 hours). The current worker does not retry an individual source request, and a lost worker process may leave a run record in `running` until an operator reconciles it. Review failed/degraded/stale runs and the source health dashboard; do not assume an HTTP 202 means collection or ingestion succeeded.

## Human review and one-lead trial

- A candidate begins unverified. A manager must inspect its source and confirm owner identity before verification.
- Contact reveal for that review is manager-only and audit logged. A lead batch cannot be approved merely because the scraper labeled the result owner-posted.
- The new migration changes the legacy one-free-sample rule from **per organization** to **one per agent**. This policy change is not active until the migration is reviewed and applied to the verified target environment.
- Agent message/offer drafts, follow-ups, price/discount decisions, payment verification, and delivery require configured integrations and explicit manager approval. Do not treat a drafted offer or simulated payment as sent or paid.

## Activation checklist

### Before a dry run

- [ ] Confirm staging Supabase project identity and apply the reviewed migration to staging only.
- [ ] Deploy LeadForge and the isolated worker over HTTPS/private networking.
- [ ] Configure service-role access, callback origin, worker URL/token, encryption key and cron secret in server-side secret stores.
- [ ] Keep both live-collection flags false; verify worker health and app callback reachability.
- [ ] Approve a supported source record and record its source terms/permission evidence in the manager policy form.
- [ ] Add the 15-minute scheduler and confirm an offline dry-run status without source traffic.

### Before the first authorized live trial

- [ ] Confirm the source owner grants the documented collection permission for the exact adapter, scope, contact fields, city and cadence; set a finite expiry.
- [ ] Confirm applicable legal/privacy review, lawful purpose, retention/deletion and contact-use policy.
- [ ] Review worker source adapter coverage and the source's current terms; do not bypass logins, CAPTCHAs, blocks or access controls.
- [ ] Obtain explicit approval to change both live flags to `true` in the intended environment.
- [ ] Run one source/city policy with result limit 1; confirm encrypted contact persistence, `OWNER_UNVERIFIED` classification, duplicates/rejections and audit events.
- [ ] Have a manager verify the lead and contact independently; only then test the single per-agent sample path with an authorized test agent.
- [ ] Keep outreach delivery, payment collection and paid lead delivery disabled until each integration and human approval step has been tested separately.

## What this change does not prove

No migration was applied to a live Supabase project, no worker image was built/deployed, no cron provider was configured, no live collection was run, and no payment or agent message was sent as part of this implementation. Passing local tests and a dry-run callback demonstrates code-level behavior only; it is not production end-to-end validation.
