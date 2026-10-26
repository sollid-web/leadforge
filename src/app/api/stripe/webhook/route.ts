import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const eventSchema = z.object({
  type: z.string(),
  data: z.object({
    object: z.object({
      id: z.string(),
      metadata: z.object({ purchase_id: z.string().uuid().optional() }).passthrough().optional(),
      payment_status: z.string().optional(),
      mode: z.string().optional(),
      amount_total: z.number().int().optional(),
      currency: z.string().optional(),
      payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
    }).passthrough(),
  }),
});

function validStripeSignature(payload: string, header: string | null, secret: string) {
  if (!header) return false;
  const values = header.split(",").map((part) => part.split("=", 2));
  const timestamp = values.find(([key]) => key === "t")?.[1];
  const signatures = values.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export async function POST(request: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return NextResponse.json({ error: "Stripe webhook is not configured" }, { status: 503 });
  const rawBody = await request.text();
  if (!validStripeSignature(rawBody, request.headers.get("stripe-signature"), webhookSecret)) {
    return NextResponse.json({ error: "Invalid Stripe signature" }, { status: 400 });
  }

  let event: z.infer<typeof eventSchema>;
  try {
    event = eventSchema.parse(JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ error: "Invalid Stripe event payload" }, { status: 400 });
  }

  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.expired") {
    return NextResponse.json({ received: true });
  }
  const session = event.data.object;
  const purchaseId = session.metadata?.purchase_id;
  if (!purchaseId) return NextResponse.json({ received: true });
  const supabase = getSupabaseAdminClient();
  if (!supabase) return NextResponse.json({ error: "Payment database is not configured" }, { status: 503 });

  const { data: purchase, error: purchaseError } = await supabase.from("lead_purchases")
    .select("id,organization_id,listing_id,agent_id,status,amount_cents,currency,stripe_checkout_session_id")
    .eq("id", purchaseId)
    .maybeSingle();
  if (purchaseError) return NextResponse.json({ error: "Unable to load lead purchase" }, { status: 500 });
  if (!purchase) return NextResponse.json({ error: "Lead purchase not found" }, { status: 404 });
  if (purchase.stripe_checkout_session_id && purchase.stripe_checkout_session_id !== session.id) {
    return NextResponse.json({ error: "Checkout session does not match this lead purchase" }, { status: 409 });
  }

  if (event.type === "checkout.session.expired") {
    const { error } = await supabase.from("lead_purchases").update({
      status: "payment_required",
      stripe_checkout_session_id: null,
    }).eq("id", purchase.id).eq("stripe_checkout_session_id", session.id).eq("status", "checkout_pending");
    if (error) return NextResponse.json({ error: "Unable to reset expired lead checkout" }, { status: 500 });
    return NextResponse.json({ received: true });
  }

  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;
  if (session.mode !== "payment" || session.payment_status !== "paid"
    || session.amount_total !== purchase.amount_cents || session.currency !== purchase.currency) {
    return NextResponse.json({ error: "Checkout payment details do not match the lead purchase" }, { status: 409 });
  }
  const auditRecord = {
    organization_id: purchase.organization_id,
    actor_id: null,
    action: "lead_purchase.paid",
    entity_type: "lead_purchase",
    entity_id: purchase.id,
    metadata: { amount_cents: purchase.amount_cents, currency: purchase.currency, stripe_session_id: session.id },
  };
  const { data: updatedPurchase, error: updateError } = await supabase.from("lead_purchases").update({
    status: "paid",
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: paymentIntentId,
    paid_at: new Date().toISOString(),
  }).eq("id", purchase.id).eq("status", "checkout_pending").select("id").maybeSingle();
  if (updateError) return NextResponse.json({ error: "Payment was confirmed but the purchase record could not be unlocked" }, { status: 500 });
  if (!updatedPurchase) {
    const { data: currentPurchase, error: currentError } = await supabase.from("lead_purchases")
      .select("status,stripe_checkout_session_id")
      .eq("id", purchase.id)
      .maybeSingle();
    if (currentError) return NextResponse.json({ error: "Unable to verify the lead purchase state" }, { status: 500 });
    if (currentPurchase?.status === "paid" && currentPurchase.stripe_checkout_session_id === session.id) {
      const { error: auditError } = await supabase.from("audit_logs").insert(auditRecord);
      if (auditError && auditError.code !== "23505") {
        return NextResponse.json({ error: "Payment was confirmed but its audit record could not be written" }, { status: 500 });
      }
      return NextResponse.json({ received: true });
    }
    return NextResponse.json({ error: "Lead purchase state changed before payment could be applied" }, { status: 409 });
  }

  const { error: auditError } = await supabase.from("audit_logs").insert(auditRecord);
  if (auditError && auditError.code !== "23505") return NextResponse.json({ error: "Payment was confirmed but its audit record could not be written" }, { status: 500 });
  return NextResponse.json({ received: true });
}
