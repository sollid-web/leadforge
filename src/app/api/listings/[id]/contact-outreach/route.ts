import { createHash, createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { isValidSenderAddress } from "@/lib/email";
import { decryptPrivateData } from "@/lib/private-data";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const contactTypeSchema = z.enum(["listing_agent", "listing_office", "owner"]);
const permissionSchema = z.object({
  contactType: contactTypeSchema,
  status: z.enum(["permitted", "opted_out"]),
  lawfulBasis: z.string().trim().min(5).max(300).optional(),
  evidenceReference: z.string().trim().min(3).max(500).optional(),
  authorizationConfirmed: z.literal(true).optional(),
}).superRefine((value, context) => {
  if (value.status === "permitted" && (!value.lawfulBasis || !value.evidenceReference || value.authorizationConfirmed !== true)) {
    context.addIssue({ code: "custom", path: ["authorizationConfirmed"], message: "Permission or applicable lawful basis and its evidence must be recorded before outreach" });
  }
});

const sendSchema = z.object({
  contactType: contactTypeSchema,
  subject: z.string().trim().min(3).max(180).refine((value) => !/[\r\n]/.test(value), "Subject must be a single line"),
  message: z.string().trim().min(20).max(4000),
  confirmation: z.literal("send"),
});

type ContactType = z.infer<typeof contactTypeSchema>;
type PrivateListingDetails = Record<string, string>;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function recipientEmail(details: PrivateListingDetails, contactType: ContactType) {
  const email = contactType === "owner" ? details.ownerEmail
    : contactType === "listing_office" ? details.listingOfficeEmail
      : details.listingAgentEmail;
  return typeof email === "string" && z.string().email().safeParse(email).success ? email.trim() : null;
}

async function getManagerContext(listingId: string) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { response: NextResponse.json({ error: "Supabase is not configured" }, { status: 503 }) };
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { response: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return { response: NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 }) };
  if (!member) return { response: NextResponse.json({ error: "Manager permission required" }, { status: 403 }) };

  const { data: listing, error: listingError } = await supabase.from("listings")
    .select("id,organization_id,title,summary,source_id,status,suppressed_at,owners(verification_status)")
    .eq("id", listingId)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (listingError) return { response: NextResponse.json({ error: "Unable to load opportunity" }, { status: 500 }) };
  if (!listing) return { response: NextResponse.json({ error: "Opportunity not found" }, { status: 404 }) };
  if (listing.suppressed_at || listing.status === "suppressed") {
    return { response: NextResponse.json({ error: "Suppressed opportunities cannot be contacted" }, { status: 409 }) };
  }

  const { data: encrypted, error: privateError } = await supabase.from("listing_private_details")
    .select("ciphertext,iv,auth_tag")
    .eq("listing_id", listing.id)
    .eq("organization_id", member.organization_id)
    .maybeSingle();
  if (privateError) return { response: NextResponse.json({ error: "Unable to load private contact record" }, { status: 500 }) };
  let details: PrivateListingDetails = {};
  if (encrypted) {
    try {
      details = decryptPrivateData(encrypted);
    } catch {
      return { response: NextResponse.json({ error: "Private contact data could not be decrypted" }, { status: 500 }) };
    }
  }
  const owner = Array.isArray(listing.owners) ? listing.owners[0] : listing.owners;
  return { supabase, user, member, listing, details, owner };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await getManagerContext(id);
  if ("response" in context) return context.response;

  const { data: permissions, error: permissionError } = await context.supabase.from("listing_contact_permissions")
    .select("id,contact_type,status,lawful_basis,evidence_reference,reviewed_at")
    .eq("listing_id", context.listing.id)
    .eq("organization_id", context.member.organization_id);
  if (permissionError) return NextResponse.json({ error: "Unable to load contact permission status" }, { status: 500 });
  const { data: recentMessages, error: messagesError } = await context.supabase.from("listing_contact_outreach")
    .select("contact_type,status,sent_at")
    .eq("listing_id", context.listing.id)
    .eq("organization_id", context.member.organization_id)
    .order("created_at", { ascending: false });
  if (messagesError) return NextResponse.json({ error: "Unable to load contact outreach history" }, { status: 500 });

  const permissionByType = new Map((permissions ?? []).map((permission) => [permission.contact_type, permission]));
  const recentByType = new Map<string, { status: string; sent_at: string | null }>();
  for (const message of recentMessages ?? []) {
    if (!recentByType.has(message.contact_type)) recentByType.set(message.contact_type, message);
  }
  const owners = context.owner;
  const ownerVerified = owners?.verification_status === "verified";
  const contacts = (["listing_agent", "listing_office", "owner"] as const).map((contactType) => {
    const permission = permissionByType.get(contactType);
    const recent = recentByType.get(contactType);
    return {
      contactType,
      available: Boolean(recipientEmail(context.details, contactType)) && (contactType !== "owner" || ownerVerified),
      status: permission?.status ?? "unknown",
      lawfulBasis: permission?.lawful_basis ?? null,
      evidenceReference: permission?.evidence_reference ?? null,
      reviewedAt: permission?.reviewed_at ?? null,
      ownerVerified: contactType === "owner" ? ownerVerified : undefined,
      recentOutreachStatus: recent?.status ?? null,
      lastSentAt: recent?.sent_at ?? null,
    };
  });
  try {
    await writeAuditLog(context.supabase, {
      organizationId: context.member.organization_id,
      actorId: context.user.id,
      action: "listing.contact_outreach_options_viewed",
      entityType: "listing",
      entityId: context.listing.id,
      metadata: { contact_types_available: contacts.filter((contact) => contact.available).map((contact) => contact.contactType) },
    });
  } catch {
    return NextResponse.json({ error: "Contact options were not returned because the access audit could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { listing: { id: context.listing.id, title: context.listing.title }, contacts } }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = permissionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid contact permission decision", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const context = await getManagerContext(id);
  if ("response" in context) return context.response;
  const { contactType, status } = parsed.data;
  const email = recipientEmail(context.details, contactType);
  if (!email) return NextResponse.json({ error: "No valid email address is available for this contact" }, { status: 404 });
  if (contactType === "owner" && context.owner?.verification_status !== "verified") {
    return NextResponse.json({ error: "Owner outreach requires a verified owner record" }, { status: 409 });
  }

  const permissionValues = {
    organization_id: context.member.organization_id,
    listing_id: context.listing.id,
    contact_type: contactType,
    status,
    lawful_basis: status === "permitted" ? parsed.data.lawfulBasis : null,
    evidence_reference: status === "permitted" ? parsed.data.evidenceReference : null,
    reviewed_by: context.user.id,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data: permission, error: permissionError } = await context.supabase.from("listing_contact_permissions")
    .upsert(permissionValues, { onConflict: "listing_id,contact_type" })
    .select("id,status")
    .single();
  if (permissionError) return NextResponse.json({ error: "Unable to save contact permission status" }, { status: 500 });

  if (contactType === "owner") {
    const { data: owner, error: ownerError } = await context.supabase.from("owners")
      .select("id")
      .eq("listing_id", context.listing.id)
      .eq("organization_id", context.member.organization_id)
      .maybeSingle();
    if (ownerError) return NextResponse.json({ error: "Permission saved but the verified owner contact could not be loaded" }, { status: 500 });
    if (owner) {
      const { data: ownerContact, error } = await context.supabase.from("owner_contacts").update({
        contact_permission: status,
        opted_out_at: status === "opted_out" ? new Date().toISOString() : null,
      }).eq("owner_id", owner.id).eq("organization_id", context.member.organization_id).select("id").limit(1).maybeSingle();
      if (error) return NextResponse.json({ error: "Permission saved but owner contact controls could not be synchronized" }, { status: 500 });
      if (status === "permitted" && !ownerContact) return NextResponse.json({ error: "Permission saved but a stored owner contact record is required before outreach" }, { status: 409 });
    }
  }
  if (status === "opted_out") {
    const { error } = await context.supabase.from("listing_contact_opt_out_tokens")
      .update({ consumed_at: new Date().toISOString() })
      .eq("permission_id", permission.id)
      .is("consumed_at", null);
    if (error) return NextResponse.json({ error: "Opt-out saved but existing unsubscribe links could not be invalidated" }, { status: 500 });
  }
  try {
    await writeAuditLog(context.supabase, {
      organizationId: context.member.organization_id,
      actorId: context.user.id,
      action: status === "permitted" ? "listing.contact_permission_recorded" : "listing.contact_opted_out",
      entityType: "listing",
      entityId: context.listing.id,
      metadata: {
        contact_type: contactType,
        lawful_basis_recorded: status === "permitted",
        evidence_reference_recorded: Boolean(parsed.data.evidenceReference),
      },
    });
  } catch {
    return NextResponse.json({ error: "Contact permission changed but its audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { contactType, status: permission.status } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = sendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid message and explicit send confirmation are required", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const context = await getManagerContext(id);
  if ("response" in context) return context.response;

  const { contactType, subject, message } = parsed.data;
  const recipient = recipientEmail(context.details, contactType);
  if (!recipient) return NextResponse.json({ error: "No valid email address is available for this contact" }, { status: 404 });
  if (contactType === "owner" && context.owner?.verification_status !== "verified") {
    return NextResponse.json({ error: "Owner outreach requires a verified owner record" }, { status: 409 });
  }
  if (contactType === "owner") {
    const { data: owner, error: ownerError } = await context.supabase.from("owners")
      .select("id")
      .eq("listing_id", context.listing.id)
      .eq("organization_id", context.member.organization_id)
      .maybeSingle();
    if (ownerError) return NextResponse.json({ error: "Unable to validate verified owner contact permission" }, { status: 500 });
    if (!owner) return NextResponse.json({ error: "Verified owner record is required before owner outreach" }, { status: 409 });
    const { data: ownerContact, error: contactError } = await context.supabase.from("owner_contacts")
      .select("contact_permission,opted_out_at")
      .eq("owner_id", owner.id)
      .eq("organization_id", context.member.organization_id)
      .limit(1)
      .maybeSingle();
    if (contactError) return NextResponse.json({ error: "Unable to validate owner contact preference" }, { status: 500 });
    if (!ownerContact || ownerContact.contact_permission !== "permitted" || ownerContact.opted_out_at) {
      return NextResponse.json({ error: "Owner contact permission is unknown or opted out" }, { status: 409 });
    }
  }
  const { data: permission, error: permissionError } = await context.supabase.from("listing_contact_permissions")
    .select("id,status,lawful_basis,evidence_reference")
    .eq("listing_id", context.listing.id)
    .eq("organization_id", context.member.organization_id)
    .eq("contact_type", contactType)
    .maybeSingle();
  if (permissionError) return NextResponse.json({ error: "Unable to verify contact permission" }, { status: 500 });
  if (!permission || permission.status !== "permitted" || !permission.lawful_basis || !permission.evidence_reference) {
    return NextResponse.json({ error: "Record a valid permission or lawful basis with evidence before sending" }, { status: 409 });
  }
  const recipientFingerprint = createHash("sha256").update(recipient.toLocaleLowerCase("en")).digest("hex");
  const contentFingerprint = createHash("sha256").update(JSON.stringify({ subject, message: message.trim() })).digest("hex");
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentDuplicate, error: duplicateError } = await context.supabase.from("listing_contact_outreach")
    .select("id,status")
    .eq("listing_id", context.listing.id)
    .eq("recipient_fingerprint", recipientFingerprint)
    .in("status", ["processing", "sent"])
    .gte("created_at", cutoff)
    .limit(1)
    .maybeSingle();
  if (duplicateError) return NextResponse.json({ error: "Unable to check recent outreach" }, { status: 500 });
  if (recentDuplicate) return NextResponse.json({ error: recentDuplicate.status === "sent" ? "This contact was emailed about this listing in the last 7 days" : "An email to this contact is already processing" }, { status: 409 });

  const dayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: dailyCount, error: countError } = await context.supabase.from("listing_contact_outreach")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", context.member.organization_id)
    .in("status", ["processing", "sent"])
    .gte("created_at", dayCutoff);
  if (countError) return NextResponse.json({ error: "Unable to check workspace outreach limit" }, { status: 500 });
  if ((dailyCount ?? 0) >= 20) return NextResponse.json({ error: "Workspace limit reached: at most 20 listing-contact emails may be sent per 24 hours" }, { status: 429 });

  const { data: existingFailed, error: failedError } = await context.supabase.from("listing_contact_outreach")
    .select("id,content_fingerprint,contact_type")
    .eq("listing_id", context.listing.id)
    .eq("recipient_fingerprint", recipientFingerprint)
    .eq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (failedError) return NextResponse.json({ error: "Unable to check failed outreach attempts" }, { status: 500 });
  if (existingFailed && (existingFailed.contact_type !== contactType || existingFailed.content_fingerprint !== contentFingerprint)) {
    return NextResponse.json({ error: "A failed attempt exists for this contact and listing; retry with the same message or review the provider delivery status first" }, { status: 409 });
  }

  let messageId: string;
  if (existingFailed) {
    const { data, error } = await context.supabase.from("listing_contact_outreach").update({
      permission_id: permission.id,
      content_fingerprint: contentFingerprint,
      status: "processing",
      failure_reason: null,
      provider_message_id: null,
      sent_by: context.user.id,
      sent_at: null,
      created_at: new Date().toISOString(),
    }).eq("id", existingFailed.id).eq("status", "failed").select("id").maybeSingle();
    if (error) return NextResponse.json({ error: "Unable to prepare email retry" }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Another request is already processing this email" }, { status: 409 });
    messageId = data.id;
  } else {
    const { data, error } = await context.supabase.from("listing_contact_outreach").insert({
      organization_id: context.member.organization_id,
      listing_id: context.listing.id,
      permission_id: permission.id,
      contact_type: contactType,
      recipient_fingerprint: recipientFingerprint,
      content_fingerprint: contentFingerprint,
      status: "processing",
      sent_by: context.user.id,
    }).select("id").single();
    if (error) return NextResponse.json({ error: error.code === "23505" ? "An email to this contact is already processing" : "Unable to record outreach attempt" }, { status: error.code === "23505" ? 409 : 500 });
    messageId = data.id;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!apiKey || !from || !appUrl) {
    await context.supabase.from("listing_contact_outreach").update({ status: "failed", failure_reason: "Email provider is not configured" }).eq("id", messageId);
    return NextResponse.json({ error: "Email is not configured. Set RESEND_API_KEY, RESEND_FROM_EMAIL, and NEXT_PUBLIC_APP_URL." }, { status: 503 });
  }
  const parsedAppUrl = z.string().url().safeParse(appUrl);
  if (!isValidSenderAddress(from) || !parsedAppUrl.success || new URL(appUrl).protocol !== "https:" && process.env.NODE_ENV === "production") {
    await context.supabase.from("listing_contact_outreach").update({ status: "failed", failure_reason: "Email configuration is invalid" }).eq("id", messageId);
    return NextResponse.json({ error: "Email sender or public app URL configuration is invalid" }, { status: 503 });
  }

  const token = createHmac("sha256", apiKey).update(`listing-contact-opt-out:${messageId}`).digest("base64url");
  const unsubscribeUrl = new URL(`/api/contact-outreach/opt-out?token=${encodeURIComponent(token)}`, appUrl).toString();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: existingToken, error: tokenQueryError } = await context.supabase.from("listing_contact_opt_out_tokens")
    .select("token_hash,consumed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (tokenQueryError) return NextResponse.json({ error: "Unable to prepare an opt-out link; no email was sent" }, { status: 500 });
  if (existingToken?.consumed_at) return NextResponse.json({ error: "This contact has opted out; outreach is blocked" }, { status: 409 });
  const tokenWrite = existingToken
    ? await context.supabase.from("listing_contact_opt_out_tokens").update({
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq("token_hash", tokenHash).is("consumed_at", null)
    : await context.supabase.from("listing_contact_opt_out_tokens").insert({
      token_hash: tokenHash,
      permission_id: permission.id,
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    });
  const { error: tokenError } = tokenWrite;
  if (tokenError) {
    await context.supabase.from("listing_contact_outreach").update({ status: "failed", failure_reason: "Opt-out link could not be created" }).eq("id", messageId);
    return NextResponse.json({ error: "Unable to prepare an opt-out link; no email was sent" }, { status: 500 });
  }

  try {
    await writeAuditLog(context.supabase, {
      organizationId: context.member.organization_id,
      actorId: context.user.id,
      action: "listing.contact_outreach_send_confirmed",
      entityType: "listing_contact_outreach",
      entityId: messageId,
      metadata: { contact_type: contactType, lawful_basis_recorded: true },
    });
  } catch {
    await context.supabase.from("listing_contact_outreach").update({ status: "failed", failure_reason: "Send confirmation could not be audited" }).eq("id", messageId);
    await context.supabase.from("listing_contact_opt_out_tokens").update({ consumed_at: new Date().toISOString() }).eq("token_hash", tokenHash);
    return NextResponse.json({ error: "Email was not sent because the send confirmation could not be audited" }, { status: 500 });
  }

  const text = `${message.trim()}\n\nIf you do not want further email about this property, opt out here: ${unsubscribeUrl}`;
  const html = `<div>${escapeHtml(message.trim()).replace(/\n/g, "<br>")}</div><p><small>If you do not want further email about this property, <a href="${escapeHtml(unsubscribeUrl)}">opt out here</a>.</small></p>`;
  let providerMessageId: string | null = null;
  let sendFailed = false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `leadforge-contact-${messageId}`,
      },
      body: JSON.stringify({ from, to: [recipient], subject, text, html }),
      signal: AbortSignal.timeout(12000),
    });
    const result = await response.json().catch(() => ({})) as { id?: string };
    if (!response.ok) throw new Error("Provider request failed");
    providerMessageId = result.id ?? null;
  } catch {
    sendFailed = true;
  }

  const { error: updateError } = await context.supabase.from("listing_contact_outreach").update({
    status: sendFailed ? "failed" : "sent",
    sent_at: sendFailed ? null : new Date().toISOString(),
    provider_message_id: providerMessageId,
    failure_reason: sendFailed ? "Email provider request failed" : null,
  }).eq("id", messageId).eq("status", "processing");
  if (updateError) {
    return NextResponse.json({ error: "Provider response received but delivery status could not be saved; inspect the provider before retrying" }, { status: 500 });
  }

  try {
    await writeAuditLog(context.supabase, {
      organizationId: context.member.organization_id,
      actorId: context.user.id,
      action: sendFailed ? "listing.contact_outreach_send_failed" : "listing.contact_outreach_sent",
      entityType: "listing_contact_outreach",
      entityId: messageId,
      metadata: { contact_type: contactType, provider_message_id: providerMessageId },
    });
  } catch {
    return NextResponse.json({ error: sendFailed ? "Email failed and its failure audit could not be written" : "Email was sent but its delivery audit could not be written" }, { status: 500 });
  }
  if (sendFailed) return NextResponse.json({ error: "Email provider could not send this message; retry is available" }, { status: 502 });
  return NextResponse.json({ data: { id: messageId, status: "sent" } });
}
