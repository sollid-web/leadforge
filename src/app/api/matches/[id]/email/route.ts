import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { isValidSenderAddress } from "@/lib/email";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const sendSchema = z.object({ confirmation: z.literal("send") });

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = sendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Explicit send confirmation is required" }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });

  const { data: match, error: matchError } = await supabase.from("matches")
    .select("id,agent_id,listing_id,listings(title,property_type,area,city,price,currency,suppressed_at),agents(user_id,active)")
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (matchError) return NextResponse.json({ error: "Unable to load opportunity match" }, { status: 500 });
  if (!match) return NextResponse.json({ error: "Opportunity match not found" }, { status: 404 });
  const listing = Array.isArray(match.listings) ? match.listings[0] : match.listings;
  const agent = Array.isArray(match.agents) ? match.agents[0] : match.agents;
  if (!listing || !agent || !agent.active || listing.suppressed_at) {
    return NextResponse.json({ error: "This opportunity is not eligible for notification" }, { status: 409 });
  }
  const { data: preferences, error: preferencesError } = await supabase.from("agent_preferences")
    .select("notify_email,opt_out_at")
    .eq("agent_id", match.agent_id)
    .maybeSingle();
  if (preferencesError) return NextResponse.json({ error: "Unable to check agent email consent" }, { status: 500 });
  if (!preferences?.notify_email || preferences.opt_out_at) {
    return NextResponse.json({ error: "This agent has not opted in to email notifications" }, { status: 409 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Server email lookup requires SUPABASE_SERVICE_ROLE_KEY" }, { status: 503 });
  const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(agent.user_id);
  if (authUserError) return NextResponse.json({ error: "Unable to verify the agent email address" }, { status: 502 });
  const recipient = authUser.user.email;
  if (!recipient || !authUser.user.email_confirmed_at) {
    return NextResponse.json({ error: "Agent must have a confirmed email address" }, { status: 409 });
  }
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!apiKey || !from || !appUrl) {
    return NextResponse.json({ error: "Email is not configured. Set RESEND_API_KEY, RESEND_FROM_EMAIL, and NEXT_PUBLIC_APP_URL." }, { status: 503 });
  }
  const parsedAppUrl = z.string().url().safeParse(appUrl);
  if (!isValidSenderAddress(from) || !parsedAppUrl.success || new URL(appUrl).protocol !== "https:" && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Email sender or public app URL configuration is invalid" }, { status: 503 });
  }

  const subject = `A property opportunity matched your profile: ${listing.title}`;
  const amount = listing.price === null ? "Price not provided" : `${listing.currency} ${Number(listing.price).toLocaleString("en-US")}`;
  const summary = [
    listing.title,
    `${listing.property_type} in ${listing.area}, ${listing.city}`,
    amount,
  ].join("\n");
  const body = `${summary}\n\nView summary and manage your request: ${new URL("/dashboard/leads", appUrl).toString()}\n\nYou received this because you enabled opportunity email notifications for your EstatelQ account.`;
  const html = `<p>${escapeHtml(listing.title)}</p><p>${escapeHtml(listing.property_type)} in ${escapeHtml(listing.area)}, ${escapeHtml(listing.city)}<br>${escapeHtml(amount)}</p><p><a href="${escapeHtml(new URL("/dashboard/leads", appUrl).toString())}">View opportunity summary</a></p><p>You received this because you enabled opportunity email notifications for your EstatelQ account.</p>`;

  const { data: existing, error: existingError } = await supabase.from("outreach_messages")
    .select("id,status")
    .eq("match_id", match.id)
    .eq("channel", "email")
    .maybeSingle();
  if (existingError) return NextResponse.json({ error: "Unable to check prior delivery" }, { status: 500 });
  if (existing && existing.status !== "failed") {
    return NextResponse.json({ error: existing.status === "sent" ? "This match was already emailed" : "A message for this match is already being processed" }, { status: 409 });
  }

  let messageId = existing?.id;
  if (existing) {
    const { data, error } = await supabase.from("outreach_messages").update({
      recipient,
      subject,
      body,
      status: "approved",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      failure_reason: null,
    }).eq("id", existing.id).eq("status", "failed").select("id").maybeSingle();
    if (error) return NextResponse.json({ error: "Unable to prepare email retry" }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Another request is already processing this email" }, { status: 409 });
    messageId = data.id;
  } else {
    const { data, error } = await supabase.from("outreach_messages").insert({
      organization_id: member.organization_id,
      match_id: match.id,
      channel: "email",
      summary: `${listing.title} · ${listing.area}, ${listing.city}`,
      recipient,
      subject,
      body,
      status: "approved",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
    }).select("id").single();
    if (error) return NextResponse.json({ error: error.code === "23505" ? "A message for this match is already being processed" : "Unable to record email approval" }, { status: error.code === "23505" ? 409 : 500 });
    messageId = data.id;
  }

  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "outreach.email_approved",
      entityType: "outreach_message",
      entityId: messageId,
      metadata: { recipient, match_id: match.id },
    });
  } catch {
    await supabase.from("outreach_messages").update({ status: "failed", failure_reason: "Audit record could not be written" }).eq("id", messageId);
    return NextResponse.json({ error: "Email approval could not be audited; no email was sent" }, { status: 500 });
  }

  let providerMessageId: string | null = null;
  let failureReason: string | null = null;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [recipient], subject, text: body, html }),
      signal: AbortSignal.timeout(12000),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok) throw new Error(result.message ?? `Email provider returned ${response.status}`);
    providerMessageId = result.id ?? null;
  } catch (error) {
    failureReason = error instanceof Error ? error.message.slice(0, 500) : "Email provider request failed";
  }
  const { error: updateError } = await supabase.from("outreach_messages").update({
    status: failureReason ? "failed" : "sent",
    sent_at: failureReason ? null : new Date().toISOString(),
    provider_message_id: providerMessageId,
    failure_reason: failureReason,
  }).eq("id", messageId);
  if (updateError) return NextResponse.json({ error: "Email provider response was received but delivery status could not be saved; inspect provider logs before retrying" }, { status: 500 });
  if (failureReason) {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "outreach.email_failed",
      entityType: "outreach_message",
      entityId: messageId,
      metadata: { failure_reason: failureReason },
    });
    return NextResponse.json({ error: `Email could not be sent: ${failureReason}` }, { status: 502 });
  }
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "outreach.email_sent",
      entityType: "outreach_message",
      entityId: messageId,
      metadata: { provider_message_id: providerMessageId, match_id: match.id },
    });
  } catch {
    return NextResponse.json({ error: "Email was sent but the delivery audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { id: messageId, status: "sent" } });
}
