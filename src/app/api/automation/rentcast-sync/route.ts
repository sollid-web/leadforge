import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { rentCastConfigurationSchema, rentCastProvider } from "@/lib/providers/rentcast";
import type { RentCastListing } from "@/lib/providers/rentcast";
import { normalizeListing, scoreListing } from "@/lib/opportunities";
import { saveAgentMatches } from "@/lib/matching";
import { decryptPrivateData, encryptPrivateData } from "@/lib/private-data";
import { storeListingContact } from "@/lib/listing-contacts";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const MAX_SOURCES_PER_RUN = 25;
const MAX_PROVIDER_REQUESTS_PER_RUN = 1;

function isAuthorized(request: Request, secret: string) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function propertyType(value?: string): "house" | "apartment" | "land" | "commercial" | "other" {
  const normalized = value?.toLocaleLowerCase("en") ?? "";
  if (normalized.includes("land")) return "land";
  if (["apartment", "condo", "multi", "duplex"].some((term) => normalized.includes(term))) return "apartment";
  if (["commercial", "office", "retail", "industrial"].some((term) => normalized.includes(term))) return "commercial";
  if (["house", "single", "town", "manufactured", "family"].some((term) => normalized.includes(term))) return "house";
  return "other";
}

function optionalListingDate(value?: string) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function contactDetails(listing: RentCastListing) {
  const validEmail = (value?: string) => value && z.string().email().safeParse(value).success ? value : undefined;
  return {
    address: listing.formattedAddress,
    listingAgentName: listing.listingAgent?.name,
    listingAgentEmail: validEmail(listing.listingAgent?.email),
    listingAgentPhone: listing.listingAgent?.phone,
    listingOfficeName: listing.listingOffice?.name,
    listingOfficeEmail: validEmail(listing.listingOffice?.email),
    listingOfficePhone: listing.listingOffice?.phone,
  };
}

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "RentCast sync is not configured: CRON_SECRET is missing" }, { status: 503 });
  if (!isAuthorized(request, cronSecret)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const apiKey = process.env.RENTCAST_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "RentCast sync is not configured: RENTCAST_API_KEY is missing" }, { status: 503 });
  const supabase = getSupabaseAdminClient();
  if (!supabase) return NextResponse.json({ error: "Supabase service role is not configured" }, { status: 503 });

  try {
    encryptPrivateData({ validation: true });
  } catch {
    return NextResponse.json({ error: "Private-detail encryption is not configured" }, { status: 503 });
  }

  const { data: sources, error: sourceError } = await supabase.from("listing_sources")
    .select("id,organization_id,name,configuration")
    .eq("source_type", "public_api")
    .eq("approved", true)
    .eq("active", true)
    .contains("configuration", { provider: "rentcast" })
    .order("created_at", { ascending: true })
    .limit(MAX_SOURCES_PER_RUN + 1);
  if (sourceError) return NextResponse.json({ error: "Unable to load approved RentCast sources" }, { status: 500 });
  if ((sources ?? []).length > MAX_SOURCES_PER_RUN) {
    return NextResponse.json({ error: `Too many approved RentCast sources for one run; maximum is ${MAX_SOURCES_PER_RUN}` }, { status: 413 });
  }

  const sourceIds = (sources ?? []).map((source) => source.id);
  const { data: healthRows, error: healthError } = sourceIds.length
    ? await supabase.from("source_health").select("source_id,last_sync_attempt_at").in("source_id", sourceIds)
    : { data: [], error: null };
  if (healthError) return NextResponse.json({ error: "Unable to load RentCast sync history" }, { status: 500 });
  const lastAttemptBySource = new Map((healthRows ?? []).map((row) => [row.source_id, row.last_sync_attempt_at]));
  const orderedSources = [...(sources ?? [])].sort((a, b) => {
    const timestamp = (id: string) => {
      const value = lastAttemptBySource.get(id);
      const parsed = value ? Date.parse(value) : 0;
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return timestamp(a.id) - timestamp(b.id);
  });

  const results: Array<{ sourceId: string; status: string; imported?: number; duplicates?: number; matched?: number; rejected?: number; message?: string }> = [];
  let providerRequests = 0;
  for (const source of orderedSources) {
    if (providerRequests >= MAX_PROVIDER_REQUESTS_PER_RUN) {
      results.push({ sourceId: source.id, status: "deferred", message: "The per-run RentCast request limit has been reached" });
      continue;
    }
    const parsedConfig = rentCastConfigurationSchema.safeParse(source.configuration);
    if (!parsedConfig.success) {
      results.push({ sourceId: source.id, status: "failed", message: "Source search configuration is invalid" });
      continue;
    }

    const attemptedAt = new Date();
    const { data: claimed, error: claimError } = await supabase.rpc("claim_rentcast_source_sync", {
      target_source: source.id,
      target_organization: source.organization_id,
      attempted_at: attemptedAt.toISOString(),
    });
    if (claimError) return NextResponse.json({ error: "Unable to claim a source sync window" }, { status: 500 });
    if (!claimed) {
      results.push({ sourceId: source.id, status: "skipped", message: "This source was synced within the last 24 hours" });
      continue;
    }
    providerRequests += 1;
    const runInsert = await supabase.from("listing_collection_runs").insert({
      organization_id: source.organization_id,
      source_id: source.id,
      provider: rentCastProvider.id,
      status: "running",
    }).select("id").single();
    if (runInsert.error || !runInsert.data) {
      results.push({ sourceId: source.id, status: "failed", message: "Unable to create a collection run record" });
      continue;
    }
    const runId = runInsert.data.id;

    try {
      const config = rentCastProvider.parseConfiguration(source.configuration);
      const searchResult = await rentCastProvider.search(config, apiKey);
      const validListings = searchResult.listings;
      const rejected = searchResult.rejected;

      const [{ data: profiles, error: profilesError }, { data: agents, error: agentsError }] = await Promise.all([
        supabase.from("agent_profiles")
          .select("agent_id,display_name,service_areas,specialties,currency,min_budget,max_budget")
          .eq("organization_id", source.organization_id),
        supabase.from("agents").select("id,active").eq("organization_id", source.organization_id).eq("active", true),
      ]);
      if (profilesError || agentsError) throw new Error("Unable to load agent matching profiles");
      const activeAgentIds = new Set((agents ?? []).map((agent) => agent.id));
      let imported = 0;
      let duplicates = 0;
      let matched = 0;
      let contactsFound = 0;

      for (const item of validListings) {
        const city = item.city.replace(/\s+/g, " ").trim();
        const region = item.state?.replace(/\s+/g, " ").trim() || config.state || null;
        const title = `${propertyType(item.propertyType).replace(/^\w/, (letter) => letter.toUpperCase())} ${config.listingType} listing`;
        const input = {
          sourceName: source.name,
          sourceType: "public_api" as const,
          externalId: item.id,
          title: `${title} in ${city}`,
          propertyType: propertyType(item.propertyType),
          area: item.zipCode || city,
          city,
          region: region ?? undefined,
          countryCode: "US",
          price: item.price,
          currency: "USD",
          ownerLedClaim: false,
          listingType: config.listingType,
          bedrooms: item.bedrooms,
          bathrooms: item.bathrooms,
          posterType: "UNKNOWN" as const,
          posterEvidence: "RentCast provides listing-agent/office contact fields, which do not establish the identity of the property poster.",
          posterMethod: "source_metadata" as const,
          firstSeenAt: optionalListingDate(item.listingDate),
          publishedAt: optionalListingDate(item.listingDate),
          privateDetails: contactDetails(item),
        };
        const normalized = normalizeListing(input);
        const { data: sourceListing, error: sourceListingError } = await supabase.from("listings")
          .select("id,source_id")
          .eq("organization_id", source.organization_id)
          .eq("source_id", source.id)
          .eq("external_id", item.id)
          .limit(1)
          .maybeSingle();
        if (sourceListingError) throw new Error("Unable to check source listing identity");
        const { data: duplicateByKey, error: duplicateError } = sourceListing
          ? { data: null, error: null }
          : await supabase.from("listings")
            .select("id,source_id")
          .eq("organization_id", source.organization_id)
          .eq("dedupe_key", normalized.dedupeKey)
          .maybeSingle();
        if (duplicateError) throw new Error("Unable to check for duplicate listings");
        const existing = sourceListing ?? duplicateByKey;
        const isSameSourceListing = existing?.source_id === source.id;

        let listingId: string;
        if (existing) {
          listingId = existing.id;
          duplicates += 1;
          if (isSameSourceListing) {
            const { error: listingUpdateError } = await supabase.from("listings").update({
              title: normalized.title,
              summary: normalized.summary,
              property_type: normalized.propertyType,
              area: normalized.area,
              city: normalized.city,
              region: normalized.region,
              price: normalized.price,
              currency: normalized.currency,
              listing_type: normalized.listingType,
              bedrooms: normalized.bedrooms,
              bathrooms: normalized.bathrooms,
              poster_type: normalized.posterType,
              poster_evidence: normalized.posterEvidence,
              published_at: normalized.firstSeenAt,
              listing_updated_at: new Date().toISOString(),
              last_seen_at: new Date().toISOString(),
              first_seen_at: normalized.firstSeenAt,
            }).eq("id", listingId).eq("organization_id", source.organization_id);
            if (listingUpdateError) throw new Error("Unable to refresh listing information");
          }
          const { data: privateRow, error: privateQueryError } = await supabase.from("listing_private_details")
            .select("listing_id,ciphertext,iv,auth_tag")
            .eq("listing_id", listingId)
            .maybeSingle();
          if (privateQueryError) throw new Error("Unable to check encrypted listing details");
          if (!privateRow || isSameSourceListing) {
            const incomingDetails = Object.fromEntries(Object.entries(input.privateDetails)
              .filter(([, value]) => typeof value === "string" && value.trim().length > 0));
            const details = privateRow && isSameSourceListing
              ? { ...decryptPrivateData(privateRow), ...incomingDetails }
              : input.privateDetails;
            const encrypted = encryptPrivateData(details);
            const privateQuery = privateRow
              ? supabase.from("listing_private_details").update({
                ciphertext: encrypted.ciphertext,
                iv: encrypted.iv,
                auth_tag: encrypted.authTag,
                key_version: encrypted.keyVersion,
              }).eq("listing_id", listingId).eq("organization_id", source.organization_id)
              : supabase.from("listing_private_details").insert({
              listing_id: listingId,
              organization_id: source.organization_id,
              ciphertext: encrypted.ciphertext,
              iv: encrypted.iv,
              auth_tag: encrypted.authTag,
              key_version: encrypted.keyVersion,
            });
            const { error } = await privateQuery;
            if (error) throw new Error("Unable to store encrypted listing details");
          }
        } else {
          const { data: listing, error: listingError } = await supabase.from("listings").insert({
            organization_id: source.organization_id,
            source_id: source.id,
            dedupe_key: normalized.dedupeKey,
            external_id: normalized.externalId,
            title: normalized.title,
            summary: normalized.summary,
            property_type: normalized.propertyType,
            area: normalized.area,
            city: normalized.city,
            region: normalized.region,
            country_code: normalized.countryCode,
            price: normalized.price,
            currency: normalized.currency,
            owner_led_claim: false,
            listing_type: normalized.listingType,
            bedrooms: normalized.bedrooms,
            bathrooms: normalized.bathrooms,
            poster_type: normalized.posterType,
            poster_evidence: normalized.posterEvidence,
            poster_method: "provider_metadata",
            poster_confidence: null,
            published_at: normalized.firstSeenAt,
            listing_updated_at: null,
            first_seen_at: normalized.firstSeenAt,
            last_seen_at: new Date().toISOString(),
            has_public_contact: false,
            has_contact_information: false,
          }).select("id").single();
          if (listingError || !listing) {
            if (listingError?.code === "23505") {
              const { data: concurrentListing, error: concurrentQueryError } = await supabase.from("listings")
                .select("id")
                .eq("organization_id", source.organization_id)
                .eq("dedupe_key", normalized.dedupeKey)
                .maybeSingle();
              if (concurrentQueryError || !concurrentListing) throw new Error("Unable to resolve a concurrent duplicate listing");
              listingId = concurrentListing.id;
              duplicates += 1;
            } else {
              throw new Error("Unable to store normalized listing");
            }
          } else {
            listingId = listing.id;
            imported += 1;
            const encrypted = encryptPrivateData(input.privateDetails);
            const { error: privateWriteError } = await supabase.from("listing_private_details").insert({
              listing_id: listingId,
              organization_id: source.organization_id,
              ciphertext: encrypted.ciphertext,
              iv: encrypted.iv,
              auth_tag: encrypted.authTag,
              key_version: encrypted.keyVersion,
            });
            if (privateWriteError) throw new Error("Listing saved but encrypted detail processing failed");
          }
        }

        const linkAt = new Date().toISOString();
        const { error: sourceLinkError } = await supabase.from("listing_source_links").upsert({
          organization_id: source.organization_id,
          listing_id: listingId,
          source_id: source.id,
          external_id: item.id,
          canonical_url: normalized.sourceUrl,
          source_name: source.name,
          attribution: "RentCast API; provider terms apply",
          payload_fingerprint: createHash("sha256").update(JSON.stringify({
            id: item.id, listingType: config.listingType, price: item.price, listingDate: item.listingDate,
          })).digest("hex"),
          last_seen_at: linkAt,
        }, { onConflict: "listing_id,source_id" });
        if (sourceLinkError) throw new Error("Unable to save listing source attribution");
        const { error: lastSeenError } = await supabase.from("listings")
          .update({ last_seen_at: linkAt })
          .eq("id", listingId)
          .eq("organization_id", source.organization_id);
        if (lastSeenError) throw new Error("Unable to update listing last-seen time");
        const contactInputs = [
          {
            contactType: "listing_agent" as const,
            contact: {
              name: item.listingAgent?.name,
              email: item.listingAgent?.email,
              phone: item.listingAgent?.phone,
            },
          },
          {
            contactType: "listing_office" as const,
            contact: {
              name: item.listingOffice?.name,
              email: item.listingOffice?.email,
              phone: item.listingOffice?.phone,
            },
          },
        ];
        for (const contactInput of contactInputs) {
          if (!contactInput.contact.email && !contactInput.contact.phone) continue;
          const contactResult = await storeListingContact(supabase, {
            organizationId: source.organization_id,
            listingId,
            sourceId: source.id,
            publicationContext: "Contact supplied by the RentCast API; not verified as property owner or listing poster.",
            contactType: contactInput.contactType,
            contact: contactInput.contact,
            provenance: "provider_supplied",
          });
          if (contactResult.error) throw new Error("Unable to save provider contact provenance");
          contactsFound += 1;
        }

        const { data: savedListing, error: savedListingError } = await supabase.from("listings")
          .select("id,summary,city,region,property_type,price,currency")
          .eq("id", listingId)
          .single();
        if (savedListingError || !savedListing) throw new Error("Unable to load saved listing for matching");

        const { data: existingScore, error: scoreQueryError } = await supabase.from("listing_scores")
          .select("id")
          .eq("listing_id", listingId)
          .limit(1)
          .maybeSingle();
        if (scoreQueryError) throw new Error("Unable to check listing score");
        if (!existingScore || isSameSourceListing) {
          const score = scoreListing({ ...input, firstSeenAt: input.firstSeenAt });
          const { error: scoreWriteError } = await supabase.from("listing_scores").insert({
            organization_id: source.organization_id,
            listing_id: listingId,
            score: score.score,
            trust_score: score.trustScore,
            owner_led_score: score.ownerLedScore,
            urgency_score: score.urgencyScore,
            quality_score: score.qualityScore,
            rule_version: score.ruleVersion,
            factors: score.factors,
          });
          if (scoreWriteError) throw new Error("Unable to save listing score");
        }

        const fingerprint = createHash("sha256").update(JSON.stringify({
          id: item.id,
          city: normalized.city,
          region: normalized.region,
          propertyType: normalized.propertyType,
          price: normalized.price,
          listingDate: normalized.firstSeenAt,
        })).digest("hex");
        const { error: snapshotError } = await supabase.from("source_snapshots").insert({
          organization_id: source.organization_id,
          source_id: source.id,
          listing_id: listingId,
          external_id: item.id,
          payload_fingerprint: fingerprint,
          sanitized_metadata: {
            title: normalized.title,
            property_type: normalized.propertyType,
            area: normalized.area,
            city: normalized.city,
            country_code: normalized.countryCode,
          },
        });
        if (snapshotError) throw new Error("Listing saved but sanitized source snapshot failed");

        const savedMatches = await saveAgentMatches(supabase, source.organization_id, savedListing, profiles ?? [], activeAgentIds);
        matched += savedMatches.length;
        const { error: auditError } = await supabase.from("audit_logs").insert({
          organization_id: source.organization_id,
          actor_id: null,
          action: existing ? "listing.duplicate_received" : "listing.ingested_by_source",
          entity_type: "listing",
          entity_id: listingId,
          metadata: { source_id: source.id, transport: "rentcast_api", private_details_stored: true },
        });
        if (auditError) throw new Error("Listing processed but its audit event could not be recorded");
      }

      const completedAt = new Date().toISOString();
      const message = rejected ? `Imported ${imported}; found ${duplicates} duplicates; skipped ${rejected} invalid provider records.` : null;
      const { error: healthError } = await supabase.from("source_health").upsert({
        organization_id: source.organization_id,
        source_id: source.id,
        status: rejected ? "degraded" : "healthy",
        last_checked_at: completedAt,
        last_sync_attempt_at: attemptedAt.toISOString(),
        last_success_at: completedAt,
        consecutive_failures: 0,
        message,
      }, { onConflict: "source_id" });
      if (healthError) throw new Error("Listings processed but source health could not be updated");
      const { error: runUpdateError } = await supabase.from("listing_collection_runs").update({
        status: rejected ? "degraded" : "completed",
        discovered_count: searchResult.discovered,
        imported_count: imported,
        duplicate_count: duplicates,
        rejected_count: rejected,
        contacts_found_count: contactsFound,
        completed_at: completedAt,
      }).eq("id", runId).eq("organization_id", source.organization_id);
      if (runUpdateError) throw new Error("Listings processed but collection run metrics could not be saved");

      const { error: auditError } = await supabase.from("audit_logs").insert({
        organization_id: source.organization_id,
        actor_id: null,
        action: "source.rentcast_sync_completed",
        entity_type: "listing_source",
        entity_id: source.id,
        metadata: { imported, duplicates, matched, rejected },
      });
      if (auditError) throw new Error("Sync completed but its source audit event could not be recorded");

      results.push({ sourceId: source.id, status: rejected ? "degraded" : "completed", imported, duplicates, matched, rejected, ...(message ? { message } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "RentCast sync failed";
      const { data: health } = await supabase.from("source_health")
        .select("consecutive_failures")
        .eq("source_id", source.id)
        .maybeSingle();
      const healthUpdate = await supabase.from("source_health").upsert({
        organization_id: source.organization_id,
        source_id: source.id,
        status: "failed",
        last_checked_at: new Date().toISOString(),
        last_sync_attempt_at: attemptedAt.toISOString(),
        consecutive_failures: (health?.consecutive_failures ?? 0) + 1,
        message: message.slice(0, 500),
      }, { onConflict: "source_id" });
      if (healthUpdate.error) {
        return NextResponse.json({ error: "RentCast sync failed and the source failure state could not be stored", results }, { status: 500 });
      }
      const { error: auditError } = await supabase.from("audit_logs").insert({
        organization_id: source.organization_id,
        actor_id: null,
        action: "source.rentcast_sync_failed",
        entity_type: "listing_source",
        entity_id: source.id,
        metadata: { message: message.slice(0, 300) },
      });
      if (auditError) {
        return NextResponse.json({ error: "RentCast sync failed and its failure audit could not be recorded", results }, { status: 500 });
      }
      const { error: runUpdateError } = await supabase.from("listing_collection_runs").update({
        status: "failed",
        error_message: message.slice(0, 500),
        completed_at: new Date().toISOString(),
      }).eq("id", runId).eq("organization_id", source.organization_id);
      if (runUpdateError) return NextResponse.json({ error: "RentCast sync failed and its collection run could not be updated", results }, { status: 500 });
      results.push({ sourceId: source.id, status: "failed", message });
    }
  }

  return NextResponse.json({
    data: {
      checked: results.length,
      completed: results.filter((result) => result.status === "completed" || result.status === "degraded").length,
      failed: results.filter((result) => result.status === "failed").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      deferred: results.filter((result) => result.status === "deferred").length,
      providerRequests,
      results,
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
