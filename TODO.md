# LeadForge implementation status

## Implemented in the current MVP

- [x] Supabase Auth shell, organization bootstrap, server-side membership checks, and organization-scoped RLS.
- [x] Canonical property opportunity records distinct from legacy inbound buyer leads.
- [x] Authenticated manual intake plus source-token webhook intake for normalized public summaries.
- [x] Inactive-by-default external sources, owner/admin approval, one-time source-scoped tokens, and source health on successful ingestion.
- [x] Organization-level deduplication, sanitized source snapshots, deterministic scoring with factors, and location/specialty/budget agent matching.
- [x] Human verification state and evidence records for owner-listed claims; verification does not unlock private details.
- [x] Summary-first matched-agent flow, explicit interest, reviewer decision with reason, and matched-agent-only private detail reveal.
- [x] AES-256-GCM encryption of optional private details; detail reveal audit; suppression and owner opt-out handling.
- [x] Dashboard data comes from live organization APIs; empty/setup/error states replace the former sample data and invented metrics.
- [x] Responsive UI foundation, source/agent setup views, approval queue, security policy, contribution guide, environment example, and architecture/setup documentation.
- [x] Disabled n8n workflow template for approved-source webhook orchestration.

## Remaining before production consideration

- [ ] Add automated unit/integration tests, including RLS cross-organization and denied-detail cases.
- [ ] Add a supported agent invitation and organization membership administration flow.
- [ ] Add organization switching for users with multiple memberships.
- [ ] Implement a real approved source adapter with contract/legal review, quotas, retries, and scheduled health checks.
- [ ] Make ingestion side effects transactional and add idempotent repair for partial failures.
- [ ] Add rate limiting, request-size limits, monitoring, alerting, retention controls, backup verification, and operational runbooks.
- [ ] Implement a keyring/rotation procedure and tested recovery path for encrypted records.
- [ ] Add an independently reviewed outbound channel only if explicit consent, suppression, per-message approval, idempotency, and audit requirements are met.
- [ ] Run a deployment-level security review and full Supabase-backed acceptance tests.

No production deployment, live email integration, AI provider, or production metrics are claimed.

## Local verification

```bash
pnpm install
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```
