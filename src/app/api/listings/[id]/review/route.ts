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
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to validate organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });

  const { data: listing, error: listingError } = await supabase.from("listings")
    .select("id,title,source_url,owner_led_claim,poster_type,poster_evidence,owners(verification_status),listing_sources(name)")
    .eq("id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (listingError) return NextResponse.json({ error: "Unable to load owner-seller candidate" }, { status: 500 });
  if (!listing) return NextResponse.json({ error: "Owner-seller candidate not found" }, { status: 404 });
  if (!listing.owner_led_claim) return NextResponse.json({ error: "This record is not classified as an owner-listed candidate" }, { status: 409 });

  const { data: encrypted, error: detailError } = await supabase.from("listing_private_details")
    .select("ciphertext,iv,auth_tag,key_version")
    .eq("listing_id", id).eq("organization_id", member.organization_id).maybeSingle();
  if (detailError) return NextResponse.json({ error: "Unable to load encrypted candidate contact" }, { status: 500 });
  if (!encrypted) return NextResponse.json({ error: "No private candidate contact was found" }, { status: 404 });
  let details: Record<string, string>;
  try {
    details = decryptPrivateData({ ciphertext: encrypted.ciphertext, iv: encrypted.iv, auth_tag: encrypted.auth_tag });
  } catch {
    return NextResponse.json({ error: "Candidate contact decryption failed; contact the workspace administrator" }, { status: 500 });
  }
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "listing.owner_candidate_contact_reviewed",
      entityType: "listing",
      entityId: id,
      metadata: { owner_verification_status: listing.owners?.[0]?.verification_status ?? "unverified" },
    });
  } catch {
    return NextResponse.json({ error: "Candidate details were not released because the access audit could not be written" }, { status: 500 });
  }
  return NextResponse.json({
    data: {
      listing: {
        id: listing.id,
        title: listing.title,
        sourceUrl: listing.source_url,
        sourceName: listing.listing_sources?.[0]?.name ?? null,
        ownerStatus: listing.owners?.[0]?.verification_status ?? "unverified",
        posterEvidence: listing.poster_evidence,
      },
      details,
      warning: "Scraped identity and role are unverified. Confirm ownership and contact identity using the cited source and independent evidence before approving this lead.",
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
