import { NextResponse } from "next/server";
import { getUnteraManagerContext } from "@/lib/untera-auth";

export async function GET() {
  const context = await getUnteraManagerContext();
  if ("error" in context) return NextResponse.json({ error: context.error }, { status: context.status });
  const [runs, sources] = await Promise.all([
    context.supabase.from("listing_collection_runs")
      .select("id,source_id,status,discovered_count,imported_count,duplicate_count,rejected_count,contacts_found_count,known_poster_count,unknown_poster_count,error_message,started_at,completed_at,search_filters")
      .eq("organization_id", context.organizationId)
      .eq("provider", "untera")
      .order("started_at", { ascending: false })
      .limit(20),
    context.supabase.from("listing_sources")
      .select("id,name,approved,active,source_health(status,last_checked_at,last_success_at,last_sync_attempt_at,consecutive_failures,message)")
      .eq("organization_id", context.organizationId)
      .eq("configuration->>provider", "untera"),
  ]);
  if (runs.error || sources.error) return NextResponse.json({ error: "Unable to load Untera run history and source health." }, { status: 500 });
  return NextResponse.json({
    runs: runs.data,
    sources: sources.data,
    integration: {
      apiKeyConfigured: Boolean(process.env.UNTERA_API_KEY),
      commercialUseAuthorized: process.env.UNTERA_COMMERCIAL_USE_AUTHORIZED === "true",
      listingReuseAuthorized: process.env.UNTERA_LISTING_REUSE_AUTHORIZED === "true",
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
