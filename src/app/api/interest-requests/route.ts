import { NextResponse } from "next/server";
import { getOrganizationMember } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });
  const { data, error } = await supabase.from("interest_requests")
    .select("id,status,message,requested_at,match_id,agent_id,matches(listing_id,score,reasons,listings(title,summary,city,area,property_type))")
    .eq("organization_id", member.organization_id)
    .order("requested_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "Unable to load approval queue" }, { status: 500 });
  return NextResponse.json({ data });
}
