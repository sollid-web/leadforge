import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { listingBaseSchema, normalizeListing, scoreListing } from "@/lib/opportunities";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const publicFeedSchema = listingBaseSchema.omit({ privateDetails: true });

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/);
  return match?.[1] ?? null;
}

export async function POST(request: Request) {
  const token = bearerToken(request);
  if (!token) return NextResponse.json({ error: "A source-scoped Bearer token is required" }, { status: 401 });
  const parsed = publicFeedSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid public listing payload", details: parsed.error.flatten() }, { status: 400 });
  const supabase = getSupabaseAdminClient();
  if (!supabase) return NextResponse.json({ error: "Webhook ingestion is not configured on this deployment" }, { status: 503 });
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: source, error: sourceError } = await supabase.from("listing_sources")
    .select("id,organization_id,name,source_type,source_url,approved,active")
    .eq("ingestion_token_hash", tokenHash)
    .maybeSingle();
  if (sourceError) return NextResponse.json({ error: "Unable to validate ingestion source" }, { status: 500 });
  if (!source || !source.approved || !source.active) return NextResponse.json({ error: "Source token is invalid or its source is not approved and active" }, { status: 403 });
  if (source.source_type !== parsed.data.sourceType) return NextResponse.json({ error: "Payload source type does not match the approved source" }, { status: 400 });
  if (parsed.data.sourceUrl && source.source_url && new URL(parsed.data.sourceUrl).hostname !== new URL(source.source_url).hostname) {
    return NextResponse.json({ error: "Listing URL host does not match the approved source" }, { status: 400 });
  }

  const normalized = normalizeListing(parsed.data);
  const { data: sourceIdentity, error: sourceIdentityError } = normalized.externalId
    ? await supabase.from("listing_source_links")
      .select("listing_id")
      .eq("source_id", source.id)
      .eq("external_id", normalized.externalId)
      .maybeSingle()
    : { data: null, error: null };
  if (sourceIdentityError) return NextResponse.json({ error: "Unable to check source listing identity" }, { status: 500 });
  const { data: duplicate, error: duplicateError } = sourceIdentity
    ? await supabase.from("listings").select("id").eq("id", sourceIdentity.listing_id).eq("organization_id", source.organization_id).maybeSingle()
    : await supabase.from("listings")
      .select("id")
      .eq("organization_id", source.organization_id)
      .eq("dedupe_key", normalized.dedupeKey)
      .maybeSingle();
  if (duplicateError) return NextResponse.json({ error: "Unable to check for duplicate opportunities" }, { status: 500 });

  const recordSourceLink = async (listingId: string) => {
    const lastSeenAt = new Date().toISOString();
    const { error: linkError } = await supabase.from("listing_source_links").upsert({
      organization_id: source.organization_id,
      listing_id: listingId,
      source_id: source.id,
      external_id: normalized.externalId,
      canonical_url: normalized.sourceUrl,
      source_name: source.name,
      attribution: source.name,
      payload_fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
      last_seen_at: lastSeenAt,
    }, { onConflict: "listing_id,source_id" });
    if (linkError) return linkError;
    const { error: lastSeenError } = await supabase.from("listings")
      .update({ last_seen_at: lastSeenAt })
      .eq("id", listingId)
      .eq("organization_id", source.organization_id);
    return lastSeenError;
  };

  const recordDuplicate = async (listingId: string) => {
    const linkError = await recordSourceLink(listingId);
    if (linkError) return NextResponse.json({ error: "Duplicate detected but source attribution could not be saved" }, { status: 500 });
    const [healthWrite, auditWrite] = await Promise.all([
      supabase.from("source_health").upsert({
        organization_id: source.organization_id,
        source_id: source.id,
        status: "healthy",
        last_checked_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        consecutive_failures: 0,
        message: null,
      }, { onConflict: "source_id" }),
      supabase.from("audit_logs").insert({
        organization_id: source.organization_id,
        actor_id: null,
        action: "listing.duplicate_received",
        entity_type: "listing",
        entity_id: listingId,
        metadata: { source_id: source.id, transport: "authenticated_webhook" },
      }),
    ]);
    if (healthWrite.error || auditWrite.error) return NextResponse.json({ error: "Duplicate detected but health or audit records could not be updated" }, { status: 500 });
    return NextResponse.json({ duplicate: true, data: { id: listingId } }, { status: 200 });
  };
  if (duplicate) return recordDuplicate(duplicate.id);

  const { data: listing, error: listingError } = await supabase.from("listings").insert({
    organization_id: source.organization_id,
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
    listing_type: normalized.listingType,
    bedrooms: normalized.bedrooms,
    bathrooms: normalized.bathrooms,
    poster_type: normalized.posterType,
    poster_confidence: normalized.posterConfidence,
    poster_evidence: normalized.posterEvidence,
    poster_method: normalized.posterMethod,
    has_public_contact: false,
    has_contact_information: false,
    source_url: normalized.sourceUrl,
    published_at: normalized.publishedAt,
    listing_updated_at: normalized.listingUpdatedAt,
    first_seen_at: normalized.firstSeenAt,
    last_seen_at: new Date().toISOString(),
  }).select("id,title,summary").single();
  if (listingError) {
    if (listingError.code === "23505") {
      const { data: duplicate } = await supabase.from("listings").select("id").eq("organization_id", source.organization_id).eq("dedupe_key", normalized.dedupeKey).maybeSingle();
      if (duplicate) return recordDuplicate(duplicate.id);
    }
    return NextResponse.json({ error: "Unable to persist ingested opportunity" }, { status: 500 });
  }

  const sourceLinkError = await recordSourceLink(listing.id);
  if (sourceLinkError) return NextResponse.json({ error: "Listing saved but source attribution could not be saved" }, { status: 500 });
  const score = scoreListing({ ...parsed.data, firstSeenAt: new Date(normalized.firstSeenAt) });
  const writes = await Promise.all([
    supabase.from("listing_scores").insert({
      organization_id: source.organization_id,
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
      organization_id: source.organization_id,
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
      organization_id: source.organization_id,
      source_id: source.id,
      status: "healthy",
      last_checked_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      consecutive_failures: 0,
      message: null,
    }, { onConflict: "source_id" }),
    supabase.from("audit_logs").insert({
      organization_id: source.organization_id,
      actor_id: null,
      action: "listing.ingested_by_source",
      entity_type: "listing",
      entity_id: listing.id,
      metadata: { source_id: source.id, transport: "authenticated_webhook", private_details_received: false },
    }),
  ]);
  const failedWrite = writes.find((write) => write.error);
  if (failedWrite?.error) return NextResponse.json({ error: "Listing saved but scoring, source health, snapshot, or audit processing failed" }, { status: 500 });
  return NextResponse.json({ duplicate: false, data: { ...listing, score } }, { status: 201 });
}
