import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { normalizeListing, listingInputSchema, scoreListing } from "@/lib/opportunities";
import { encryptPrivateData } from "@/lib/private-data";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });

  const { data, error } = await supabase
    .from("listings")
    .select("id,title,summary,property_type,area,city,region,country_code,price,currency,owner_led_claim,status,first_seen_at,created_at,source_id,owners(verification_status)")
    .eq("organization_id", member.organization_id)
    .is("suppressed_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "Unable to load opportunities" }, { status: 500 });

  const listingIds = (data ?? []).map((listing) => listing.id);
  const { data: scores, error: scoreError } = listingIds.length
    ? await supabase.from("listing_scores").select("listing_id,score,trust_score,owner_led_score,urgency_score,quality_score,factors").in("listing_id", listingIds).order("scored_at", { ascending: false })
    : { data: [], error: null };
  if (scoreError) return NextResponse.json({ error: "Unable to load opportunity scores" }, { status: 500 });
  const latestScores = new Map<string, (typeof scores)[number]>();
  for (const score of scores ?? []) if (!latestScores.has(score.listing_id)) latestScores.set(score.listing_id, score);

  return NextResponse.json({
    mode: "live",
    data: (data ?? []).map((listing) => ({ ...listing, score: latestScores.get(listing.id) ?? null })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const parsed = listingInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid opportunity payload", details: parsed.error.flatten() }, { status: 400 });

  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });

  const input = parsed.data;
  const sourceKey = input.sourceName.toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let { data: source, error: sourceError } = await supabase
    .from("listing_sources")
    .select("id,source_type,source_url,approved,active")
    .eq("organization_id", member.organization_id)
    .eq("source_key", sourceKey)
    .maybeSingle();
  if (sourceError) return NextResponse.json({ error: "Unable to validate listing source" }, { status: 500 });
  if (!source && input.sourceType === "manual") {
    const created = await supabase.from("listing_sources").insert({
      organization_id: member.organization_id,
      name: input.sourceName,
      source_key: sourceKey,
      source_type: "manual",
      approved: true,
      active: true,
      created_by: user.id,
    }).select("id,source_type,source_url,approved,active").single();
    source = created.data;
    sourceError = created.error;
  }
  if (sourceError || !source) return NextResponse.json({ error: "Listing source is not configured for this organization" }, { status: 400 });
  if (!source.active || !source.approved || source.source_type !== input.sourceType) {
    return NextResponse.json({ error: "This source must be active and approved before it can be used" }, { status: 403 });
  }
  if (input.sourceUrl && source.source_url && new URL(input.sourceUrl).hostname !== new URL(source.source_url).hostname) {
    return NextResponse.json({ error: "Listing URL host does not match the approved source" }, { status: 400 });
  }

  const normalized = normalizeListing(input);
  const privateDetailsProvided = Boolean(input.privateDetails && Object.values(input.privateDetails).some(Boolean));
  const { data: existing, error: duplicateError } = await supabase
    .from("listings")
    .select("id")
    .eq("organization_id", member.organization_id)
    .eq("dedupe_key", normalized.dedupeKey)
    .maybeSingle();
  if (duplicateError) return NextResponse.json({ error: "Unable to check for duplicate opportunities" }, { status: 500 });
  const recordDuplicate = async (listingId: string) => {
    const { error } = await supabase.from("source_health").upsert({
      organization_id: member.organization_id,
      source_id: source.id,
      status: "healthy",
      last_checked_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      consecutive_failures: 0,
      message: null,
    }, { onConflict: "source_id" });
    if (error) return NextResponse.json({ error: "Duplicate detected but source health could not be updated" }, { status: 500 });
    try {
      await writeAuditLog(supabase, {
        organizationId: member.organization_id,
        actorId: user.id,
        action: "listing.duplicate_received",
        entityType: "listing",
        entityId: listingId,
        metadata: { source_id: source.id },
      });
    } catch {
      return NextResponse.json({ error: "Duplicate detected but audit record could not be written" }, { status: 500 });
    }
    return NextResponse.json({ mode: "live", duplicate: true, data: { id: listingId } }, { status: 200 });
  };
  if (existing) return recordDuplicate(existing.id);

  const { data: listing, error: insertError } = await supabase.from("listings").insert({
    organization_id: member.organization_id,
    source_id: source.id,
    dedupe_key: normalized.dedupeKey,
    external_id: normalized.externalId,
    title: normalized.title,
    summary: normalized.summary,
    description: normalized.description,
    property_type: normalized.propertyType,
    area: normalized.area,
    city: normalized.city,
    region: normalized.region,
    country_code: normalized.countryCode,
    price: normalized.price,
    currency: normalized.currency,
    owner_led_claim: normalized.ownerLedClaim,
    source_url: normalized.sourceUrl,
    first_seen_at: normalized.firstSeenAt,
  }).select("id,title,summary,property_type,area,city,region,country_code,price,currency,owner_led_claim,status,first_seen_at,created_at,source_id").single();
  if (insertError) {
    if (insertError.code === "23505") {
      const { data: duplicate } = await supabase.from("listings").select("id").eq("organization_id", member.organization_id).eq("dedupe_key", normalized.dedupeKey).maybeSingle();
      if (duplicate) return recordDuplicate(duplicate.id);
    }
    return NextResponse.json({ error: "Unable to create opportunity" }, { status: 500 });
  }

  const score = scoreListing({ ...input, firstSeenAt: new Date(normalized.firstSeenAt) });
  const [scoreWrite, snapshotWrite, healthWrite] = await Promise.all([
    supabase.from("listing_scores").insert({
      organization_id: member.organization_id,
      listing_id: listing.id,
      score: score.score,
      trust_score: score.trustScore,
      owner_led_score: score.ownerLedScore,
      urgency_score: score.urgencyScore,
      quality_score: score.qualityScore,
      rule_version: score.ruleVersion,
      factors: score.factors,
    }),
    supabase.from("source_snapshots").insert({
      organization_id: member.organization_id,
      source_id: source.id,
      listing_id: listing.id,
      external_id: normalized.externalId,
      payload_fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
      sanitized_metadata: {
        title: normalized.title,
        property_type: normalized.propertyType,
        area: normalized.area,
        city: normalized.city,
        country_code: normalized.countryCode,
      },
    }),
    supabase.from("source_health").upsert({
      organization_id: member.organization_id,
      source_id: source.id,
      status: "healthy",
      last_checked_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      consecutive_failures: 0,
      message: null,
    }, { onConflict: "source_id" }),
  ]);
  if (scoreWrite.error || snapshotWrite.error || healthWrite.error) {
    return NextResponse.json({ error: "Opportunity was saved but processing did not complete; retry after reviewing server logs" }, { status: 500 });
  }

  if (privateDetailsProvided && input.privateDetails) {
    let encrypted: ReturnType<typeof encryptPrivateData>;
    try {
      encrypted = encryptPrivateData(input.privateDetails);
    } catch (error) {
      await supabase.from("listings").delete().eq("id", listing.id).eq("organization_id", member.organization_id);
      const message = error instanceof Error ? error.message : "Private data encryption is unavailable";
      return NextResponse.json({ error: message }, { status: 503 });
    }
    const { error } = await supabase.from("listing_private_details").insert({
      listing_id: listing.id,
      organization_id: member.organization_id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      key_version: encrypted.keyVersion,
    });
    if (error) return NextResponse.json({ error: "Unable to securely store private details" }, { status: 500 });
    const contact = {
      ownerName: input.privateDetails.ownerName,
      ownerEmail: input.privateDetails.ownerEmail,
      ownerPhone: input.privateDetails.ownerPhone,
    };
    if (contact.ownerName || contact.ownerEmail || contact.ownerPhone) {
      const { data: owner, error: ownerError } = await supabase.from("owners").insert({
        organization_id: member.organization_id,
        listing_id: listing.id,
        verification_status: "unverified",
      }).select("id").single();
      if (ownerError) return NextResponse.json({ error: "Private details stored but owner record could not be created" }, { status: 500 });
      if (contact.ownerEmail || contact.ownerPhone) {
        const encryptedContact = encryptPrivateData({ email: contact.ownerEmail, phone: contact.ownerPhone });
        const { error: contactError } = await supabase.from("owner_contacts").insert({
          organization_id: member.organization_id,
          owner_id: owner.id,
          encrypted_payload: encryptedContact.ciphertext,
          encryption_iv: encryptedContact.iv,
          encryption_auth_tag: encryptedContact.authTag,
          key_version: encryptedContact.keyVersion,
          contact_permission: "unknown",
        });
        if (contactError) return NextResponse.json({ error: "Private details stored but encrypted owner contact could not be created" }, { status: 500 });
      }
    }
  }

  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "listing.ingested",
      entityType: "listing",
      entityId: listing.id,
      metadata: { source_id: source.id, duplicate_check: "passed", private_details_stored: privateDetailsProvided },
    });
  } catch {
    return NextResponse.json({ error: "Opportunity saved, but its audit record could not be written" }, { status: 500 });
  }

  return NextResponse.json({ mode: "live", duplicate: false, data: { ...listing, score } }, { status: 201 });
}
