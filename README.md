

## LeadForge runtime modes

The application runs safely in demo mode when Supabase environment variables are absent. Demo mode keeps the dashboard and read-only lead API usable while clearly reporting `mode: "demo"` from `/api/setup-status` and `/api/leads`.

To enable live authentication, copy `.env.example` to `.env.local` and provide `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Apply the SQL migration in `supabase/migrations/` first. The middleware then refreshes Supabase sessions and protects `/dashboard/*`; unauthenticated users are redirected to `/sign-in`.

The public auth routes are `/sign-in`, `/sign-up`, and `/reset-password`. The `/api/leads` endpoint validates create requests with Zod and scopes live reads and writes through the authenticated user’s organization membership. No service-role key is required by the browser, and no secret values belong in `NEXT_PUBLIC_*` variables.

The connected Supabase project is the active `automation` project in `eu-west-1`. It already contains the organizations, organization members, leads, lead activities, and follow-up task tables with RLS enabled, so the live database schema is treated as authoritative. The repository migration remains a fresh-project reference and should not be applied over the connected database without a reviewed reconciliation migration.

Gmail is enabled through the connected Gmail integration for approved outreach. LeadForge keeps the approval gate active: configuring Gmail does not send any message, and a lead email must still be reviewed and explicitly approved before dispatch. The Settings screen reflects this state as `Connected` with the approval gate active.
