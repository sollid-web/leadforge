export async function GET() {
  const configured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return Response.json({
    status: configured ? "configured" : "setup_required",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    checks: { supabaseConfiguration: configured },
  }, {
    status: configured ? 200 : 503,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}