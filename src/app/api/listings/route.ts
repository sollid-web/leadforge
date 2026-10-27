import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { normalizeListing, listingInputSchema, scoreListing } from "@/lib/opportunities";
import { storeSubmittedContacts } from "@/lib/listing-contacts";
import { encryptPrivateData } from "@/lib/private-data";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { listingTypeSchema, posterTypeSchema } from "@/lib/providers/types";
import { z } from "zod";

const listFiltersSchema = z.object({
  countryCode: z.string().length(2).regex(/^[A-Za-z]{2}$/).optional(),
  region: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  area: z.string().trim().max(120).optional(),
  propertyType: z.enum(["house", "apartment", "land", "commercial", "other"]).optional(),
  listingType: listingTypeSchema.optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  bedrooms: z.coerce.number().int().min(0).max(100).optional(),
  publishedAfter: z.string().date().optional(),
  updatedAfter: z.string().date().optional(),
  posterType: z.array(posterTypeSchema).optional(),
  hasContact: z.enum(["true", "false"]).optional(),
  sourceId: z.string().uuid().optional(),
}).refine((filters) => filters.minPrice === undefined || filters.maxPrice === undefined || filters.minPrice <= filters.maxPrice, {
  message: "Minimum price must not exceed maximum price",
  path: ["minPrice"],
});

export async function GET(request: Request) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const filters = listFiltersSchema.safeParse({
    countryCode: params.get("countryCode") ?? undefined,
    region: params.get("region") ?? undefined,
    city: params.get("city") ?? undefined,
    area: params.get("area") ?? undefined,
    propertyType: params.get("propertyType") ?? undefined,
    listingType: params.get("listingType") ?? undefined,
    minPrice: params.get("minPrice") ?? undefined,
    maxPrice: params.get("maxPrice") ?? undefined,
    bedrooms: params.get("bedrooms") ?? undefined,
    publishedAfter: params.get("publishedAfter") ?? undefined,
    updatedAfter: params.get("updatedAfter") ?? undefined,
    posterType: params.getAll("posterType").length ? params.getAll("posterType") : undefined,
    hasContact: params.get("hasContact") ?? undefined,
    sourceId: params.get("sourceId") ?? undefined,
  });
  if (!filters.success) return NextResponse.json({ error: "Invalid listing filters", details: filters.error.flatten() }, { status: 400 });

  let query = supabase.from("listings")
    .select("id,title,summary,description,property_type,listing_type,area,city,region,country_code,price,currency,bedrooms,bathrooms,image_urls,owner_led_claim,poster_type,poster_confidence,poster_evidence,poster_method,has_public_contact,has_contact_information,published_at,listing_updated_at,last_seen_at,status,first_seen_at,created_at,source_id,owners(verification_status),listing_sources(name),listing_source_links(canonical_url,source_name,attribution,last_seen_at)")
    .eq("organization_id", member.organization_id)
    .is("suppressed_at", null);
  const values = filters.data;
  if (values.countryCode) query = query.eq("country_code", values.countryCode.toUpperCase());
  if (values.region) query = query.ilike("region", `%${values.region}%`);
  if (values.city) query = query.ilike("city", `%${values.city}%`);
  if (values.area) query = query.ilike("area", `%${values.area}%`);
  if (values.propertyType) query = query.eq("property_type", values.propertyType);
  if (values.listingType) query = query.eq("listing_type", values.listingType);
  if (values.minPrice !== undefined) query = query.gte("price", values.minPrice);
  if (values.maxPrice !== undefined) query = query.lte("price", values.maxPrice);
  if (values.bedrooms !== undefined) query = query.gte("bedrooms", values.bedrooms);
  if (values.publishedAfter) query = query.gte("published_at", values.publishedAfter);
  if (values.updatedAfter) query = query.gte("listing_updated_at", values.updatedAfter);
  if (values.posterType?.length) query = query.in("poster_type", values.posterType);
  else query = query.in("poster_type", ["OWNER_VERIFIED", "OWNER_UNVERIFIED"]);
  if (values.hasContact === "true") query = query.eq("has_public_contact", true);
  if (values.hasContact === "false") query = query.eq("has_contact_information", false);
  if (values.sourceId) query = query.eq("source_id", values.sourceId);
  const { data, error } = await query.order("last_seen_at", { ascending: false }).limit(500);
  if (error) return NextResponse.json({ error: "Unable to load opportunities" }, { status: 500 });

  const listingIds = (data ?? []).map((listing) => listing.id);
  const { data: scores, error: scoreError } = listingIds.length
    ? await supabase.from("listing_scores").select("listing_id,score,trust_score,owner_led_score,urgency_score,quality_score,factors").in("listing_id", listingIds).order("scored_at", { ascending: false })
    : { data: [], error: null };
  if (scoreError) return NextResponse.json({ error: "Unable to load opportunity scores" }, { status: 500 });
  const latestScores = new Map<string, (typeof scores)[number]>();
  for (const score of scores ?? []) if (!latestScores.has(score.listing_id)) latestScores.set(score.listing_id, score);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const countListings = () => supabase.from("listings")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", member.organization_id)
    .is("suppressed_at", null);
  const [total, ownerVerified, ownerUnverified, agents, publicContacts, missingContacts, recent, stale, duplicates, failedSources, latestRun] = await Promise.all([
    countListings(),
    countListings().eq("poster_type", "OWNER_VERIFIED"),
    countListings().eq("poster_type", "OWNER_UNVERIFIED"),
    countListings().eq("poster_type", "AGENT"),
    countListings().eq("has_public_contact", true),
    countListings().eq("has_contact_information", false),
    countListings().gte("created_at", since),
    countListings().lt("last_seen_at", staleCutoff),
    supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("organization_id", member.organization_id).eq("action", "listing.duplicate_received"),
    supabase.from("source_health").select("source_id", { count: "exact", head: true }).eq("organization_id", member.organization_id).eq("status", "failed"),
    supabase.from("listing_collection_runs").select("completed_at").eq("organization_id", member.organization_id).eq("status", "completed").order("completed_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const countError = [total, ownerVerified, ownerUnverified, agents, publicContacts, missingContacts, recent, stale, duplicates, failedSources, latestRun].find((result) => result.error);
  if (countError?.error) return NextResponse.json({ error: "Unable to load listing discovery metrics" }, { status: 500 });

  return NextResponse.json({
    mode: "live",
    data: (data ?? []).map((listing) => ({ ...listing, score: latestScores.get(listing.id) ?? null })),
    metrics: {
      totalDiscovered: total.count ?? 0,
      ownerVerified: ownerVerified.count ?? 0,
      ownerUnverified: ownerUnverified.count ?? 0,
      agentsExcludedByDefault: agents.count ?? 0,
      listingsWithPublicContacts: publicContacts.count ?? 0,
      listingsMissingContact: missingContacts.count ?? 0,
      newlyDiscoveredLast7Days: recent.count ?? 0,
      staleListings: stale.count ?? 0,
      duplicatesPrevented: duplicates.count ?? 0,
      failedSources: failedSources.count ?? 0,
      lastSuccessfulCollectionAt: latestRun.data?.completed_at ?? null,
    },
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
    .select("id,source_type,source_url,configuration,approved,active")
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
    }).select("id,source_type,source_url,configuration,approved,active").single();
    source = created.data;
    sourceError = created.error;
  }
  if (sourceError || !source) return NextResponse.json({ error: "Listing source is not configured for this organization" }, { status: 400 });
  if (!source.active || !source.approved || source.source_type !== input.sourceType) {
    return NextResponse.json({ error: "This source must be active and approved before it can be used" }, { status: 403 });
  }
  const providerConfig = source.configuration as { provider?: string } | null;
  if (input.sourceUrl && source.source_url && providerConfig?.provider !== "untera" && new URL(input.sourceUrl).hostname !== new URL(source.source_url).hostname) {
    return NextResponse.json({ error: "Listing URL host does not match the approved source" }, { status: 400 });
  }

  const normalized = normalizeListing(input);
  const privateDetailsProvided = Boolean(input.privateDetails && Object.values(input.privateDetails).some(Boolean));
  const recordSourceLink = async (listingId: string) => {
    const seenAt = new Date().toISOString();
    const { error: linkError } = await supabase.from("listing_source_links").upsert({
      organization_id: member.organization_id,
      listing_id: listingId,
      source_id: source.id,
      external_id: normalized.externalId,
      canonical_url: normalized.sourceUrl,
      source_name: input.sourceName,
      attribution: input.sourceName,
      payload_fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
      last_seen_at: seenAt,
    }, { onConflict: "listing_id,source_id" });
    if (linkError) return linkError;
    const { error: lastSeenError } = await supabase.from("listings")
      .update({ last_seen_at: seenAt })
      .eq("id", listingId)
      .eq("organization_id", member.organization_id);
    return lastSeenError;
  };
  const { data: sourceIdentity, error: sourceIdentityError } = normalized.externalId
    ? await supabase.from("listing_source_links")
      .select("listing_id")
      .eq("source_id", source.id)
      .eq("external_id", normalized.externalId)
      .maybeSingle()
    : { data: null, error: null };
  if (sourceIdentityError) return NextResponse.json({ error: "Unable to check source listing identity" }, { status: 500 });
  const { data: existing, error: duplicateError } = sourceIdentity
    ? await supabase.from("listings").select("id")
      .eq("id", sourceIdentity.listing_id)
      .eq("organization_id", member.organization_id)
      .maybeSingle()
    : await supabase
      .from("listings")
      .select("id")
      .eq("organization_id", member.organization_id)
      .eq("dedupe_key", normalized.dedupeKey)
      .maybeSingle();
  if (duplicateError) return NextResponse.json({ error: "Unable to check for duplicate opportunities" }, { status: 500 });
  const recordDuplicate = async (listingId: string) => {
    const sourceLinkError = await recordSourceLink(listingId);
    if (sourceLinkError) return NextResponse.json({ error: "Duplicate detected but source attribution could not be saved" }, { status: 500 });
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
    listing_type: normalized.listingType,
    bedrooms: normalized.bedrooms,
    bathrooms: normalized.bathrooms,
    poster_type: normalized.posterType,
    poster_confidence: normalized.posterConfidence,
    poster_evidence: normalized.posterEvidence,
    poster_method: normalized.posterMethod,
    image_urls: normalized.imageUrls,
    has_public_contact: false,
    has_contact_information: false,
    published_at: normalized.publishedAt,
    listing_updated_at: normalized.listingUpdatedAt,
    last_seen_at: new Date().toISOString(),
    source_url: normalized.sourceUrl,
    first_seen_at: normalized.firstSeenAt,
  }).select("id,title,summary,property_type,listing_type,area,city,region,country_code,price,currency,bedrooms,bathrooms,image_urls,owner_led_claim,poster_type,poster_confidence,poster_evidence,poster_method,has_public_contact,has_contact_information,published_at,listing_updated_at,last_seen_at,status,first_seen_at,created_at,source_id").single();
  if (insertError) {
    if (insertError.code === "23505") {
      const { data: duplicate } = await supabase.from("listings").select("id").eq("organization_id", member.organization_id).eq("dedupe_key", normalized.dedupeKey).maybeSingle();
      if (duplicate) return recordDuplicate(duplicate.id);
    }
    return NextResponse.json({ error: "Unable to create opportunity" }, { status: 500 });
  }

  const sourceLinkError = await recordSourceLink(listing.id);
  if (sourceLinkError) return NextResponse.json({ error: "Opportunity was saved but source attribution could not be saved" }, { status: 500 });
  if (normalized.posterType !== "UNKNOWN") {
    const { error: reviewError } = await supabase.from("listing_poster_reviews").insert({
      organization_id: member.organization_id,
      listing_id: listing.id,
      reviewer_id: user.id,
      previous_classification: "UNKNOWN",
      classification: normalized.posterType,
      verification_method: normalized.posterMethod,
      evidence_reference: normalized.posterEvidence || normalized.sourceUrl || "Manual listing submission",
    });
    if (reviewError) return NextResponse.json({ error: "Opportunity was saved but poster evidence could not be recorded" }, { status: 500 });
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
    const contacts = await storeSubmittedContacts({
      supabase,
      organizationId: member.organization_id,
      listingId: listing.id,
      sourceId: source.id,
      sourceUrl: normalized.sourceUrl,
      publicContactContext: input.publicContactContext,
      privateDetails: input.privateDetails,
    });
    if (contacts.error) return NextResponse.json({ error: "Private details stored but contact provenance could not be saved" }, { status: 500 });
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
