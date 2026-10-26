import { NextResponse } from "next/server";

export async function GET() {
  const supabaseConfigured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL
    && (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
  return NextResponse.json({
    mode: supabaseConfigured ? "supabase-configured" : "setup-required",
    integrations: {
      supabase: supabaseConfigured,
      ingestionServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      ownerDataEncryption: Boolean(process.env.OWNER_DATA_ENCRYPTION_KEY),
      rentcast: Boolean(process.env.RENTCAST_API_KEY),
      untera: Boolean(process.env.UNTERA_API_KEY),
      unteraCommercialUseAuthorized: process.env.UNTERA_COMMERCIAL_USE_AUTHORIZED === "true",
      unteraListingReuseAuthorized: process.env.UNTERA_LISTING_REUSE_AUTHORIZED === "true",
      scheduledJobs: Boolean(process.env.CRON_SECRET),
      stripeLeadPayments: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
