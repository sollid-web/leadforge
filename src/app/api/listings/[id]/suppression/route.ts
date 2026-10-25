import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const suppressionSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  ownerOptOut: z.boolean().default(false),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = suppressionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A suppression reason is required", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });
  const { data: listing, error } = await supabase.from("listings").update({
    status: "suppressed",
    suppressed_at: new Date().toISOString(),
  }).eq("id", id).eq("organization_id", member.organization_id).select("id").maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to suppress opportunity" }, { status: 500 });
  if (!listing) return NextResponse.json({ error: "Opportunity not found" }, { status: 404 });

  const [{ data: matches, error: matchesError }, { data: owners, error: ownersError }] = await Promise.all([
    supabase.from("matches").update({ status: "dismissed" }).eq("listing_id", listing.id).eq("organization_id", member.organization_id).select("id"),
    supabase.from("owners").select("id").eq("listing_id", listing.id).eq("organization_id", member.organization_id),
  ]);
  if (matchesError || ownersError) return NextResponse.json({ error: "Opportunity suppressed but related records could not be fully updated" }, { status: 500 });
  const matchIds = (matches ?? []).map((match) => match.id);
  const { data: interests, error: interestsError } = matchIds.length
    ? await supabase.from("interest_requests").select("id").in("match_id", matchIds).eq("organization_id", member.organization_id)
    : { data: [], error: null };
  if (interestsError) return NextResponse.json({ error: "Opportunity suppressed but interest requests could not be loaded" }, { status: 500 });
  const interestIds = (interests ?? []).map((interest) => interest.id);
  if (interestIds.length) {
    const [{ error: approvalError }, { error: interestUpdateError }] = await Promise.all([
      supabase.from("approvals").update({ status: "revoked", reason: `Listing suppressed: ${parsed.data.reason}`, decided_at: new Date().toISOString() })
        .in("interest_request_id", interestIds)
        .eq("organization_id", member.organization_id)
        .eq("status", "approved"),
      supabase.from("interest_requests").update({ status: "withdrawn", decided_at: new Date().toISOString(), decided_by: user.id })
        .in("id", interestIds)
        .eq("organization_id", member.organization_id)
        .eq("status", "pending"),
    ]);
    if (approvalError || interestUpdateError) return NextResponse.json({ error: "Opportunity suppressed but related approval state could not be fully updated" }, { status: 500 });
  }
  const ownerIds = (owners ?? []).map((owner) => owner.id);
  if (ownerIds.length) {
    const { error: contactsError } = await supabase.from("owner_contacts").update({
      ...(parsed.data.ownerOptOut ? { contact_permission: "opted_out", opted_out_at: new Date().toISOString() } : {}),
    }).in("owner_id", ownerIds).eq("organization_id", member.organization_id);
    if (contactsError) return NextResponse.json({ error: "Opportunity suppressed but contact permission could not be updated" }, { status: 500 });
  }
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: parsed.data.ownerOptOut ? "listing.suppressed_owner_opt_out" : "listing.suppressed",
      entityType: "listing",
      entityId: listing.id,
      metadata: { reason_recorded: true, owner_opt_out: parsed.data.ownerOptOut },
    });
  } catch {
    return NextResponse.json({ error: "Opportunity was suppressed but audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { id: listing.id, status: "suppressed" } });
}
