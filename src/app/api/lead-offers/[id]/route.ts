import { NextResponse } from "next/server";
import { z } from "zod";
import { toMinorUnits } from "@/lib/agent-sales-pipeline";
import { getSalesManagerContext } from "@/lib/sales-auth";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_message"), message: z.string().trim().min(1).max(4000), templateKey: z.enum(["initial_offer","follow_up","sample_request","negotiation","purchase_confirmation","delivery_notification"]).optional() }),
  z.object({ action: z.literal("transition"), nextState: z.enum(["ready_for_review","approved","sent","responded","interested","accepted","declined","expired","cancelled","refunded"]), summary: z.string().trim().max(2000).optional(), message: z.string().trim().max(4000).optional(), channel: z.enum(["email","phone","whatsapp","manual"]).optional(), sharedDisclosureConfirmed: z.boolean().optional() }),
  z.object({ action: z.literal("payment"), paymentReference: z.string().trim().min(4).max(160), evidenceNote: z.string().trim().min(8).max(2000), amount: z.number().nonnegative().max(1_000_000_000_000), currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/) }),
  z.object({ action: z.literal("deliver") }),
]);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid offer action", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  const { data: offer, error: offerError } = await context.admin.from("lead_offers")
    .select("id,status,organization_id,batch_id,agent_directory_id,price_minor_units,currency,message")
    .eq("id", id).eq("organization_id", context.organizationId).maybeSingle();
  if (offerError) return NextResponse.json({ error: "Unable to load offer" }, { status: 500 });
  if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404 });

  let nextStatus: string | null = null;
  let eventSummary: string | null = null;
  if (parsed.data.action === "save_message") {
    if (!["draft", "ready_for_review"].includes(offer.status)) return NextResponse.json({ error: "Message is locked after approval; create a new offer revision" }, { status: 409 });
    const { error } = await context.admin.from("lead_offers").update({ message: parsed.data.message, template_key: parsed.data.templateKey ?? undefined, status: "draft", updated_at: new Date().toISOString() }).eq("id", offer.id);
    if (error) return NextResponse.json({ error: "Unable to save offer message" }, { status: 500 });
    await context.admin.from("lead_offer_events").insert({ organization_id: context.organizationId, offer_id: offer.id, previous_status: offer.status, next_status: "draft", event_type: "message_edited", summary: "Offer text edited by an operator; previous review state reset.", actor_id: context.userId });
    return NextResponse.json({ data: { id: offer.id, status: "draft" } });
  }

  if (parsed.data.action === "transition") {
    nextStatus = parsed.data.nextState;
    eventSummary = parsed.data.summary ?? null;
    const { error } = await context.supabase.rpc("advance_lead_offer", {
      target_offer: offer.id,
      next_state: nextStatus,
      event_summary: eventSummary,
      sent_message: parsed.data.message ?? null,
      sent_channel: parsed.data.channel ?? null,
      shared_disclosure: parsed.data.sharedDisclosureConfirmed ?? false,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  } else if (parsed.data.action === "payment") {
    let amountMinor: number;
    try { amountMinor = toMinorUnits(parsed.data.amount, parsed.data.currency); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid amount" }, { status: 400 }); }
    if (!Number.isSafeInteger(amountMinor)) return NextResponse.json({ error: "Amount is too large" }, { status: 400 });
    const { error } = await context.supabase.rpc("reconcile_lead_offer_payment", {
      target_offer: offer.id,
      payment_ref: parsed.data.paymentReference,
      evidence_note: parsed.data.evidenceNote,
      verified_amount_minor_units: amountMinor,
      verified_currency: parsed.data.currency.toUpperCase(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    nextStatus = "paid";
    eventSummary = "Manual payment reconciled by an authorized manager using the submitted reference and evidence note; not provider-verified.";
  } else {
    const { error } = await context.supabase.rpc("deliver_lead_offer", { target_offer: offer.id });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    nextStatus = "delivered";
    eventSummary = "Manager confirmed in-app purchased batch availability.";
  }

  if (nextStatus) {
    const interactionType = nextStatus === "sent" ? "offer_sent" : nextStatus === "responded" ? "response" : nextStatus === "interested" ? "sample_request" : nextStatus === "accepted" ? "negotiation" : "note";
    const { error: interactionError } = await context.admin.from("agent_directory_interactions").insert({
      organization_id: context.organizationId,
      agent_directory_id: offer.agent_directory_id,
      interaction_type: interactionType,
      channel: parsed.data.action === "transition" ? parsed.data.channel ?? "manual" : "manual",
      summary: eventSummary ?? `Offer status recorded as ${nextStatus}.`,
      created_by: context.userId,
    });
    if (interactionError) return NextResponse.json({ error: "Offer state was recorded but agent interaction history could not be updated" }, { status: 500 });
    if (["sent", "interested", "accepted", "paid", "delivered"].includes(nextStatus)) {
      const agentStatus = nextStatus === "sent" ? "contacted" : nextStatus === "interested" ? "interested" : "customer";
      await context.admin.from("agent_directory").update({ status: agentStatus, updated_at: new Date().toISOString() })
        .eq("id", offer.agent_directory_id).eq("organization_id", context.organizationId).neq("status", "opted_out").is("opted_out_at", null);
    }
    await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: `lead_offer.${nextStatus}`, entity_type: "lead_offer", entity_id: offer.id, metadata: { previous_status: offer.status, next_status: nextStatus, manual_action: parsed.data.action === "payment" } });
  }
  return NextResponse.json({ data: { id: offer.id, status: nextStatus } });
}
