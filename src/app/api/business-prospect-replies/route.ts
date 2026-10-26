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

  const { data, error } = await supabase.from("business_prospect_replies")
    .select("id,prospect_id,sender_email,subject,message,status,ai_draft,reply_body,received_at,replied_at")
    .eq("organization_id", member.organization_id)
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: "Unable to load prospect replies" }, { status: 500 });

  return NextResponse.json({
    data: data ?? [],
  }, { headers: { "Cache-Control": "private, no-store" } });
}
