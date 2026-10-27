import { NextResponse } from "next/server";
import { matchAgentsToBatch, type BatchMatchFacts, type DirectoryAgent } from "@/lib/agent-sales-pipeline";
import { getSalesManagerContext } from "@/lib/sales-auth";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  const { data: batch, error: batchError } = await context.admin.from("lead_batches")
    .select("id,city,country_code,currency,status,minimum_freshness_days,summary")
    .eq("id", id).eq("organization_id", context.organizationId).maybeSingle();
  if (batchError) return NextResponse.json({ error: "Unable to load batch" }, { status: 500 });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  if (!["ready_for_review", "approved"].includes(batch.status)) return NextResponse.json({ error: "Batch must have at least 20 qualified records before matching" }, { status: 409 });
  const summary = (batch.summary ?? {}) as Record<string, unknown>;
  const facts: BatchMatchFacts = {
    city: batch.city,
    region: typeof summary.region === "string" ? summary.region : null,
    countryCode: batch.country_code,
    currency: batch.currency,
    leadCount: Number(summary.lead_count ?? 0),
    propertyTypes: (summary.property_types ?? {}) as Record<string, number>,
    listingTypes: (summary.listing_types ?? {}) as Record<string, number>,
    priceMin: typeof summary.asking_price_min === "number" ? summary.asking_price_min : null,
    priceMax: typeof summary.asking_price_max === "number" ? summary.asking_price_max : null,
    freshnessDays: batch.minimum_freshness_days,
  };
  const [{ data: agents, error: agentError }, { data: offers, error: offerError }] = await Promise.all([
    context.admin.from("agent_directory").select("id,name,country_code,city,service_areas,preferred_property_types,preferred_listing_types,preferred_currency,min_lead_volume,max_lead_volume,min_budget,max_budget,status")
      .eq("organization_id", context.organizationId).not("status", "in", "(inactive,opted_out)").limit(500),
    context.admin.from("lead_offers").select("agent_directory_id").eq("organization_id", context.organizationId).eq("batch_id", batch.id),
  ]);
  if (agentError || offerError) return NextResponse.json({ error: "Unable to load agent preferences or offer history" }, { status: 500 });
  const ranked = matchAgentsToBatch(facts, (agents ?? []) as DirectoryAgent[]);
  const existingIds = new Set((offers ?? []).map((offer) => offer.agent_directory_id));
  const excluded = [
    ...ranked.excluded,
    ...ranked.matches.filter((match) => existingIds.has(match.agentId)).map((match) => ({ agentId: match.agentId, agentName: match.agentName, reason: "An offer already exists for this agent and batch." })),
  ];
  const matches = ranked.matches.filter((match) => !existingIds.has(match.agentId));
  if (matches.length) {
    const { error } = await context.admin.from("lead_batch_agent_matches").upsert(matches.map((match) => ({
      organization_id: context.organizationId,
      batch_id: batch.id,
      agent_directory_id: match.agentId,
      score: match.score,
      factors: match.factors,
      matched_at: new Date().toISOString(),
    })), { onConflict: "batch_id,agent_directory_id" });
    if (error) return NextResponse.json({ error: "Matches were calculated but could not be saved" }, { status: 500 });
  }
  return NextResponse.json({ data: { matches, excluded } }, { headers: { "Cache-Control": "private, no-store" } });
}
