import { NextResponse } from "next/server";
import { z } from "zod";
import { composeOfferTemplate, formatCurrencyAmount, type OfferTemplateKey, toMinorUnits } from "@/lib/agent-sales-pipeline";
import { getSalesManagerContext } from "@/lib/sales-auth";

const offerSchema = z.object({
  batchId: z.string().uuid(),
  agentDirectoryId: z.string().uuid(),
  pricingMode: z.enum(["batch", "per_lead"]),
  priceAmount: z.number().nonnegative().max(1_000_000_000_000),
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/),
  channel: z.enum(["email", "phone", "whatsapp", "manual"]).optional(),
  templateKey: z.enum(["initial_offer", "follow_up", "sample_request", "negotiation", "purchase_confirmation", "delivery_notification"]).default("initial_offer"),
  message: z.string().trim().max(4000).optional(),
}).strict();

export async function GET(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { admin, organizationId } = result.context;
  const { data: offers, error } = await admin.from("lead_offers")
    .select("id,batch_id,agent_directory_id,status,pricing_mode,unit_price_minor_units,price_minor_units,currency,channel,template_key,message,shared_disclosure_confirmed,offer_sent_at,responded_at,response_summary,accepted_at,payment_reference,payment_evidence_note,paid_at,delivered_at,refunded_at,created_at,updated_at")
    .eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(250);
  if (error) return NextResponse.json({ error: "Unable to load offers" }, { status: 500 });
  const batchIds = [...new Set((offers ?? []).map((offer) => offer.batch_id))];
  const agentIds = [...new Set((offers ?? []).map((offer) => offer.agent_directory_id))];
  const [{ data: batches, error: batchError }, { data: agents, error: agentError }, { data: events, error: eventError }] = await Promise.all([
    batchIds.length ? admin.from("lead_batches").select("id,name,city,country_code,currency,exclusive,status,summary").eq("organization_id", organizationId).in("id", batchIds) : Promise.resolve({ data: [], error: null }),
    agentIds.length ? admin.from("agent_directory").select("id,name,agency,city,country_code,status,preferred_channel,contact_ciphertext,contact_iv,contact_auth_tag,contact_key_version").eq("organization_id", organizationId).in("id", agentIds) : Promise.resolve({ data: [], error: null }),
    (offers ?? []).length ? admin.from("lead_offer_events").select("offer_id,previous_status,next_status,event_type,summary,created_at").eq("organization_id", organizationId).in("offer_id", (offers ?? []).map((offer) => offer.id)).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (batchError || agentError || eventError) return NextResponse.json({ error: "Unable to load offer details" }, { status: 500 });
  const batchMap = new Map((batches ?? []).map((batch) => [batch.id, batch]));
  const agentMap = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  return NextResponse.json({ data: (offers ?? []).map((offer) => ({
    ...offer,
    batch: batchMap.get(offer.batch_id) ?? null,
    agent: (() => {
      const agent = agentMap.get(offer.agent_directory_id);
      if (!agent) return null;
      const { contact_ciphertext, contact_iv, contact_auth_tag, contact_key_version, ...safe } = agent;
      return safe;
    })(),
    events: (events ?? []).filter((event) => event.offer_id === offer.id),
  })) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const parsed = offerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid offer", details: parsed.error.flatten() }, { status: 400 });
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  const [{ data: batch, error: batchError }, { data: agent, error: agentError }, { data: matched, error: matchError }] = await Promise.all([
    context.admin.from("lead_batches").select("id,name,city,country_code,currency,exclusive,status,summary")
      .eq("id", parsed.data.batchId).eq("organization_id", context.organizationId).maybeSingle(),
    context.admin.from("agent_directory").select("id,name,status,preferred_channel,preferred_currency")
      .eq("id", parsed.data.agentDirectoryId).eq("organization_id", context.organizationId).maybeSingle(),
    context.admin.from("lead_batch_agent_matches").select("score").eq("batch_id", parsed.data.batchId)
      .eq("agent_directory_id", parsed.data.agentDirectoryId).eq("organization_id", context.organizationId).maybeSingle(),
  ]);
  if (batchError || agentError || matchError) return NextResponse.json({ error: "Unable to validate batch, agent, or match" }, { status: 500 });
  if (!batch || !agent) return NextResponse.json({ error: "Batch or agent not found" }, { status: 404 });
  if (batch.status !== "approved") return NextResponse.json({ error: "Batch must be approved before an offer can be created" }, { status: 409 });
  if (!matched) return NextResponse.json({ error: "Create a market- and preference-compatible match before making an offer" }, { status: 409 });
  if (["inactive", "opted_out"].includes(agent.status)) return NextResponse.json({ error: "Inactive or opted-out agents cannot receive an offer" }, { status: 409 });
  const currency = parsed.data.currency.toUpperCase();
  if (currency !== batch.currency) return NextResponse.json({ error: "Offer currency must match the batch currency" }, { status: 400 });
  const summary = (batch.summary ?? {}) as Record<string, unknown>;
  const leadCount = Number(summary.lead_count ?? 0);
  if (!Number.isInteger(leadCount) || leadCount < 20) return NextResponse.json({ error: "Batch summary does not meet the 20-listing minimum" }, { status: 409 });
  let unitMinor: number;
  let totalMinor: number;
  try {
    unitMinor = toMinorUnits(parsed.data.priceAmount, currency);
    totalMinor = parsed.data.pricingMode === "per_lead" ? unitMinor * leadCount : unitMinor;
    if (!Number.isSafeInteger(totalMinor)) throw new Error("Offer amount exceeds the supported currency limit.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid price" }, { status: 400 });
  }
  const displayAmount = parsed.data.pricingMode === "per_lead"
    ? `${formatCurrencyAmount(unitMinor, currency)} per lead (${formatCurrencyAmount(totalMinor, currency)} total)`
    : formatCurrencyAmount(totalMinor, currency);
  const message = parsed.data.message?.trim() || composeOfferTemplate(parsed.data.templateKey as OfferTemplateKey, agent.name, {
    batchName: batch.name,
    city: batch.city,
    countryCode: batch.country_code,
    leadCount,
    contactCount: Number(summary.contacts_available ?? 0),
    ownerVerified: Number(summary.owner_verified ?? 0),
    ownerUnverified: Number(summary.owner_unverified ?? 0),
    propertyTypes: (summary.property_types ?? {}) as Record<string, number>,
    listingTypes: (summary.listing_types ?? {}) as Record<string, number>,
    exclusive: batch.exclusive,
    priceLabel: displayAmount,
  });
  const { data: offer, error } = await context.admin.from("lead_offers").insert({
    organization_id: context.organizationId,
    batch_id: batch.id,
    agent_directory_id: agent.id,
    status: "draft",
    pricing_mode: parsed.data.pricingMode,
    unit_price_minor_units: unitMinor,
    price_minor_units: totalMinor,
    currency,
    channel: parsed.data.channel ?? agent.preferred_channel ?? "manual",
    template_key: parsed.data.templateKey,
    message,
    created_by: context.userId,
  }).select("id,status").single();
  if (error || !offer) return NextResponse.json({ error: error?.code === "23505" ? "An offer already exists for this batch and agent" : "Unable to create offer" }, { status: error?.code === "23505" ? 409 : 500 });
  const { error: eventError } = await context.admin.from("lead_offer_events").insert({ organization_id: context.organizationId, offer_id: offer.id, next_status: "draft", event_type: "offer_created", summary: `Draft offer created at ${displayAmount}.`, actor_id: context.userId });
  if (eventError) return NextResponse.json({ error: "Offer was created but its history record could not be saved", id: offer.id }, { status: 500 });
  await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: "lead_offer.created", entity_type: "lead_offer", entity_id: offer.id, metadata: { batch_id: batch.id, agent_directory_id: agent.id, price_minor_units: totalMinor, currency, pricing_mode: parsed.data.pricingMode } });
  return NextResponse.json({ data: { ...offer, message, price_minor_units: totalMinor, currency, pricing_mode: parsed.data.pricingMode } }, { status: 201 });
}
