import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const interestSchema = z.object({ message: z.string().trim().max(500).optional() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = interestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid interest request", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });

  const { data: agent, error: agentError } = await supabase.from("agents").select("id").eq("organization_id", member.organization_id).eq("user_id", user.id).eq("active", true).maybeSingle();
  if (agentError) return NextResponse.json({ error: "Unable to load agent profile" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "An active agent profile is required to request details" }, { status: 403 });
  const { data: match, error: matchError } = await supabase.from("matches").select("id,listing_id").eq("id", id).eq("agent_id", agent.id).eq("organization_id", member.organization_id).maybeSingle();
  if (matchError) return NextResponse.json({ error: "Unable to validate opportunity match" }, { status: 500 });
  if (!match) return NextResponse.json({ error: "Opportunity match not found" }, { status: 404 });
  const { data: existing, error: existingError } = await supabase.from("interest_requests").select("id,status").eq("match_id", match.id).maybeSingle();
  if (existingError) return NextResponse.json({ error: "Unable to check previous interest" }, { status: 500 });
  if (existing) return NextResponse.json({ error: "An interest request already exists for this match", data: existing }, { status: 409 });

  const { data, error } = await supabase.from("interest_requests").insert({
    organization_id: member.organization_id,
    match_id: match.id,
    agent_id: agent.id,
    message: parsed.data.message ?? null,
  }).select("id,status,requested_at").single();
  if (error) return NextResponse.json({ error: "Unable to submit interest request" }, { status: 500 });
  const { error: matchUpdateError } = await supabase.from("matches").update({ status: "interested" }).eq("id", match.id);
  if (matchUpdateError) return NextResponse.json({ error: "Interest was recorded but match status could not be updated" }, { status: 500 });
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "listing.interest_requested",
      entityType: "interest_request",
      entityId: data.id,
      metadata: { listing_id: match.listing_id },
    });
  } catch {
    return NextResponse.json({ error: "Interest was recorded but the audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data }, { status: 201 });
}
