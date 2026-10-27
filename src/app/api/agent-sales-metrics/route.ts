import { NextResponse } from "next/server";
import { getSalesManagerContext } from "@/lib/sales-auth";
import { summarizeOfferConversions, type MetricBatch, type MetricOffer } from "@/lib/sales-metrics";

export async function GET(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { admin, organizationId } = result.context;
  const freshnessWindowDays = 14;
  const freshnessCutoff = new Date(Date.now() - freshnessWindowDays * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: agents, error: agentError },
    { data: offers, error: offerError },
    { data: batches, count: batchCount, error: batchError },
    { count: listingCount, error: listingError },
    { count: ownerClaimedCount, error: ownerClaimedError },
    { count: ownerVerifiedCount, error: ownerVerifiedError },
    { count: qualifiedOwnerClaimedCount, error: qualifiedOwnerClaimedError },
    { count: qualifiedOwnerVerifiedCount, error: qualifiedOwnerVerifiedError },
    { count: contactsCount, error: contactsError },
    { count: freshCount, error: freshError },
  ] = await Promise.all([
    admin.from("agent_directory").select("status").eq("organization_id", organizationId),
    admin.from("lead_offers").select("batch_id,status,pricing_mode,price_minor_units,currency,paid_at,offer_sent_at,responded_at,delivered_at,refunded_at").eq("organization_id", organizationId),
    admin.from("lead_batches").select("id,city,summary", { count: "exact" }).eq("organization_id", organizationId),
    admin.from("listings").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).is("suppressed_at", null),
    admin.from("listings").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).is("suppressed_at", null).eq("owner_led_claim", true),
    admin.from("listings").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).is("suppressed_at", null).eq("poster_type", "OWNER_VERIFIED"),
    admin.from("listings").select("id,listing_sources!inner(id)", { count: "exact", head: true }).eq("organization_id", organizationId).is("suppressed_at", null).eq("owner_led_claim", true).in("poster_type", ["OWNER_UNVERIFIED", "OWNER_VERIFIED"]).not("status", "in", "(closed,suppressed)").like("source_url", "https://%").gte("last_seen_at", freshnessCutoff).eq("listing_sources.organization_id", organizationId).eq("listing_sources.approved", true).eq("listing_sources.active", true),
    admin.from("listings").select("id,listing_sources!inner(id)", { count: "exact", head: true }).eq("organization_id", organizationId).is("suppressed_at", null).eq("poster_type", "OWNER_VERIFIED").not("status", "in", "(closed,suppressed)").like("source_url", "https://%").gte("last_seen_at", freshnessCutoff).eq("listing_sources.organization_id", organizationId).eq("listing_sources.approved", true).eq("listing_sources.active", true),
    admin.from("listings").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).is("suppressed_at", null).eq("has_contact_information", true),
    admin.from("listings").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).is("suppressed_at", null).gte("last_seen_at", freshnessCutoff),
  ]);
  if (agentError || offerError || batchError || listingError || ownerClaimedError || ownerVerifiedError || qualifiedOwnerClaimedError || qualifiedOwnerVerifiedError || contactsError || freshError) {
    return NextResponse.json({ error: "Unable to calculate sales metrics" }, { status: 500 });
  }

  const offerRows = (offers ?? []) as MetricOffer[];
  const batchRows = (batches ?? []) as MetricBatch[];
  const sent = offerRows.filter((offer) => offer.offer_sent_at).length;
  const responded = offerRows.filter((offer) => offer.responded_at).length;
  const interested = offerRows.filter((offer) => ["interested", "accepted", "paid", "delivered"].includes(offer.status)).length;
  const financials = new Map<string, { grossMinor: number; refundedMinor: number; netMinor: number }>();
  for (const offer of offerRows) {
    if (!offer.paid_at) continue;
    const currency = String(offer.currency ?? "").trim();
    if (!currency) continue;
    const amount = Number(offer.price_minor_units ?? 0);
    const row = financials.get(currency) ?? { grossMinor: 0, refundedMinor: 0, netMinor: 0 };
    row.grossMinor += amount;
    if (offer.refunded_at || offer.status === "refunded") row.refundedMinor += amount;
    row.netMinor = row.grossMinor - row.refundedMinor;
    financials.set(currency, row);
  }
  const agentStatuses = (agents ?? []).reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const soldBatchIds = new Set(offerRows.filter((offer) => ["paid", "delivered", "refunded"].includes(offer.status)).map((offer) => offer.batch_id));
  const freshListings = freshCount ?? 0;

  return NextResponse.json({ data: {
    freshnessWindowDays,
    listingsDiscovered: listingCount ?? 0,
    ownerClaimedLeads: ownerClaimedCount ?? 0,
    ownerVerifiedLeads: ownerVerifiedCount ?? 0,
    qualifiedOwnerClaimedLeads: qualifiedOwnerClaimedCount ?? 0,
    qualifiedOwnerVerifiedLeads: qualifiedOwnerVerifiedCount ?? 0,
    contactsAvailable: contactsCount ?? 0,
    freshLeads: freshListings,
    staleLeads: Math.max(0, (listingCount ?? 0) - freshListings),
    agentsDiscovered: (agents ?? []).length,
    agentsReviewed: agentStatuses.reviewed ?? 0,
    agentsCustomers: agentStatuses.customer ?? 0,
    agentsOptedOut: agentStatuses.opted_out ?? 0,
    offersPrepared: offerRows.length,
    offersSent: sent,
    responses: responded,
    interested,
    responseRate: sent ? Math.round(responded * 1000 / sent) / 10 : null,
    interestRate: sent ? Math.round(interested * 1000 / sent) / 10 : null,
    batchesCreated: batchCount ?? batchRows.length,
    batchesSold: soldBatchIds.size,
    deliveredOffers: offerRows.filter((offer) => offer.delivered_at).length,
    revenueByCurrency: Object.fromEntries(financials),
    conversions: summarizeOfferConversions(offerRows, batchRows),
    conversionAttributionNote: "City and pricing mode are offer-level groups. Source values describe batch source coverage and are not causal attribution.",
  } }, { headers: { "Cache-Control": "private, no-store" } });
}
