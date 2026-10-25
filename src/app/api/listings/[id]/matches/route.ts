import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { saveAgentMatches } from "@/lib/matching";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const matchRequestSchema = z.object({ limit: z.number().int().min(1).max(50).default(10) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = matchRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid match request", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id,title,summary,city,region,property_type,price,currency")
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (listingError) return NextResponse.json({ error: "Unable to load opportunity" }, { status: 500 });
  if (!listing) return NextResponse.json({ error: "Opportunity not found" }, { status: 404 });

  const { data: profiles, error: profilesError } = await supabase
    .from("agent_profiles")
    .select("agent_id,service_areas,specialties,display_name,currency,min_budget,max_budget")
    .eq("organization_id", member.organization_id);
  if (profilesError) return NextResponse.json({ error: "Unable to load agent profiles" }, { status: 500 });
  const agentIds = (profiles ?? []).map((profile) => profile.agent_id);
  const { data: agents, error: agentsError } = agentIds.length
    ? await supabase.from("agents").select("id,active").in("id", agentIds).eq("organization_id", member.organization_id)
    : { data: [], error: null };
  if (agentsError) return NextResponse.json({ error: "Unable to load agents" }, { status: 500 });
  const activeIds = new Set((agents ?? []).filter((agent) => agent.active).map((agent) => agent.id));
  let ranked: Awaited<ReturnType<typeof saveAgentMatches>>;
  try {
    ranked = await saveAgentMatches(supabase, member.organization_id, listing, profiles ?? [], activeIds, parsed.data.limit);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save agent matches" }, { status: 500 });
  }
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "listing.matches_calculated",
      entityType: "listing",
      entityId: listing.id,
      metadata: { matched_agent_count: ranked.length },
    });
  } catch {
    return NextResponse.json({ error: "Matches were calculated but the audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: ranked });
}
