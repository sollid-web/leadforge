# Security policy

## Project status and scope

EstatelQ is an MVP. It has not undergone an independent security assessment and is not certified for production use. Do not use real owner contact information until the deployment, organization policies, Supabase RLS, encryption-key lifecycle, backups, and legal basis for processing have been reviewed.

## Reporting a vulnerability

Please do not post credentials, personal data, or exploit details in a public issue. Use the repository host's private vulnerability reporting feature when available. Otherwise contact the repository maintainers through a private channel and include:

- affected route, file, or component;
- impact and prerequisites;
- a minimal, non-destructive reproduction;
- any suggested remediation.

Reports will be reviewed as maintainers are available. No response-time or bounty commitment is implied.

## Security controls in this MVP

- Supabase Auth user lookup and organization membership checks are performed server-side for API operations.
- Tenant-owned tables use row-level security policies.
- The service-role key is only used in the server-side source-token ingestion route.
- External sources are inactive until an owner/admin explicitly approves them; the app does not fetch or scrape source URLs.
- Webhook ingestion uses a random per-source bearer token, stores only its SHA-256 hash, and accepts public listing fields only.
- Private listing and owner data is encrypted with AES-256-GCM before it is stored. The decryption key is server-only.
- Detail access requires a match, an explicit agent interest request, manager approval, and an unsuppressed listing. The matched agent is the only user allowed to retrieve the decrypted response through the application.
- Approval decisions, ingestion, source changes, suppression, and detail reveal are audited.
- Automated owner contact and email dispatch are not implemented.

## Known limitations / deployment responsibilities

- Authentication, database, and RLS integration tests are not included. Validate cross-tenant and role access in a non-production Supabase project before deployment.
- There is no built-in rate limiter, WAF configuration, MFA enforcement, staff invitation workflow, billing system, retention scheduler, or independent monitoring integration.
- Organization selection currently uses the first membership returned by the API; a user-facing organization switcher is not implemented.
- App-level encryption has one active key version and no automated rotation/re-encryption support. Losing the key makes encrypted records unrecoverable.
- The health endpoint reports required configuration presence, not database reachability.
- Webhook source health reflects successful ingestion requests; no scheduled remote source-health probe is implemented.
- Source approval is an organizational assertion, not a legal/contract review performed by EstatelQ.
- Data retention, lawful basis, consent, and opt-out obligations vary by jurisdiction and remain the operator's responsibility.

Never commit secrets, use the service-role key in a browser, log raw webhook tokens or private detail payloads, or expose owner contact information in an outreach summary.
