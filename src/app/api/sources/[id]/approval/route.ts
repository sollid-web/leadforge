import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const sourceDecisionSchema = z.object({
  approved: z.boolean(),
  active: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = sourceDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid source approval", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Owner or admin permission required" }, { status: 403 });
  if (parsed.data.approved && parsed.data.active) {
    const { data: candidate, error: candidateError } = await supabase.from("listing_sources")
      .select("source_type,source_url")
      .eq("id", id)
      .eq("organization_id", member.organization_id)
      .maybeSingle();
    if (candidateError) return NextResponse.json({ error: "Unable to validate source before approval" }, { status: 500 });
    if (!candidate) return NextResponse.json({ error: "Source not found" }, { status: 404 });
    if (candidate.source_type !== "manual" && !candidate.source_url) return NextResponse.json({ error: "External sources require an HTTPS URL before approval" }, { status: 400 });
  }
  const { data: source, error } = await supabase.from("listing_sources")
    .update({ approved: parsed.data.approved, active: parsed.data.active })
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .select("id,source_type,approved,active")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to update source approval" }, { status: 500 });
  if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: source.approved && source.active ? "source.approved" : "source.disabled",
      entityType: "listing_source",
      entityId: source.id,
      metadata: { approved: source.approved, active: source.active, reason_recorded: true },
    });
  } catch {
    return NextResponse.json({ error: "Source state was changed but audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: source });
}
