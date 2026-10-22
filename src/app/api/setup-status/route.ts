import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    mode: process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "live-auth-ready" : "demo",
    integrations: {
      supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      n8n: Boolean(process.env.N8N_BASE_URL && process.env.N8N_WEBHOOK_SECRET),
      gmail: Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET),
      ai: Boolean(process.env.AI_PROVIDER_API_KEY),
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
