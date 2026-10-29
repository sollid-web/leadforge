import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsvRecords } from "@/lib/listing-csv";
import { storeSubmittedContacts } from "@/lib/listing-contacts";
import { listingInputSchema, normalizeListing, scoreListing } from "@/lib/opportunities";
import { encryptPrivateData } from "@/lib/private-data";
import { mapScraperCsvRow, type ScraperImportSource } from "@/lib/scraper-csv";

type Source = ScraperImportSource & {
  id: string;
  source_key: string;
};

type ManifestIngestionInput = {
  admin: SupabaseClient;
  organizationId: string;
  runId: string;
  source: Source;
  expectedCity: string;
  expectedCountryCode: string;
  maxRows: number;
  csvText: string;
};

export type ManifestIngestionResult = {
  discovered: number;
  imported: number;
  duplicates: number;
  rejected: number;
  held: number;
  contactsFound: number;
  rejectionReasons: Record<string, number>;
  digest: string;
};

function addReason(reasons: Record<string, number>, reason: string) {
  const key = reason.slice(0, 160);
  reasons[key] = (reasons[key] ?? 0) + 1;
}

async function recordSourceLink(
  admin: SupabaseClient,
  organizationId: string,
  source: Source,
  listingId: string,
  normalized: ReturnType<typeof normalizeListing>,
  payloadFingerprint: string,
) {
  const seenAt = new Date().toISOString();
  const { error: linkError } = await admin.from("listing_source_links").upsert({
    organization_id: organizationId,
    listing_id: listingId,
    source_id: source.id,
    external_id: normalized.externalId,
    canonical_url: normalized.sourceUrl,
    source_name: source.name,
    attribution: source.name,
    payload_fingerprint: payloadFingerprint,
    last_seen_at: seenAt,
  }, { onConflict: "listing_id,source_id" });
  if (linkError) throw new Error("Unable to persist source attribution");
  const { error: seenError } = await admin.from("listings").update({ last_seen_at: seenAt })
    .eq("id", listingId).eq("organization_id", organizationId);
  if (seenError) throw new Error("Unable to refresh listing observation time");
}

export async function ingestScraperManifest(input: ManifestIngestionInput): Promise<ManifestIngestionResult> {
  const records = parseCsvRecords(input.csvText, { allowHeaderOnly: true });
  if (records.length > input.maxRows) throw new Error("Worker manifest contains more rows than the authorized result limit.");
  const digest = createHash("sha256").update(input.csvText, "utf8").digest("hex");
  const result: ManifestIngestionResult = {
    discovered: records.length,
    imported: 0,
    duplicates: 0,
    rejected: 0,
    held: 0,
    contactsFound: 0,
    rejectionReasons: {},
    digest,
  };

  for (const record of records) {
    const mapped = mapScraperCsvRow(record, [input.source]);
    if (!mapped.payload) {
      result.rejected += 1;
      for (const reason of mapped.errors.length ? mapped.errors : ["Scraper row was not valid."]) addReason(result.rejectionReasons, reason);
      continue;
    }
    const candidate = mapped.payload;
    if (candidate.posterDecision === "reject_agent") {
      result.rejected += 1;
      addReason(result.rejectionReasons, candidate.posterDecisionReason || "Explicit agent/broker evidence rejected by source classifier.");
      continue;
    }
    if (candidate.posterDecision === "hold_ambiguous") {
      const externalId = candidate.externalId || createHash("sha256").update(candidate.sourceUrl).digest("hex");
      const holdFingerprint = createHash("sha256").update(JSON.stringify({
        externalId,
        title: candidate.title,
        city: candidate.city,
        sourceUrl: candidate.sourceUrl,
        reason: candidate.posterDecisionReason,
        evidence: candidate.posterEvidence,
      })).digest("hex");
      const { error: holdError } = await input.admin.from("scraper_candidate_holds").upsert({
        organization_id: input.organizationId,
        source_id: input.source.id,
        run_id: input.runId,
        external_id: externalId,
        title: candidate.title,
        listing_url: candidate.sourceUrl,
        city: candidate.city,
        country_code: candidate.countryCode,
        reason_code: candidate.posterDecisionReason || "ambiguous_poster",
        evidence_codes: (candidate.posterEvidence || "source_or_poster_signal_missing").split(";").filter(Boolean),
        payload_fingerprint: holdFingerprint,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: "run_id,source_id,external_id" });
      if (holdError) throw new Error("Unable to persist ambiguous owner-candidate hold");
      result.held += 1;
      continue;
    }
    if (!candidate.ownerLedClaim || candidate.posterType !== "OWNER_UNVERIFIED") {
      result.rejected += 1;
      addReason(result.rejectionReasons, "Record did not carry an owner-listed signal; automated intake accepts owner-unverified candidates only.");
      continue;
    }
    if (candidate.listingType !== "sale") {
      result.rejected += 1;
      addReason(result.rejectionReasons, "Non-sale record excluded from owner-seller lead intake.");
      continue;
    }
    if (!candidate.privateDetails?.ownerEmail && !candidate.privateDetails?.ownerPhone) {
      result.rejected += 1;
      addReason(result.rejectionReasons, "Owner contact candidate is missing an email and phone number.");
      continue;
    }
    if (candidate.city.trim().toLocaleLowerCase("en") !== input.expectedCity.trim().toLocaleLowerCase("en")
      || candidate.countryCode.toUpperCase() !== input.expectedCountryCode.toUpperCase()) {
      result.rejected += 1;
      addReason(result.rejectionReasons, "Record location did not match the authorized city and country scope.");
      continue;
    }

    const parsed = listingInputSchema.safeParse(candidate);
    if (!parsed.success) {
      result.rejected += 1;
      addReason(result.rejectionReasons, "Mapped lead failed LeadForge validation.");
      continue;
    }
    const value = parsed.data;
    const normalized = normalizeListing(value);
    const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const { data: existing, error: duplicateError } = await input.admin.from("listings")
      .select("id").eq("organization_id", input.organizationId).eq("dedupe_key", normalized.dedupeKey).maybeSingle();
    if (duplicateError) throw new Error("Unable to check existing lead identity");

    if (existing) {
      await recordSourceLink(input.admin, input.organizationId, input.source, existing.id, normalized, fingerprint);
      result.duplicates += 1;
      if (mapped.hasContact) result.contactsFound += 1;
      continue;
    }

    const now = new Date().toISOString();
    const { data: listing, error: listingError } = await input.admin.from("listings").insert({
      organization_id: input.organizationId,
      source_id: input.source.id,
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
      owner_led_claim: true,
      poster_type: "OWNER_UNVERIFIED",
      poster_confidence: 25,
      poster_evidence: normalized.posterEvidence || "Source supplied an owner-listed signal; human verification is still required.",
      poster_method: "source_metadata",
      image_urls: normalized.imageUrls,
      has_public_contact: false,
      has_contact_information: Boolean(value.privateDetails?.ownerEmail || value.privateDetails?.ownerPhone),
      published_at: normalized.publishedAt,
      listing_updated_at: normalized.listingUpdatedAt,
      last_seen_at: now,
      source_url: normalized.sourceUrl,
      first_seen_at: normalized.firstSeenAt,
    }).select("id").single();

    if (listingError || !listing) {
      if (listingError?.code === "23505") {
        const { data: racedDuplicate, error: racedError } = await input.admin.from("listings")
          .select("id").eq("organization_id", input.organizationId).eq("dedupe_key", normalized.dedupeKey).maybeSingle();
        if (racedError || !racedDuplicate) throw new Error("Lead deduplication encountered a database conflict");
        await recordSourceLink(input.admin, input.organizationId, input.source, racedDuplicate.id, normalized, fingerprint);
        result.duplicates += 1;
        if (mapped.hasContact) result.contactsFound += 1;
        continue;
      }
      throw new Error("Unable to save a discovered lead");
    }

    const [linkWrite, scoreWrite, snapshotWrite, posterEvidenceWrite] = await Promise.all([
      input.admin.from("listing_source_links").upsert({
        organization_id: input.organizationId,
        listing_id: listing.id,
        source_id: input.source.id,
        external_id: normalized.externalId,
        canonical_url: normalized.sourceUrl,
        source_name: input.source.name,
        attribution: input.source.name,
        payload_fingerprint: fingerprint,
        last_seen_at: now,
      }, { onConflict: "listing_id,source_id" }),
      input.admin.from("listing_scores").insert((() => {
        const score = scoreListing({ ...value, firstSeenAt: new Date(normalized.firstSeenAt) });
        return {
          organization_id: input.organizationId,
          listing_id: listing.id,
          score: score.score,
          trust_score: score.trustScore,
          owner_led_score: score.ownerLedScore,
          urgency_score: score.urgencyScore,
          quality_score: score.qualityScore,
          rule_version: score.ruleVersion,
          factors: score.factors,
        };
      })()),
      input.admin.from("source_snapshots").insert({
        organization_id: input.organizationId,
        source_id: input.source.id,
        listing_id: listing.id,
        external_id: normalized.externalId,
        payload_fingerprint: fingerprint,
        sanitized_metadata: {
          title: normalized.title,
          property_type: normalized.propertyType,
          area: normalized.area,
          city: normalized.city,
          country_code: normalized.countryCode,
        },
      }),
      input.admin.from("listing_poster_reviews").insert({
        organization_id: input.organizationId,
        listing_id: listing.id,
        reviewer_id: null,
        previous_classification: "UNKNOWN",
        classification: "OWNER_UNVERIFIED",
        verification_method: "source_metadata",
        evidence_reference: normalized.posterEvidence || normalized.sourceUrl || "Scraper source record",
        notes: "Automated source classification only; ownership is not verified and this lead is not agent-sale eligible.",
      }),
    ]);
    if (linkWrite.error || scoreWrite.error || snapshotWrite.error || posterEvidenceWrite.error) {
      throw new Error("Lead was saved but required attribution or scoring records could not be completed");
    }

    const privateDetails = value.privateDetails ?? {};
    if (Object.values(privateDetails).some(Boolean)) {
      const encrypted = encryptPrivateData(privateDetails);
      const { error: privateWriteError } = await input.admin.from("listing_private_details").upsert({
        listing_id: listing.id,
        organization_id: input.organizationId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        key_version: encrypted.keyVersion,
      }, { onConflict: "listing_id" });
      if (privateWriteError) throw new Error("Unable to encrypt and persist listing contact details");

      const { data: owner, error: ownerError } = await input.admin.from("owners").insert({
        organization_id: input.organizationId,
        listing_id: listing.id,
        verification_status: "unverified",
      }).select("id").single();
      if (ownerError || !owner) throw new Error("Unable to create unverified owner candidate record");
      const encryptedOwnerContact = encryptPrivateData({
        email: privateDetails.ownerEmail,
        phone: privateDetails.ownerPhone,
        name: privateDetails.ownerName,
      });
      const { error: ownerContactError } = await input.admin.from("owner_contacts").insert({
        organization_id: input.organizationId,
        owner_id: owner.id,
        encrypted_payload: encryptedOwnerContact.ciphertext,
        encryption_iv: encryptedOwnerContact.iv,
        encryption_auth_tag: encryptedOwnerContact.authTag,
        key_version: encryptedOwnerContact.keyVersion,
        contact_permission: "unknown",
      });
      if (ownerContactError) throw new Error("Unable to persist encrypted unverified owner contact");
      const contacts = await storeSubmittedContacts({
        supabase: input.admin,
        organizationId: input.organizationId,
        listingId: listing.id,
        sourceId: input.source.id,
        sourceUrl: normalized.sourceUrl,
        publicContactContext: value.publicContactContext,
        privateDetails,
      });
      if (contacts.error) throw new Error("Unable to persist encrypted contact provenance");
      result.contactsFound += 1;
    }
    const { error: sourceHealthError } = await input.admin.from("source_health").upsert({
      organization_id: input.organizationId,
      source_id: input.source.id,
      status: "healthy",
      last_checked_at: now,
      last_success_at: now,
      consecutive_failures: 0,
      message: null,
    }, { onConflict: "source_id" });
    if (sourceHealthError) throw new Error("Unable to update source health after successful ingestion");
    result.imported += 1;
  }

  return result;
}
