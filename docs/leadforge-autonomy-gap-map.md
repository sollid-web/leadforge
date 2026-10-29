# LeadForge autonomy gap map

**Status:** repository-code audit, 2026-10-28. This is not a production or end-to-end test. No external site was scraped, no message was sent, no payment was made, and no migration was applied during this audit.

## What exists versus what is operational

| Stage | Present in repository | What is still missing or unknown |
|---|---|---|
| Property discovery | `scraper.py` has Craigslist, ForSaleByOwner.com, and ByOwner.com adapters with Florida search paths. The isolated worker has authenticated dispatch, dry-run defaults, callbacks, and a CSV artifact path. LeadForge has manual and scheduled dispatch endpoints. | No deployed worker/scheduler, source policies, live secrets, or successful run was verified. Source-site selectors and permission must be checked before collection. |
| Owner versus agent | The worker now applies one conservative classifier to Craigslist, ForSaleByOwner.com, and ByOwner.com. Explicit agent/broker cues are rejected before contact extraction; owner-focused source/search-path signals produce only `OWNER_UNVERIFIED` candidates; records without a configured source signal become holds. | Local fixtures test the classifier, but it has not been validated against current live-site HTML. Text heuristics cannot guarantee legal ownership; human review remains mandatory. |
| Ingestion and qualification | LeadForge's authenticated completion callback imports eligible candidate rows, encrypts contacts, deduplicates listings, and saves ambiguous records to a contact-free manager-only hold table. Batch qualification still requires human-verified owners. | Live callback-to-database execution is unverified and the hold-queue schema is part of the unapplied migration. Qualification and batch creation are not yet an autonomous post-verification loop. |
| Buyer acquisition and matching | Organization agent records and a manager-maintained prospect directory exist. Matching helpers and a route persist compatible agent matches. After an owner is human-verified, LeadForge prepares an idempotent one-lead trial outreach draft for reviewed, market-compatible agents with contact on file who have not opted out or used their linked trial. | Automated acquisition of agent prospects is absent in inspected routes. Directory population, source provenance, and live matching data are unknown. |
| Offers and follow-ups | Bulk offer templates, records, state-transition RPCs, and manager-only trial outreach drafts exist. Trial messages contain no seller contacts and can be copied from Dashboard → Offers. | Trial drafts are not sent automatically; no autonomous scheduled follow-up or inbound reply loop is evidenced. No messaging provider configuration was confirmed. |
| Payment and delivery | A Stripe webhook exists for legacy `lead_purchases`. The newer `lead_offers` flow has manual payment evidence reconciliation and manager-confirmed delivery. Linked buyers can retrieve paid/delivered records through a scoped API. | The legacy Stripe path is disconnected from `lead_offers`. Live Stripe events and authorization are unverified. Automatic offer payment and post-payment delivery are not established. |
| Continuous operation | Due-policy claims, worker callbacks, run data, source-health calculations, and sales-metric APIs exist. | The scheduler is an external setup step. No immediate retries, alert delivery, or stale-run reconciliation was found in the audited paths. Metrics are code, not verified runtime data. |

## Key safety and product rules

- The new worker filter rejects explicit agent/broker evidence, but it is a screening layer—not title verification, and its live-site precision/recall is not established.
- A site label or owner-focused search is evidence about how a listing was categorized, not independent proof of legal ownership. Keep candidate, ownership-verification, and contact-permission states distinct.
- Do not expose seller contact details to an agent before the configured eligibility and buyer-access checks pass.
- Sending agent outreach, reconciling payment, and delivering access must be idempotent, auditable, and gated by configured provider credentials and explicit campaign policy.
- Existing code and an accepted configuration are not proof that the app, worker, scheduler, database, or integrations are deployed.

## Recommended smallest complete staging slice

1. Apply the pending schema and deploy the current source filter/ingestion changes to staging; review the hold queue and use labeled live-page fixtures for the three configured adapters without bypassing source controls.
2. Verify one authorized dry-run through callback, encrypted ingestion, deduplication, manager ownership review, and post-verification creation of a no-send one-lead trial outreach draft for a qualifying reviewed agent.
3. Confirm a manager edits and manually sends the draft through an approved channel only after checking the agent contact and communication rules; verify a reply cannot expose seller details before eligibility is confirmed.
4. Connect the `lead_offers` state to one provider-backed checkout/webhook path, then test provider-verified payment and delivery only to the linked buyer account in staging.
5. Configure an external scheduler and test retries, stale-run recovery, alerting, opt-outs, idempotency, and tenant isolation before enabling live collection or outbound messages.

## Not verified

No live source authorization, production database linkage, migration state, environment secret, worker deployment, scheduler, provider credential, scrape result, buyer response, payment, or delivery was verified. The first staging run must be treated as a test and must not be described as a completed sale.
