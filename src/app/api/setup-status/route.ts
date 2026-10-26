import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    mode: process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "supabase-configured" : "setup-required",
    integrations: {
      supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      ingestionServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      ownerDataEncryption: Boolean(process.env.OWNER_DATA_ENCRYPTION_KEY),
      rentcast: Boolean(process.env.RENTCAST_API_KEY),
      scheduledJobs: Boolean(process.env.CRON_SECRET),
      stripeLeadPayments: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
