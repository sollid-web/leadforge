import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { encryptPrivateData } from "@/lib/private-data";
import { normalizeListing, listingInputSchema, scoreListing } from "@/lib/opportunities";
import { storeListingContact } from "@/lib/listing-contacts";
import { getUnteraListingDetail, UnteraProviderError } from "@/lib/providers/untera";
import { claimUnteraApiRequest, unteraPersistenceBlockReason } from "@/lib/untera-access";
import { getActiveUnteraSource, getUnteraManagerContext } from "@/lib/untera-auth";

export const runtime = "nodejs";

const saveSchema = z.object({
  runId: z.string().uuid(),
  providerListingId: z.string().trim().min(1).max(200),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertyType(value: string | null): "house" | "apartment" | "land" | "commercial" | "other" {
  const normalized = value?.toLowerCase() ?? "";
  if (/land|plot/.test(normalized)) return "land";
  if (/apartment|flat|condo|duplex/.test(normalized)) return "apartment";
  if (/commercial|office|retail|industrial/.test(normalized)) return "commercial";
  if (/house|villa|home|townhouse/.test(normalized)) return "house";
  return "other";
}

function listingType(value: string | null): "sale" | "rental" | null {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["sale", "for_sale", "buy", "purchase"].includes(normalized ?? "")) return "sale";
  if (["rent", "rental", "for_rent", "to_rent", "lease"].includes(normalized ?? "")) return "rental";
  return null;
}

function hasPrivateDetails(value: Record<string, string | undefined>) {
  return Object.values(value).some((field) => Boolean(field?.trim()));
}

export async function POST(request: Request) {
  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A discovery run and Untera listing ID are required.", details: parsed.error.flatten() }, { status: 400 });
  const context = await getUnteraManagerContext();
  if ("error" in context) return NextResponse.json({ error: context.error }, { status: context.status });
  const blocked = unteraPersistenceBlockReason();
  if (blocked) return NextResponse.json({ error: blocked, code: "listing_reuse_not_authorized" }, { status: 403 });
  try {
    encryptPrivateData({ validation: true });
  } catch {
    return NextResponse.json({ error: "Owner-data encryption is not configured; cannot securely save listing details." }, { status: 503 });
  }

  const { data: run, error: runError } = await context.supabase.from("listing_collection_runs")
    .select("id,source_id,status,search_filters")
    .eq("id", parsed.data.runId)
    .eq("organization_id", context.organizationId)
    .eq("provider", "untera")
    .maybeSingle();
  if (runError) return NextResponse.json({ error: "Unable to load the discovery run." }, { status: 500 });
  if (!run || !["completed", "degraded"].includes(run.status)) return NextResponse.json({ error: "This Untera discovery run is not available for importing." }, { status: 404 });
  const sourceResult = await getActiveUnteraSource(context.supabase, context.organizationId, run.source_id);
  if (sourceResult.error || !sourceResult.source) return NextResponse.json({ error: sourceResult.error ?? "Untera source is not available." }, { status: 409 });

  const claim = await claimUnteraApiRequest(context.admin);
  if (claim.error) return NextResponse.json({ error: "Unable to apply the Untera API request limit." }, { status: 500 });
  if (!claim.allowed) {
    return NextResponse.json(
      { error: "Untera API request limit reached. Wait before loading listing details.", retryAfterSeconds: claim.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(claim.retryAfterSeconds ?? 1) } },
    );
  }

  try {
    const listing = await getUnteraListingDetail(parsed.data.providerListingId, process.env.UNTERA_API_KEY!);
    const searchFilters = isRecord(run.search_filters) && isRecord(run.search_filters.filters) ? run.search_filters.filters : {};
    const country = listing.country && /^[A-Za-z]{2}$/.test(listing.country)
      ? listing.country.toUpperCase()
      : typeof searchFilters.country === "string" ? searchFilters.country : null;
    const transaction = listingType(listing.transaction)
      ?? (searchFilters.transaction === "sale" || searchFilters.transaction === "rental" ? searchFilters.transaction : null);
    const city = listing.city;
    const area = listing.city;
    const hasOriginalPrice = listing.originalPrice !== null && Boolean(listing.originalCurrency);
    const price = hasOriginalPrice ? listing.originalPrice : listing.priceUsd;
    const currency = hasOriginalPrice ? listing.originalCurrency ?? undefined : listing.priceUsd !== null ? "USD" : undefined;
    if (!listing.title || !listing.url || !country || !city || !area || !transaction) {
      return NextResponse.json({
        error: "This provider record is missing required listing title, original URL, country, location, or transaction data and cannot be safely imported.",
        code: "incomplete_listing",
      }, { status: 422 });
    }

    const privateDetails: Record<string, string | undefined> = {
      address: listing.address ?? undefined,
      notes: listing.posterType === "UNKNOWN" && listing.contact
        ? JSON.stringify({ providerContact: listing.contact, contactType: "unclassified provider contact" })
        : undefined,
    };
    if (listing.posterType === "OWNER_UNVERIFIED" && listing.contact) {
      privateDetails.ownerName = listing.contact.name;
      privateDetails.ownerEmail = listing.contact.email;
      privateDetails.ownerPhone = listing.contact.phone;
    } else if (listing.posterType === "AGENT" && listing.contact) {
      privateDetails.listingAgentName = listing.contact.name;
      privateDetails.listingAgentEmail = listing.contact.email;
      privateDetails.listingAgentPhone = listing.contact.phone;
    }
    const input = listingInputSchema.parse({
      sourceName: sourceResult.source.name,
      sourceType: "public_api",
      sourceUrl: listing.url,
      externalId: listing.providerId,
      title: listing.title,
      description: listing.description ?? undefined,
      propertyType: propertyType(listing.propertyType),
      listingType: transaction,
      area,
      city,
      region: listing.region ?? undefined,
      countryCode: country,
      price: price !== null && price > 0 ? price : undefined,
      currency,
      ownerLedClaim: listing.posterType === "OWNER_UNVERIFIED",
      bedrooms: listing.bedrooms ?? undefined,
      bathrooms: listing.bathrooms ?? undefined,
      posterType: listing.posterType,
      posterEvidence: listing.posterEvidence ?? undefined,
      posterMethod: "source_metadata",
      publishedAt: listing.publishedAt ?? undefined,
      listingUpdatedAt: listing.updatedAt ?? undefined,
      imageUrls: listing.imageUrls,
      privateDetails: hasPrivateDetails(privateDetails) ? privateDetails : undefined,
    });
    const normalized = normalizeListing(input);
    const { data: sourceIdentity, error: sourceIdentityError } = await context.admin.from("listing_source_links")
      .select("listing_id")
      .eq("source_id", sourceResult.source.id)
      .eq("external_id", normalized.externalId)
      .maybeSingle();
    if (sourceIdentityError) return NextResponse.json({ error: "Unable to check for a previously saved Untera listing." }, { status: 500 });
    let listingId = sourceIdentity?.listing_id ?? null;
    let duplicate = Boolean(listingId);
    if (!listingId) {
      const { data: existing, error: duplicateError } = await context.admin.from("listings")
        .select("id")
        .eq("organization_id", context.organizationId)
        .eq("dedupe_key", normalized.dedupeKey)
        .maybeSingle();
      if (duplicateError) return NextResponse.json({ error: "Unable to check listing deduplication." }, { status: 500 });
      if (existing) {
        listingId = existing.id;
        duplicate = true;
      }
    }

    if (!listingId) {
      const { data: inserted, error: insertError } = await context.admin.from("listings").insert({
        organization_id: context.organizationId,
        source_id: sourceResult.source.id,
        dedupe_key: normalized.dedupeKey,
        external_id: normalized.externalId,
        title: normalized.title,
        summary: normalized.summary,
        description: normalized.description,
        property_type: normalized.propertyType,
        listing_type: normalized.listingType,
        area: normalized.area,
        city: normalized.city,
        region: normalized.region,
        country_code: normalized.countryCode,
        price: normalized.price,
        currency: normalized.currency,
        bedrooms: normalized.bedrooms,
        bathrooms: normalized.bathrooms,
        owner_led_claim: normalized.ownerLedClaim,
        poster_type: normalized.posterType,
        poster_confidence: null,
        poster_evidence: normalized.posterEvidence,
        poster_method: "source_metadata",
        image_urls: normalized.imageUrls,
        source_url: normalized.sourceUrl,
        published_at: normalized.publishedAt,
        listing_updated_at: normalized.listingUpdatedAt,
        first_seen_at: normalized.firstSeenAt,
        last_seen_at: new Date().toISOString(),
        has_public_contact: false,
        has_contact_information: false,
      }).select("id").single();
      if (insertError || !inserted) {
        if (insertError?.code === "23505") {
          const { data: concurrent, error: concurrentError } = await context.admin.from("listings")
            .select("id")
            .eq("organization_id", context.organizationId)
            .eq("dedupe_key", normalized.dedupeKey)
            .maybeSingle();
          if (concurrentError || !concurrent) return NextResponse.json({ error: "A concurrent import occurred but its listing could not be resolved." }, { status: 500 });
          listingId = concurrent.id;
          duplicate = true;
        } else {
          return NextResponse.json({ error: "Unable to save the Untera listing." }, { status: 500 });
        }
      } else {
        listingId = inserted.id;
      }
    }

    const now = new Date().toISOString();
    const [sourceLink, lastSeen] = await Promise.all([
      context.admin.from("listing_source_links").upsert({
        organization_id: context.organizationId,
        listing_id: listingId,
        source_id: sourceResult.source.id,
        external_id: normalized.externalId,
        canonical_url: normalized.sourceUrl,
        source_name: listing.sourceName ?? "Untera",
        attribution: "Untera API; applicable provider and underlying-source terms apply",
        payload_fingerprint: createHash("sha256").update(JSON.stringify({
          id: normalized.externalId,
          url: normalized.sourceUrl,
          price: normalized.price,
          updatedAt: normalized.listingUpdatedAt,
        })).digest("hex"),
        last_seen_at: now,
      }, { onConflict: "listing_id,source_id" }),
      context.admin.from("listings").update({ last_seen_at: now })
        .eq("id", listingId)
        .eq("organization_id", context.organizationId),
    ]);
    if (sourceLink.error || lastSeen.error) return NextResponse.json({ error: "Listing was saved but its source attribution or last-seen state could not be updated." }, { status: 500 });

    if (!duplicate) {
      const score = scoreListing({ ...input, firstSeenAt: new Date(normalized.firstSeenAt) });
      const [scoreWrite, snapshotWrite] = await Promise.all([
        context.admin.from("listing_scores").insert({
          organization_id: context.organizationId,
          listing_id: listingId,
          score: score.score,
          trust_score: score.trustScore,
          owner_led_score: score.ownerLedScore,
          urgency_score: score.urgencyScore,
          quality_score: score.qualityScore,
          rule_version: score.ruleVersion,
          factors: score.factors,
        }),
        context.admin.from("source_snapshots").insert({
          organization_id: context.organizationId,
          source_id: sourceResult.source.id,
          listing_id: listingId,
          external_id: normalized.externalId,
          payload_fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
          sanitized_metadata: {
            title: normalized.title,
            property_type: normalized.propertyType,
            location: normalized.area,
            country_code: normalized.countryCode,
            image_urls: normalized.imageUrls,
            source_name: listing.sourceName,
          },
        }),
      ]);
      if (scoreWrite.error || snapshotWrite.error) return NextResponse.json({ error: "Listing was saved but its score or source snapshot could not be recorded." }, { status: 500 });
      if (hasPrivateDetails(privateDetails)) {
        const encrypted = encryptPrivateData(privateDetails);
        const { error: privateWriteError } = await context.admin.from("listing_private_details").insert({
          organization_id: context.organizationId,
          listing_id: listingId,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          auth_tag: encrypted.authTag,
          key_version: encrypted.keyVersion,
        });
        if (privateWriteError) return NextResponse.json({ error: "Listing was saved but encrypted detail storage failed." }, { status: 500 });
      }
      if (listing.posterType === "OWNER_UNVERIFIED") {
        const { data: owner, error: ownerError } = await context.admin.from("owners").upsert({
          organization_id: context.organizationId,
          listing_id: listingId,
          verification_status: "unverified",
        }, { onConflict: "listing_id" }).select("id").single();
        if (ownerError || !owner) return NextResponse.json({ error: "Listing was saved but owner review state could not be initialized." }, { status: 500 });
        if (listing.contact?.email || listing.contact?.phone) {
          const encryptedContact = encryptPrivateData({ email: listing.contact.email, phone: listing.contact.phone });
          const { error: ownerContactError } = await context.admin.from("owner_contacts").insert({
            organization_id: context.organizationId,
            owner_id: owner.id,
            encrypted_payload: encryptedContact.ciphertext,
            encryption_iv: encryptedContact.iv,
            encryption_auth_tag: encryptedContact.authTag,
            key_version: encryptedContact.keyVersion,
            contact_permission: "unknown",
          });
          if (ownerContactError) return NextResponse.json({ error: "Listing was saved but encrypted owner contact storage failed." }, { status: 500 });
        }
      }
      if (listing.contact) {
        const contactType = listing.posterType === "OWNER_UNVERIFIED" ? "owner"
          : listing.posterType === "AGENT" ? "listing_agent" : "other";
        const contactWrite = await storeListingContact(context.admin, {
          organizationId: context.organizationId,
          listingId,
          sourceId: sourceResult.source.id,
          sourceUrl: listing.url,
          publicationContext: "Provider-supplied listing detail; source publication context and outreach permissions require separate review.",
          contactType,
          contact: listing.contact,
          provenance: "provider_supplied",
        });
        if (contactWrite.error) return NextResponse.json({ error: "Listing was saved but provider contact provenance could not be recorded." }, { status: 500 });
      }
    }

    const { error: runCountError } = await context.admin.rpc("record_untera_listing_save", {
      target_run: run.id,
      target_organization: context.organizationId,
      was_duplicate: duplicate,
    });
    if (runCountError) return NextResponse.json({ error: "Listing was saved but the discovery run counter could not be updated." }, { status: 500 });
    const { error: auditError } = await context.admin.from("audit_logs").insert({
      organization_id: context.organizationId,
      actor_id: context.userId,
      action: duplicate ? "listing.untera_duplicate_saved" : "listing.untera_saved",
      entity_type: "listing",
      entity_id: listingId,
      metadata: { provider: "untera", run_id: run.id, source_id: sourceResult.source.id },
    });
    if (auditError) return NextResponse.json({ error: "Listing was saved but its audit record could not be written." }, { status: 500 });

    return NextResponse.json({
      data: { id: listingId, duplicate, posterType: listing.posterType, contactAvailable: listing.contactAvailable },
      message: duplicate ? "This listing was already saved; its source attribution and last-seen time were refreshed." : "Listing saved to the organization workspace.",
    }, { status: duplicate ? 200 : 201 });
  } catch (error) {
    const message = error instanceof UnteraProviderError ? error.message : "Unable to import this Untera listing.";
    const code = error instanceof UnteraProviderError ? error.code : "import_error";
    const status = code === "not_found" ? 404 : code === "unauthorized" ? 502 : code === "rate_limited" ? 429 : 502;
    return NextResponse.json({ error: message, code }, { status });
  }
}
