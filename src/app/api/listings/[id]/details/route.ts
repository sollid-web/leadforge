import { NextResponse } from "next/server";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { decryptPrivateData } from "@/lib/private-data";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });
  const { data: agent, error: agentError } = await supabase.from("agents").select("id").eq("organization_id", member.organization_id).eq("user_id", user.id).eq("active", true).maybeSingle();
  if (agentError) return NextResponse.json({ error: "Unable to validate agent access" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "An agent profile is required to view private details" }, { status: 403 });
  const { data: canReveal, error: revealCheckError } = await supabase.rpc("agent_can_reveal_listing", { target_listing: id });
  if (revealCheckError) return NextResponse.json({ error: "Unable to validate approved detail access" }, { status: 500 });
  if (!canReveal) return NextResponse.json({ error: "Private details require an approved interest request" }, { status: 403 });
  const { data: matches, error: matchError } = await supabase.from("matches").select("id").eq("organization_id", member.organization_id).eq("listing_id", id).eq("agent_id", agent.id);
  if (matchError) return NextResponse.json({ error: "Unable to load approved opportunity match" }, { status: 500 });
  const matchIds = (matches ?? []).map((match) => match.id);
  const { data: interests, error: interestError } = matchIds.length
    ? await supabase.from("interest_requests").select("id").in("match_id", matchIds).eq("agent_id", agent.id).eq("status", "approved")
    : { data: [], error: null };
  if (interestError) return NextResponse.json({ error: "Unable to load approved interest request" }, { status: 500 });

  const { data: encrypted, error } = await supabase.from("listing_private_details")
    .select("ciphertext,iv,auth_tag,key_version")
    .eq("listing_id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to load approved private details" }, { status: 500 });
  if (!encrypted) return NextResponse.json({ error: "No private details are available for this opportunity" }, { status: 404 });

  let details: Record<string, string>;
  try {
    details = decryptPrivateData({ ciphertext: encrypted.ciphertext, iv: encrypted.iv, auth_tag: encrypted.auth_tag });
  } catch {
    return NextResponse.json({ error: "Private detail decryption failed; contact the workspace administrator" }, { status: 500 });
  }
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "listing.private_details_revealed",
      entityType: "listing",
      entityId: id,
      metadata: { interest_request_id: interests?.[0]?.id ?? null },
    });
  } catch {
    return NextResponse.json({ error: "Private details were not released because the access audit could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: details }, { headers: { "Cache-Control": "private, no-store" } });
}
