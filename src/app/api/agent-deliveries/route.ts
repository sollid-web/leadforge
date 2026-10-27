import { NextResponse } from "next/server";
import { decryptPrivateData } from "@/lib/private-data";
import { getSalesBuyerContext } from "@/lib/sales-auth";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

type DecryptedContact = {
  type: string; name?: string; email?: string; phone?: string;
  sourceUrl: string | null; publicationContext: string | null; verificationStatus: string;
  permissionStatus: string; collectedAt: string; lastVerifiedAt: string | null;
};
type DeliveredListing = {
  id: string; title: string; summary: string; description: string | null; propertyType: string;
  listingType: string; area: string; city: string; region: string | null; countryCode: string;
  price: number | null; currency: string; posterType: string; posterConfidence: number | null;
  posterEvidence: string | null; sourceUrl: string | null; sourceName: string; publishedAt: string | null;
  updatedAt: string | null; lastSeenAt: string; contacts: DecryptedContact[];
};
type DeliveredBatch = {
  id: string; name: string; city: string; countryCode: string; currency: string;
  exclusive: boolean; summary: Record<string, unknown>;
};
type Delivery = { offerId: string; batch: DeliveredBatch; status: string; paidAt: string; deliveredAt: string | null; listings: DeliveredListing[] };

export async function GET(request: Request) {
  const result = await getSalesBuyerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  const { data: buyer, error: buyerError } = await context.admin.from("agent_directory")
    .select("id,name,status,linked_user_id").eq("organization_id", context.organizationId).eq("linked_user_id", context.userId).maybeSingle();
  if (buyerError) return NextResponse.json({ error: "Unable to verify buyer profile" }, { status: 500 });
  if (!buyer) return NextResponse.json({ error: "This account is not linked to an agent directory buyer profile" }, { status: 403 });
  const { data: offers, error: offerError } = await context.admin.from("lead_offers")
    .select("id,batch_id,status,price_minor_units,currency,paid_at,delivered_at")
    .eq("organization_id", context.organizationId).eq("agent_directory_id", buyer.id).in("status", ["paid", "delivered"])
    .order("paid_at", { ascending: false });
  if (offerError) return NextResponse.json({ error: "Unable to load purchased batch access" }, { status: 500 });
  const batchIds = [...new Set((offers ?? []).map((offer) => offer.batch_id))];
  const { data: batches, error: batchError } = batchIds.length
    ? await context.admin.from("lead_batches").select("id,name,city,country_code,currency,exclusive,summary").eq("organization_id", context.organizationId).in("id", batchIds)
    : { data: [], error: null };
  if (batchError) return NextResponse.json({ error: "Unable to load purchased batch summaries" }, { status: 500 });
  const batchMap = new Map((batches ?? []).map((batch) => [batch.id, batch]));
  const deliveries: Delivery[] = [];
  for (const offer of offers ?? []) {
    const batch = batchMap.get(offer.batch_id);
    if (!batch) continue;
    const { data: items, error: itemError } = await context.admin.from("lead_batch_items").select("listing_id")
      .eq("organization_id", context.organizationId).eq("batch_id", batch.id);
    if (itemError) return NextResponse.json({ error: "Unable to load purchased batch records" }, { status: 500 });
    const listingIds = (items ?? []).map((item) => item.listing_id);
    const { data: listings, error: listingError } = listingIds.length
      ? await context.admin.from("listings").select("id,title,summary,description,property_type,listing_type,area,city,region,country_code,price,currency,poster_type,poster_confidence,poster_evidence,source_url,published_at,listing_updated_at,last_seen_at,listing_sources(name)")
        .eq("organization_id", context.organizationId).in("id", listingIds).is("suppressed_at", null).not("status", "eq", "suppressed")
      : { data: [], error: null };
    if (listingError) return NextResponse.json({ error: "Unable to load purchased property records" }, { status: 500 });
    const visibleIds = (listings ?? []).map((listing) => listing.id);
    const { data: contacts, error: contactError } = visibleIds.length
      ? await context.admin.from("listing_contacts").select("id,listing_id,contact_type,encrypted_payload,encryption_iv,encryption_auth_tag,source_url,publication_context,verification_status,permission_status,collected_at,last_verified_at")
        .eq("organization_id", context.organizationId).in("listing_id", visibleIds).in("permission_status", ["unknown", "permitted"]).not("verification_status", "in", "(invalid,disputed,unavailable,stale)")
      : { data: [], error: null };
    if (contactError) return NextResponse.json({ error: "Unable to load purchased contact details" }, { status: 500 });
    const listingRecords: DeliveredListing[] = [];
    try {
      for (const listing of listings ?? []) {
        const source = Array.isArray(listing.listing_sources) ? listing.listing_sources[0] : listing.listing_sources;
        const listingContacts: DecryptedContact[] = (contacts ?? []).filter((contact) => contact.listing_id === listing.id).map((contact) => ({
          type: contact.contact_type,
          ...decryptPrivateData({ ciphertext: contact.encrypted_payload, iv: contact.encryption_iv, auth_tag: contact.encryption_auth_tag }),
          sourceUrl: contact.source_url,
          publicationContext: contact.publication_context,
          verificationStatus: contact.verification_status,
          permissionStatus: contact.permission_status,
          collectedAt: contact.collected_at,
          lastVerifiedAt: contact.last_verified_at,
        } as DecryptedContact));
        listingRecords.push({
          id: listing.id,
          title: listing.title,
          summary: listing.summary,
          description: listing.description,
          propertyType: listing.property_type,
          listingType: listing.listing_type,
          area: listing.area,
          city: listing.city,
          region: listing.region,
          countryCode: listing.country_code,
          price: listing.price,
          currency: listing.currency,
          posterType: listing.poster_type,
          posterConfidence: listing.poster_confidence,
          posterEvidence: listing.poster_evidence,
          sourceUrl: listing.source_url,
          sourceName: source?.name ?? "Unknown source",
          publishedAt: listing.published_at,
          updatedAt: listing.listing_updated_at,
          lastSeenAt: listing.last_seen_at,
          contacts: listingContacts,
        });
      }
    } catch {
      return NextResponse.json({ error: "Contact decryption is unavailable; delivery is blocked until the server encryption key is configured" }, { status: 503 });
    }
    deliveries.push({ offerId: offer.id, batch: { id: batch.id, name: batch.name, city: batch.city, countryCode: batch.country_code, currency: batch.currency, exclusive: batch.exclusive, summary: batch.summary }, status: offer.status, paidAt: offer.paid_at, deliveredAt: offer.delivered_at, listings: listingRecords });
  }

  if (new URL(request.url).searchParams.get("format") === "csv") {
    const headers = ["offer_id","batch_name","city","country_code","exclusive_or_shared","listing_id","title","property_type","listing_type","area","region","price","currency","poster_type","poster_confidence","source_name","source_url","published_at","listing_updated_at","last_seen_at","contact_type","contact_name","contact_email","contact_phone","contact_source_url","contact_verification","contact_permission","contact_collected_at","contact_last_verified_at"];
    const rows = [headers.map(csvCell).join(",")];
    for (const delivery of deliveries) {
      for (const listing of delivery.listings) {
        const contacts = listing.contacts.length ? listing.contacts : [null];
        for (const contact of contacts) {
          rows.push([
            delivery.offerId, delivery.batch.name, listing.city, listing.countryCode, delivery.batch.exclusive ? "exclusive" : "shared",
            listing.id, listing.title, listing.propertyType, listing.listingType, listing.area, listing.region, listing.price,
            listing.currency, listing.posterType, listing.posterConfidence, listing.sourceName, listing.sourceUrl,
            listing.publishedAt, listing.updatedAt, listing.lastSeenAt, contact?.type, contact?.name, contact?.email,
            contact?.phone, contact?.sourceUrl, contact?.verificationStatus, contact?.permissionStatus, contact?.collectedAt, contact?.lastVerifiedAt,
          ].map(csvCell).join(","));
        }
      }
    }
    await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: "lead_batch.csv_downloaded", entity_type: "agent_directory", entity_id: buyer.id, metadata: { offer_count: deliveries.length, listing_count: deliveries.reduce((sum, item) => sum + item.listings.length, 0) } });
    return new Response(rows.join("\r\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=leadforge-purchased-batches.csv", "Cache-Control": "private, no-store" } });
  }
  await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: "lead_batch.viewed", entity_type: "agent_directory", entity_id: buyer.id, metadata: { offer_count: deliveries.length, listing_count: deliveries.reduce((sum, item) => sum + item.listings.length, 0) } });
  return NextResponse.json({ buyer: { id: buyer.id, name: buyer.name }, data: deliveries }, { headers: { "Cache-Control": "private, no-store" } });
}
