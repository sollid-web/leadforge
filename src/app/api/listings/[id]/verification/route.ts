import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const verificationSchema = z.object({
  status: z.enum(["verified", "rejected"]),
  evidenceReference: z.string().trim().min(3).max(500),
  reason: z.string().trim().min(3).max(500),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = verificationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Verification decision, evidence reference, and reason are required", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });
  const { data: listing, error: listingError } = await supabase.from("listings")
    .select("id,owner_led_claim")
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (listingError) return NextResponse.json({ error: "Unable to load opportunity" }, { status: 500 });
  if (!listing) return NextResponse.json({ error: "Opportunity not found" }, { status: 404 });
  if (!listing.owner_led_claim && parsed.data.status === "verified") {
    return NextResponse.json({ error: "The source does not claim owner-listed status" }, { status: 409 });
  }

  const { error: ownerError } = await supabase.from("owners").upsert({
    organization_id: member.organization_id,
    listing_id: listing.id,
    verification_status: parsed.data.status,
  }, { onConflict: "listing_id" });
  if (ownerError) return NextResponse.json({ error: "Unable to save owner verification state" }, { status: 500 });
  const { error: verificationError } = await supabase.from("listing_verifications").insert({
    organization_id: member.organization_id,
    listing_id: listing.id,
    reviewer_id: user.id,
    status: parsed.data.status,
    evidence_reference: parsed.data.evidenceReference,
    notes: parsed.data.reason,
    reviewed_at: new Date().toISOString(),
  });
  if (verificationError) return NextResponse.json({ error: "Verification state changed but its review record could not be saved" }, { status: 500 });
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: `listing.owner_${parsed.data.status}`,
      entityType: "listing",
      entityId: listing.id,
      metadata: { evidence_recorded: true, reason_recorded: true },
    });
  } catch {
    return NextResponse.json({ error: "Verification decision saved but its audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { listingId: listing.id, status: parsed.data.status } });
}
