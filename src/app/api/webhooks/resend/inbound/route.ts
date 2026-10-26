import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const eventSchema = z.object({
  type: z.string(),
  data: z.object({
    email_id: z.string().uuid().optional(),
    to: z.array(z.string()).default([]),
    received_for: z.array(z.string()).optional(),
  }),
});

const receivedEmailSchema = z.object({
  id: z.string().uuid(),
  from: z.string().min(1).max(320),
  subject: z.string().max(998).default(""),
  text: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  message_id: z.string().max(998).nullable().optional(),
});

function addressFromHeader(value: string) {
  const candidate = value.match(/<([^<>]+)>/)?.[1] ?? value.trim();
  const parsed = z.string().email().safeParse(candidate);
  return parsed.success ? parsed.data.trim().toLocaleLowerCase("en") : null;
}

function htmlToText(value: string) {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function replyToken(address: string, domain: string) {
  const match = address.trim().toLocaleLowerCase("en").match(/^reply\+([a-f0-9]{64})@([^@]+)$/);
  if (!match || match[2] !== domain) return null;
  return match[1];
}

export async function POST(request: Request) {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  const apiKey = process.env.RESEND_API_KEY;
  const inboundDomain = process.env.RESEND_INBOUND_DOMAIN?.trim().toLocaleLowerCase("en");
  if (!webhookSecret || !apiKey || !inboundDomain) {
    return NextResponse.json({ error: "Resend inbound email is not configured" }, { status: 503 });
  }
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(inboundDomain)) {
    return NextResponse.json({ error: "RESEND_INBOUND_DOMAIN must be a valid receiving domain" }, { status: 503 });
  }

  const rawBody = await request.text();
  let verifiedEvent: unknown;
  try {
    verifiedEvent = new Webhook(webhookSecret).verify(rawBody, {
      "svix-id": request.headers.get("svix-id") ?? "",
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    });
  } catch {
    return NextResponse.json({ error: "Invalid Resend webhook signature" }, { status: 400 });
  }

  const parsedEvent = eventSchema.safeParse(verifiedEvent);
  if (!parsedEvent.success) return NextResponse.json({ error: "Invalid Resend webhook payload" }, { status: 400 });
  if (parsedEvent.data.type !== "email.received") return NextResponse.json({ received: true });
  const emailId = parsedEvent.data.data.email_id;
  if (!emailId) return NextResponse.json({ error: "Received-email event has no email ID" }, { status: 400 });

  const addresses = [...parsedEvent.data.data.to, ...(parsedEvent.data.data.received_for ?? [])];
  const token = addresses.map((address) => replyToken(address, inboundDomain)).find(Boolean);
  if (!token) return NextResponse.json({ received: true, matched: false });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Inbound reply storage is not configured" }, { status: 503 });

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: outreach, error: outreachError } = await admin.from("business_prospect_outreach")
    .select("id,organization_id,prospect_id,recipient_fingerprint")
    .eq("reply_token_hash", tokenHash)
    .eq("status", "sent")
    .maybeSingle();
  if (outreachError) return NextResponse.json({ error: "Unable to match inbound reply" }, { status: 500 });
  if (!outreach) return NextResponse.json({ received: true, matched: false });

  let receivedResponse: Response;
  try {
    receivedResponse = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return NextResponse.json({ error: "Unable to retrieve inbound email content from Resend" }, { status: 502 });
  }
  if (!receivedResponse.ok) return NextResponse.json({ error: `Resend returned ${receivedResponse.status} while retrieving inbound email` }, { status: 502 });
  const receivedEmail = receivedEmailSchema.safeParse(await receivedResponse.json().catch(() => null));
  if (!receivedEmail.success || receivedEmail.data.id !== emailId) {
    return NextResponse.json({ error: "Resend returned an invalid inbound email record" }, { status: 502 });
  }

  const sender = addressFromHeader(receivedEmail.data.from);
  if (!sender) return NextResponse.json({ error: "Inbound email has no valid sender address" }, { status: 422 });
  const message = (receivedEmail.data.text?.trim() || htmlToText(receivedEmail.data.html ?? "")).slice(0, 12_000);
  const { data: savedReply, error: saveError } = await admin.from("business_prospect_replies").insert({
    organization_id: outreach.organization_id,
    prospect_id: outreach.prospect_id,
    outreach_id: outreach.id,
    provider_email_id: receivedEmail.data.id,
    sender_email: sender,
    subject: (receivedEmail.data.subject || "(no subject)").replace(/[\r\n]+/g, " ").slice(0, 998),
    message: message || "(No readable message body was provided.)",
    provider_message_id: receivedEmail.data.message_id ?? null,
  }).select("id").maybeSingle();

  if (saveError && saveError.code !== "23505") {
    return NextResponse.json({ error: "Unable to save inbound reply" }, { status: 500 });
  }
  let replyId = savedReply?.id;
  if (!replyId && saveError?.code === "23505") {
    const { data: existingReply, error: existingError } = await admin.from("business_prospect_replies")
      .select("id")
      .eq("provider_email_id", receivedEmail.data.id)
      .maybeSingle();
    if (existingError) return NextResponse.json({ error: "Unable to verify duplicate inbound reply" }, { status: 500 });
    replyId = existingReply?.id;
  }
  if (replyId) {
    const { error: auditError } = await admin.from("audit_logs").insert({
      organization_id: outreach.organization_id,
      actor_id: null,
      action: "business_prospect.reply_received",
      entity_type: "business_prospect_reply",
      entity_id: replyId,
      metadata: { prospect_id: outreach.prospect_id, provider_email_id: receivedEmail.data.id },
    });
    if (auditError && auditError.code !== "23505") {
      return NextResponse.json({ error: "Reply was saved but its audit event could not be recorded" }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true, matched: true });
}
