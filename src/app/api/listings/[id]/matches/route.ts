import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { scoreAgentMatch } from "@/lib/opportunities";
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
  const ranked = (profiles ?? [])
    .filter((profile) => activeIds.has(profile.agent_id))
    .map((profile) => {
      const result = scoreAgentMatch(listing, { ...profile, active: true });
      return { id: "", agent_id: profile.agent_id, display_name: profile.display_name, score: result.score, reasons: result.reasons };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, parsed.data.limit);

  if (ranked.length) {
    const { data: savedMatches, error } = await supabase.from("matches").upsert(
      ranked.map((match) => ({
        organization_id: member.organization_id,
        listing_id: listing.id,
        agent_id: match.agent_id,
        score: match.score,
        reasons: match.reasons,
      })),
      { onConflict: "listing_id,agent_id" },
    ).select("id,agent_id");
    if (error) return NextResponse.json({ error: "Unable to save agent matches" }, { status: 500 });
    const matchIds = (savedMatches ?? []).map((match) => match.id);
    const { data: existingMessages, error: messagesError } = matchIds.length
      ? await supabase.from("outreach_messages").select("match_id").in("match_id", matchIds)
      : { data: [], error: null };
    if (messagesError) return NextResponse.json({ error: "Matches saved but summary notices could not be checked" }, { status: 500 });
    const existingMessageIds = new Set((existingMessages ?? []).map((message) => message.match_id));
    const newMatches = (savedMatches ?? []).filter((match) => !existingMessageIds.has(match.id));
    if (newMatches.length) {
      const { error: noticeError } = await supabase.from("outreach_messages").insert(newMatches.map((match) => ({
        organization_id: member.organization_id,
        match_id: match.id,
        channel: "in_app",
        summary: listing.summary,
        status: "draft",
      })));
      if (noticeError) return NextResponse.json({ error: "Matches saved but summary-only notices could not be created" }, { status: 500 });
    }
    const matchIdByAgent = new Map((savedMatches ?? []).map((match) => [match.agent_id, match.id]));
    for (const match of ranked) match.id = matchIdByAgent.get(match.agent_id) ?? "";
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
