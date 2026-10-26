import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(3).max(500),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A decision and reason are required", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });

  const { data: interest, error: lookupError } = await supabase
    .from("interest_requests")
    .select("id,status")
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: "Unable to load interest request" }, { status: 500 });
  if (!interest) return NextResponse.json({ error: "Interest request not found" }, { status: 404 });
  if (interest.status !== "pending") return NextResponse.json({ error: "This interest request has already been decided" }, { status: 409 });

  const status = parsed.data.decision;
  if (status === "approved") {
    const { data: accessStatus, error: accessError } = await supabase.rpc("prepare_owner_lead_access", {
      target_interest: interest.id,
    });
    if (accessError) return NextResponse.json({ error: "Unable to prepare verified lead access" }, { status: 500 });
    if (accessStatus === "verification_required") {
      return NextResponse.json({ error: "Verify the owner-seller claim before approving access" }, { status: 409 });
    }
  }
  const { error: approvalError } = await supabase.from("approvals").upsert({
    organization_id: member.organization_id,
    interest_request_id: interest.id,
    reviewer_id: user.id,
    status,
    reason: parsed.data.reason,
    decided_at: new Date().toISOString(),
  }, { onConflict: "interest_request_id" });
  if (approvalError) return NextResponse.json({ error: "Unable to record approval decision" }, { status: 500 });
  const { data, error: updateError } = await supabase.from("interest_requests").update({
    status,
    decided_by: user.id,
    decided_at: new Date().toISOString(),
  }).eq("id", interest.id).eq("organization_id", member.organization_id).select("id,status,decided_at").single();
  if (updateError) return NextResponse.json({ error: "Approval was recorded but interest state could not be updated" }, { status: 500 });

  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: `interest.${status}`,
      entityType: "interest_request",
      entityId: interest.id,
      metadata: { decision: status, reason_recorded: true },
    });
  } catch {
    return NextResponse.json({ error: "Decision was saved but the audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data });
}
