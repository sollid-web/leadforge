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
  const { data: agent, error: agentError } = await supabase.from("agents").select("id").eq("organization_id", member.organization_id).eq("user_id", user.id).maybeSingle();
  if (agentError) return NextResponse.json({ error: "Unable to load agent profile" }, { status: 500 });
  if (!agent) return NextResponse.json({ data: [] });
  const { data: matches, error } = await supabase.from("matches")
    .select("id,listing_id,score,reasons,status,created_at")
    .eq("organization_id", member.organization_id)
    .eq("agent_id", agent.id)
    .order("score", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: "Unable to load agent matches" }, { status: 500 });
  const listingIds = (matches ?? []).map((match) => match.listing_id);
  const { data: listings, error: listingError } = listingIds.length
    ? await supabase.from("listings").select("id,title,summary,property_type,area,city,price,currency").in("id", listingIds)
    : { data: [], error: null };
  if (listingError) return NextResponse.json({ error: "Unable to load matched opportunity summaries" }, { status: 500 });
  const { data: interests, error: interestError } = matches?.length
    ? await supabase.from("interest_requests").select("id,match_id,status").in("match_id", matches.map((match) => match.id))
    : { data: [], error: null };
  if (interestError) return NextResponse.json({ error: "Unable to load interest request status" }, { status: 500 });
  const listingById = new Map((listings ?? []).map((listing) => [listing.id, listing]));
  const interestByMatch = new Map((interests ?? []).map((interest) => [interest.match_id, interest]));
  return NextResponse.json({
    data: (matches ?? []).map((match) => ({
      ...match,
      listing: listingById.get(match.listing_id) ?? null,
      interest: interestByMatch.get(match.id) ?? null,
    })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}
