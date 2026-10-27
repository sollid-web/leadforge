import { NextResponse } from "next/server";
import { z } from "zod";
import { qualifyBatchListings, type PipelineListing } from "@/lib/agent-sales-pipeline";
import { getSalesManagerContext } from "@/lib/sales-auth";

const batchSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  listingIds: z.array(z.string().uuid()).min(1).max(50),
  exclusive: z.boolean().default(true),
  minimumFreshnessDays: z.number().int().min(1).max(90).default(14),
}).strict();

export async function GET(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { admin, organizationId } = result.context;
  const { data: batches, error } = await admin.from("lead_batches")
    .select("id,name,city,country_code,currency,exclusive,status,minimum_freshness_days,summary,created_at,approved_at")
    .eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: "Unable to load lead batches" }, { status: 500 });
  const ids = (batches ?? []).map((batch) => batch.id);
  const [{ data: items, error: itemError }, { data: offers, error: offerError }] = await Promise.all([
    ids.length ? admin.from("lead_batch_items").select("batch_id,listing_id").eq("organization_id", organizationId).in("batch_id", ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? admin.from("lead_offers").select("id,batch_id,status,price_cents,currency,agent_directory_id,created_at").eq("organization_id", organizationId).in("batch_id", ids) : Promise.resolve({ data: [], error: null }),
  ]);
  if (itemError || offerError) return NextResponse.json({ error: "Unable to load batch contents" }, { status: 500 });
  return NextResponse.json({ data: (batches ?? []).map((batch) => ({
    ...batch,
    listing_count: (items ?? []).filter((item) => item.batch_id === batch.id).length,
    offers: (offers ?? []).filter((offer) => offer.batch_id === batch.id),
  })) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const parsed = batchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead batch", details: parsed.error.flatten() }, { status: 400 });
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  const ids = [...new Set(parsed.data.listingIds)];
  if (ids.length !== parsed.data.listingIds.length) return NextResponse.json({ error: "Duplicate listing IDs were supplied" }, { status: 400 });
  const { data: rawListings, error: listingError } = await context.admin.from("listings")
    .select("id,title,city,region,country_code,currency,property_type,listing_type,price,owner_led_claim,poster_type,source_url,status,suppressed_at,has_contact_information,last_seen_at,first_seen_at,created_at,source_id,listing_sources(name,approved,active)")
    .eq("organization_id", context.organizationId).in("id", ids);
  if (listingError) return NextResponse.json({ error: "Unable to load selected listings" }, { status: 500 });
  if ((rawListings ?? []).length !== ids.length) return NextResponse.json({ error: "One or more selected listings were not found in this organization" }, { status: 404 });
  const { data: sales, error: salesError } = await context.admin.from("lead_listing_sales").select("listing_id")
    .eq("organization_id", context.organizationId).is("revoked_at", null).in("listing_id", ids);
  if (salesError) return NextResponse.json({ error: "Unable to check prior lead sales" }, { status: 500 });
  const soldIds = new Set((sales ?? []).map((sale) => sale.listing_id));
  type SourceInfo = { name: string; approved: boolean; active: boolean };
  type ListingWithSource = PipelineListing & { source: SourceInfo | null };
  const mapped: ListingWithSource[] = (rawListings ?? []).map((listing) => {
    const relation = listing.listing_sources as SourceInfo | SourceInfo[] | null;
    const joinedSource = Array.isArray(relation) ? relation[0] : relation;
    return { ...listing, source_name: joinedSource?.name ?? null, source: joinedSource ?? null } as ListingWithSource;
  });
  const base = qualifyBatchListings(mapped, { maxFreshnessDays: parsed.data.minimumFreshnessDays, soldListingIds: soldIds });
  const eligibleIds = new Set(base.qualified.filter((listing) => {
    const raw = mapped.find((candidate) => candidate.id === listing.id)!;
    return Boolean(raw.source?.approved && raw.source?.active);
  }).map((listing) => listing.id));
  const rejected = [
    ...base.rejected,
    ...base.qualified.filter((listing) => !eligibleIds.has(listing.id)).map((listing) => ({ id: listing.id, title: listing.title, reasons: ["Listing source is not approved and active."] })),
  ];
  const eligible = base.qualified.filter((listing) => eligibleIds.has(listing.id));
  if (!eligible.length) return NextResponse.json({ error: "No selected listings passed qualification", rejected }, { status: 422 });
  const summaryResult = qualifyBatchListings(eligible, { maxFreshnessDays: parsed.data.minimumFreshnessDays });
  const summary = summaryResult.summary;
  const batchName = parsed.data.name || `${summary.city}, ${summary.countryCode} · ${new Date().toISOString().slice(0, 10)}`;
  const status = eligible.length >= 20 ? "ready_for_review" : "draft";
  const { data: batch, error: batchError } = await context.admin.from("lead_batches").insert({
    organization_id: context.organizationId,
    name: batchName,
    city: summary.city,
    country_code: summary.countryCode,
    currency: summary.currency,
    exclusive: parsed.data.exclusive,
    status,
    minimum_freshness_days: parsed.data.minimumFreshnessDays,
    summary: {
      lead_count: summary.leadCount,
      region: summary.region,
      owner_verified: summary.ownerVerified,
      owner_unverified: summary.ownerUnverified,
      contacts_available: summary.contactsAvailable,
      contact_percent: summary.contactPercent,
      property_types: summary.propertyTypes,
      listing_types: summary.listingTypes,
      asking_price_min: summary.priceMin,
      asking_price_max: summary.priceMax,
      source_coverage: summary.sourceCoverage,
      first_seen_from: summary.firstSeenFrom,
      last_seen_through: summary.lastSeenThrough,
    },
    created_by: context.userId,
  }).select("id,name,status").single();
  if (batchError || !batch) return NextResponse.json({ error: "Unable to create lead batch" }, { status: 500 });
  const { error: itemError } = await context.admin.from("lead_batch_items").insert(eligible.map((listing) => ({ organization_id: context.organizationId, batch_id: batch.id, listing_id: listing.id })));
  if (itemError) {
    await context.admin.from("lead_batches").delete().eq("id", batch.id).eq("organization_id", context.organizationId);
    return NextResponse.json({ error: "Batch metadata was created but listing membership failed; no batch was retained" }, { status: 500 });
  }
  await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: "lead_batch.created", entity_type: "lead_batch", entity_id: batch.id, metadata: { included: eligible.length, rejected: rejected.length, status, exclusive: parsed.data.exclusive } });
  return NextResponse.json({ data: { ...batch, summary, listingCount: eligible.length }, rejected, qualification: eligible.length >= 20 ? "ready_for_review" : "draft_below_20_minimum" }, { status: 201 });
}
