import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    mode: process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "supabase-configured" : "setup-required",
    integrations: {
      supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      ingestionServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      ownerDataEncryption: Boolean(process.env.OWNER_DATA_ENCRYPTION_KEY),
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
