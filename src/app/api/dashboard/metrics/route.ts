import { NextResponse } from "next/server";
import { getOrganizationMember } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });

  const [listings, ownerLed, agent, pending] = await Promise.all([
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("organization_id", member.organization_id).is("suppressed_at", null),
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("organization_id", member.organization_id).eq("owner_led_claim", true).is("suppressed_at", null),
    supabase.from("agents").select("id").eq("organization_id", member.organization_id).eq("user_id", user.id).maybeSingle(),
    supabase.from("interest_requests").select("id", { count: "exact", head: true }).eq("organization_id", member.organization_id).eq("status", "pending"),
  ]);
  if (listings.error || ownerLed.error || agent.error || pending.error) return NextResponse.json({ error: "Unable to calculate workspace metrics" }, { status: 500 });
  const isManager = ["owner", "admin", "manager"].includes(member.role);
  let agentPendingCount: number | null = null;
  if (!isManager && agent.data) {
    const { count, error } = await supabase.from("interest_requests").select("id", { count: "exact", head: true })
      .eq("organization_id", member.organization_id).eq("agent_id", agent.data.id).eq("status", "pending");
    if (error) return NextResponse.json({ error: "Unable to calculate agent interest requests" }, { status: 500 });
    agentPendingCount = count ?? 0;
  }
  return NextResponse.json({
    data: {
      openOpportunities: listings.count ?? 0,
      ownerLedSignals: ownerLed.count ?? 0,
      pendingInterest: isManager ? pending.count ?? 0 : agentPendingCount,
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
