import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { isValidSenderAddress } from "@/lib/email";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const sendSchema = z.object({
  subject: z.string().trim().min(3).max(180).refine((value) => !/[\r\n]/.test(value)),
  message: z.string().trim().min(30).max(4000),
  reviewed: z.literal(true),
  confirmation: z.literal("send"),
}).strict();

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function emailFingerprint(email: string) {
  return createHash("sha256").update(email.trim().toLocaleLowerCase("en")).digest("hex");
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = sendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Review the email subject and message, then confirm this individual send", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });

  const { data: prospect, error: prospectError } = await supabase.from("business_prospects")
    .select("id,organization_id,name,business_type,email,website,address,osm_url,status")
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (prospectError) return NextResponse.json({ error: "Unable to load business prospect" }, { status: 500 });
  if (!prospect) return NextResponse.json({ error: "Business prospect not found" }, { status: 404 });
  if (prospect.status === "archived") return NextResponse.json({ error: "Archived prospects cannot be contacted" }, { status: 409 });
  const recipientCheck = z.string().email().safeParse(prospect.email);
  if (!recipientCheck.success) return NextResponse.json({ error: "This business has no valid public email address" }, { status: 409 });
  const recipient = recipientCheck.data.trim();

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!apiKey || !from || !appUrl) return NextResponse.json({ error: "Email is not configured. Set RESEND_API_KEY, RESEND_FROM_EMAIL, and NEXT_PUBLIC_APP_URL." }, { status: 503 });
  const parsedAppUrl = z.string().url().safeParse(appUrl);
  if (!isValidSenderAddress(from) || !parsedAppUrl.success || new URL(appUrl).protocol !== "https:" && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Email sender or public app URL configuration is invalid" }, { status: 503 });
  }

  const recipientHash = emailFingerprint(recipient);
  const { data: reserved, error: reserveError } = await supabase.rpc("reserve_business_prospect_email", {
    target_organization: member.organization_id,
    target_prospect: prospect.id,
    target_recipient_fingerprint: recipientHash,
    target_content_fingerprint: createHash("sha256").update(`${parsed.data.subject}\n${parsed.data.message}`).digest("hex"),
    target_subject: parsed.data.subject,
    target_body: parsed.data.message,
  });
  if (reserveError) {
    const detail = reserveError.message;
    const status = detail.includes("permission") ? 403
      : detail.includes("not found") ? 404
        : detail.includes("last 30 days") || detail.includes("opted out") ? 409
          : detail.includes("limit reached") ? 429 : 500;
    return NextResponse.json({ error: detail.includes("permission") || detail.includes("not found") || detail.includes("opted out") || detail.includes("30 days") || detail.includes("limit reached")
      ? detail : "Unable to reserve this email send" }, { status });
  }
  const outreachId = (reserved as { id?: string } | null)?.id;
  if (!outreachId) return NextResponse.json({ error: "Email reservation did not return a delivery record" }, { status: 500 });

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const unsubscribeUrl = new URL(`/api/business-prospects/opt-out?token=${encodeURIComponent(token)}`, appUrl).toString();
  const admin = getSupabaseAdminClient();
  if (!admin) {
    await supabase.from("business_prospect_outreach").update({ status: "failed", failure_reason: "Service-role database access is not configured" }).eq("id", outreachId);
    return NextResponse.json({ error: "Server email opt-out storage requires SUPABASE_SERVICE_ROLE_KEY; no email was sent" }, { status: 503 });
  }
  const { error: tokenError } = await admin.from("business_prospect_opt_out_tokens").insert({
    token_hash: tokenHash,
    organization_id: member.organization_id,
    prospect_id: prospect.id,
    email_fingerprint: recipientHash,
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (tokenError) {
    await supabase.from("business_prospect_outreach").update({ status: "failed", failure_reason: "Could not create opt-out link" }).eq("id", outreachId);
    return NextResponse.json({ error: "Could not create the required opt-out link; no email was sent" }, { status: 500 });
  }

  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "business_prospect.email_approved",
      entityType: "business_prospect_outreach",
      entityId: outreachId,
      metadata: { prospect_id: prospect.id, recipient_fingerprint: recipientHash },
    });
  } catch {
    await supabase.from("business_prospect_outreach").update({ status: "failed", failure_reason: "Audit record could not be written" }).eq("id", outreachId);
    return NextResponse.json({ error: "Email could not be audited; no email was sent" }, { status: 500 });
  }

  const htmlBody = parsed.data.message.split("\n").map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`).join("");
  const html = `${htmlBody}<hr><p style="font-size:12px;color:#666">This individual business introduction was sent by a LeadForge workspace manager. <a href="${escapeHtml(unsubscribeUrl)}">Stop future business emails</a>.</p><p style="font-size:11px;color:#888">Business listing source: <a href="${escapeHtml(prospect.osm_url)}">OpenStreetMap</a> (© OpenStreetMap contributors).</p>`;
  let providerMessageId: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: parsed.data.subject,
        text: `${parsed.data.message}\n\nStop future business emails: ${unsubscribeUrl}\nBusiness record: ${prospect.osm_url} (© OpenStreetMap contributors).`,
        html,
        headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !result.id) throw new Error(result.message ?? `Email provider returned ${response.status}`);
    providerMessageId = result.id;
  } catch (reason) {
    failureReason = reason instanceof Error ? reason.message.slice(0, 500) : "Email provider request failed";
  }

  const { error: deliveryError } = await supabase.from("business_prospect_outreach").update({
    status: providerMessageId ? "sent" : "failed",
    provider_message_id: providerMessageId,
    failure_reason: failureReason,
    sent_at: providerMessageId ? new Date().toISOString() : null,
  }).eq("id", outreachId).eq("status", "sending");
  if (deliveryError) return NextResponse.json({ error: "Email provider accepted the message but delivery state could not be saved; inspect the delivery log before retrying" }, { status: 500 });
  if (!providerMessageId) {
    try {
      await writeAuditLog(supabase, {
        organizationId: member.organization_id,
        actorId: user.id,
        action: "business_prospect.email_failed",
        entityType: "business_prospect_outreach",
        entityId: outreachId,
        metadata: { prospect_id: prospect.id, reason: failureReason },
      });
    } catch {
      return NextResponse.json({ error: "Email delivery failed and its failure audit could not be written" }, { status: 500 });
    }
    return NextResponse.json({ error: `Email was not sent: ${failureReason ?? "provider error"}` }, { status: 502 });
  }
  const contactedStatus = prospect.status === "new" || prospect.status === "reviewed" ? "contacted" : prospect.status;
  const { error: prospectUpdateError } = await supabase.from("business_prospects").update({
    status: contactedStatus,
    updated_at: new Date().toISOString(),
  }).eq("id", prospect.id).eq("organization_id", member.organization_id);
  if (prospectUpdateError) return NextResponse.json({ error: "Email was sent but prospect stage could not be updated" }, { status: 500 });
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "business_prospect.email_sent",
      entityType: "business_prospect_outreach",
      entityId: outreachId,
      metadata: { prospect_id: prospect.id, provider_message_id: providerMessageId },
    });
  } catch {
    return NextResponse.json({ error: "Email was sent but its delivery audit could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { id: outreachId, status: "sent", prospectId: prospect.id } });
}
