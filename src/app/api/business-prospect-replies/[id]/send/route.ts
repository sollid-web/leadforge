import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { isValidSenderAddress } from "@/lib/email";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const sendSchema = z.object({
  message: z.string().trim().min(10).max(4_000),
  reviewed: z.literal(true),
  confirmation: z.literal("send"),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = sendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Review the reply and confirm this individual send", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Server-side reply storage is not configured" }, { status: 503 });
  const { data: reply, error: replyError } = await admin.from("business_prospect_replies")
    .select("id,organization_id,prospect_id,sender_email,subject,provider_message_id,status")
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (replyError) return NextResponse.json({ error: "Unable to load prospect reply" }, { status: 500 });
  if (!reply) return NextResponse.json({ error: "Prospect reply not found" }, { status: 404 });
  if (reply.status === "sent" || reply.status === "sending") {
    return NextResponse.json({ error: "This reply is already being sent or has been sent" }, { status: 409 });
  }

  const from = process.env.RESEND_FROM_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  if (!from || !apiKey) return NextResponse.json({ error: "Email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL." }, { status: 503 });
  if (!isValidSenderAddress(from)) return NextResponse.json({ error: "Email sender configuration is invalid" }, { status: 503 });
  const recipient = z.string().email().safeParse(reply.sender_email);
  if (!recipient.success) return NextResponse.json({ error: "Inbound reply has no valid sender address" }, { status: 409 });
  const recipientFingerprint = createHash("sha256").update(recipient.data.trim().toLocaleLowerCase("en")).digest("hex");
  const { data: optedOut, error: optOutError } = await admin.from("business_prospect_email_opt_outs")
    .select("id")
    .eq("organization_id", member.organization_id)
    .eq("email_fingerprint", recipientFingerprint)
    .maybeSingle();
  if (optOutError) return NextResponse.json({ error: "Unable to check email opt-out status" }, { status: 500 });
  if (optedOut) return NextResponse.json({ error: "This address has opted out of future business emails" }, { status: 409 });

  const { data: sendingReply, error: reserveError } = await admin.from("business_prospect_replies")
    .update({ status: "sending", reply_body: parsed.data.message })
    .eq("id", reply.id)
    .eq("organization_id", member.organization_id)
    .in("status", ["received", "drafted", "failed"])
    .select("id")
    .maybeSingle();
  if (reserveError) return NextResponse.json({ error: "Unable to reserve this reply send" }, { status: 500 });
  if (!sendingReply) return NextResponse.json({ error: "This reply changed while the send was being prepared" }, { status: 409 });

  const safeSubject = reply.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 180);
  const threadHeaders = reply.provider_message_id && /^<[^<>\r\n]{1,250}>$/.test(reply.provider_message_id)
    ? { "In-Reply-To": reply.provider_message_id, References: reply.provider_message_id }
    : undefined;
  let providerMessageId: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `estatelq-reply-${reply.id}-${createHash("sha256").update(parsed.data.message).digest("hex").slice(0, 24)}`,
      },
      body: JSON.stringify({
        from,
        to: [recipient.data],
        subject: safeSubject.toLocaleLowerCase("en").startsWith("re:") ? safeSubject : `Re: ${safeSubject}`,
        text: parsed.data.message,
        ...(threadHeaders ? { headers: threadHeaders } : {}),
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !result.id) throw new Error(result.message ?? `Email provider returned ${response.status}`);
    providerMessageId = result.id;
  } catch (reason) {
    failureReason = reason instanceof Error ? reason.message.slice(0, 500) : "Email provider request failed";
  }

  if (!providerMessageId) {
    const { error: failureUpdateError } = await admin.from("business_prospect_replies")
      .update({ status: "failed" })
      .eq("id", reply.id)
      .eq("status", "sending");
    if (failureUpdateError) return NextResponse.json({ error: "Email was not sent and the failed delivery state could not be saved" }, { status: 500 });
    return NextResponse.json({ error: `Reply was not sent: ${failureReason ?? "provider error"}` }, { status: 502 });
  }

  const repliedAt = new Date().toISOString();
  const { error: deliveryError } = await admin.from("business_prospect_replies")
    .update({ status: "sent", reply_provider_message_id: providerMessageId, replied_at: repliedAt })
    .eq("id", reply.id)
    .eq("status", "sending");
  if (deliveryError) return NextResponse.json({ error: "Email provider accepted the reply but delivery state could not be saved; inspect the delivery log before retrying" }, { status: 500 });

  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "business_prospect.reply_sent",
      entityType: "business_prospect_reply",
      entityId: reply.id,
      metadata: { prospect_id: reply.prospect_id, provider_message_id: providerMessageId },
    });
  } catch {
    return NextResponse.json({ error: "Reply was sent but its delivery audit could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { id: reply.id, status: "sent", repliedAt } });
}
