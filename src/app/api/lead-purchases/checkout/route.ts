import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const checkoutSchema = z.object({ interestRequestId: z.string().uuid() }).strict();

type StripeSession = { id?: string; url?: string | null; status?: string };

async function stripeRequest(path: string, secret: string, init?: RequestInit) {
  return fetch(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function POST(request: Request) {
  const parsed = checkoutSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid approved lead request is required" }, { status: 400 });

  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Organization membership required" }, { status: 403 });

  const { data: agent, error: agentError } = await supabase.from("agents")
    .select("id")
    .eq("organization_id", member.organization_id)
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();
  if (agentError) return NextResponse.json({ error: "Unable to validate agent account" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "An active agent profile is required to purchase lead access" }, { status: 403 });

  const { data: interest, error: interestError } = await supabase.from("interest_requests")
    .select("id,match_id,agent_id,organization_id,status")
    .eq("id", parsed.data.interestRequestId)
    .eq("agent_id", agent.id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (interestError) return NextResponse.json({ error: "Unable to load approved interest request" }, { status: 500 });
  if (!interest || interest.status !== "approved") return NextResponse.json({ error: "A manager-approved interest request is required before checkout" }, { status: 409 });

  const { data: match, error: matchError } = await supabase.from("matches")
    .select("listing_id")
    .eq("id", interest.match_id)
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (matchError) return NextResponse.json({ error: "Unable to validate matched lead" }, { status: 500 });
  if (!match) return NextResponse.json({ error: "Matched lead not found" }, { status: 404 });

  const { data: listing, error: listingError } = await supabase.from("listings")
    .select("id,title,owner_led_claim,status,suppressed_at,owners(verification_status)")
    .eq("id", match.listing_id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (listingError) return NextResponse.json({ error: "Unable to validate seller lead" }, { status: 500 });
  if (!listing) return NextResponse.json({ error: "Seller lead not found" }, { status: 404 });
  if (!listing.owner_led_claim || listing.suppressed_at || listing.status === "suppressed") {
    return NextResponse.json({ error: "Only active owner-seller leads can be purchased" }, { status: 409 });
  }
  const owners = Array.isArray(listing.owners) ? listing.owners : listing.owners ? [listing.owners] : [];
  if (!owners.some((owner) => owner.verification_status === "verified")) {
    return NextResponse.json({ error: "The owner-seller claim must be verified before purchase" }, { status: 409 });
  }

  const { data: purchase, error: purchaseError } = await supabase.from("lead_purchases")
    .select("id,purchase_type,status,amount_cents,currency,stripe_checkout_session_id")
    .eq("interest_request_id", interest.id)
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (purchaseError) return NextResponse.json({ error: "Unable to load lead access status" }, { status: 500 });
  if (!purchase) return NextResponse.json({ error: "No paid access is due for this lead. Refresh the page or contact the workspace manager." }, { status: 409 });
  if (purchase.purchase_type !== "paid" || !["payment_required", "checkout_pending"].includes(purchase.status)) {
    return NextResponse.json({ error: "This lead does not require payment or is already unlocked" }, { status: 409 });
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!stripeSecret || !appUrl) return NextResponse.json({ error: "Checkout is not configured. Set STRIPE_SECRET_KEY and NEXT_PUBLIC_APP_URL." }, { status: 503 });
  const parsedAppUrl = z.string().url().safeParse(appUrl);
  if (!parsedAppUrl.success || new URL(appUrl).protocol !== "https:" && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Public application URL configuration is invalid" }, { status: 503 });
  }

  if (purchase.stripe_checkout_session_id) {
    let previousResponse: Response;
    try {
      previousResponse = await stripeRequest(`checkout/sessions/${encodeURIComponent(purchase.stripe_checkout_session_id)}`, stripeSecret);
    } catch {
      return NextResponse.json({ error: "Unable to check the existing checkout session" }, { status: 502 });
    }
    if (previousResponse.ok) {
      const previous = await previousResponse.json() as StripeSession;
      if (previous.status === "open" && previous.url) {
        return NextResponse.json({ data: { checkoutUrl: previous.url, status: "checkout_pending" } });
      }
      if (previous.status === "complete") {
        return NextResponse.json({ error: "Payment confirmation is processing. Refresh the lead page shortly." }, { status: 409 });
      }
    } else if (previousResponse.status !== 404) {
      return NextResponse.json({ error: "Unable to check the existing checkout session" }, { status: 502 });
    }
  }

  const form = new URLSearchParams({
    mode: "payment",
    success_url: `${new URL("/dashboard/leads", appUrl).toString()}?purchase=success`,
    cancel_url: `${new URL("/dashboard/leads", appUrl).toString()}?purchase=cancelled`,
    client_reference_id: purchase.id,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": purchase.currency,
    "line_items[0][price_data][unit_amount]": String(purchase.amount_cents),
    "line_items[0][price_data][product_data][name]": "Verified owner-seller lead",
    "line_items[0][price_data][product_data][description]": `One-time unlock for ${listing.title}`,
    "metadata[purchase_id]": purchase.id,
    "metadata[organization_id]": member.organization_id,
    "metadata[agent_id]": agent.id,
    "payment_intent_data[metadata][purchase_id]": purchase.id,
  });

  const idempotencyKey = `leadforge-${purchase.id}-${Math.floor(Date.now() / 86_400_000)}`;
  let stripeResponse: Response;
  try {
    stripeResponse = await stripeRequest("checkout/sessions", stripeSecret, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": idempotencyKey },
      body: form,
    });
  } catch {
    return NextResponse.json({ error: "Unable to connect to checkout provider" }, { status: 502 });
  }
  const session = await stripeResponse.json().catch(() => ({})) as StripeSession & { error?: { message?: string } };
  if (!stripeResponse.ok || !session.id || !session.url) {
    return NextResponse.json({ error: session.error?.message ?? "Checkout provider did not return a usable session" }, { status: 502 });
  }

  const { error: updateError } = await supabase.from("lead_purchases").update({
    status: "checkout_pending",
    stripe_checkout_session_id: session.id,
  }).eq("id", purchase.id).in("status", ["payment_required", "checkout_pending"]);
  if (updateError) return NextResponse.json({ error: "Checkout was created but the purchase record could not be updated; retry from the lead page" }, { status: 500 });

  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "lead_purchase.checkout_created",
      entityType: "lead_purchase",
      entityId: purchase.id,
      metadata: { amount_cents: purchase.amount_cents, currency: purchase.currency },
    });
  } catch {
    return NextResponse.json({ error: "Checkout is ready but its audit record could not be written; retry to continue" }, { status: 500 });
  }
  return NextResponse.json({ data: { checkoutUrl: session.url, status: "checkout_pending" } });
}
