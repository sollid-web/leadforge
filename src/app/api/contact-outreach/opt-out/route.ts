import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const tokenSchema = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
const message = (body: string, status = 200) => new NextResponse(body, {
  status,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
});

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!tokenSchema.safeParse(token).success) return message("<!doctype html><title>Opt out unavailable</title><p>This opt-out link is invalid or expired.</p>", 400);
  const supabase = getSupabaseAdminClient();
  if (!supabase) return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data, error } = await supabase.from("listing_contact_opt_out_tokens")
    .select("token_hash,expires_at,consumed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);
  if (!data || data.consumed_at || Date.parse(data.expires_at) <= Date.now()) {
    return message("<!doctype html><title>Opt out</title><p>This opt-out link is invalid, expired, or has already been used.</p>", 410);
  }
  return message(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Confirm opt out</title><body><main><h1>Stop property-related emails</h1><p>Confirm to stop further email outreach about this property.</p><form method="post"><input type="hidden" name="token" value="${token}"><button type="submit">Confirm opt out</button></form></main></body></html>`);
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const token = form?.get("token");
  if (typeof token !== "string" || !tokenSchema.safeParse(token).success) {
    return message("<!doctype html><title>Opt out unavailable</title><p>This opt-out link is invalid or expired.</p>", 400);
  }
  const supabase = getSupabaseAdminClient();
  if (!supabase) return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: optOut, error: tokenError } = await supabase.from("listing_contact_opt_out_tokens")
    .select("token_hash,permission_id,expires_at,consumed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (tokenError) return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);
  if (!optOut || Date.parse(optOut.expires_at) <= Date.now()) {
    return message("<!doctype html><title>Opt out</title><p>This opt-out link is invalid or expired.</p>", 410);
  }
  if (optOut.consumed_at) return message("<!doctype html><title>Opt out complete</title><p>This contact has already been opted out.</p>");

  const { data: permission, error: permissionError } = await supabase.from("listing_contact_permissions")
    .select("id,organization_id,listing_id,contact_type")
    .eq("id", optOut.permission_id)
    .maybeSingle();
  if (permissionError || !permission) {
    return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);
  }

  const { error: updateError } = await supabase.from("listing_contact_permissions").update({
    status: "opted_out",
    lawful_basis: null,
    evidence_reference: null,
    reviewed_by: null,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", permission.id);
  if (updateError) return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);

  if (permission.contact_type === "owner") {
    const { data: owner, error: ownerError } = await supabase.from("owners")
      .select("id")
      .eq("listing_id", permission.listing_id)
      .eq("organization_id", permission.organization_id)
      .maybeSingle();
    if (ownerError) return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);
    if (owner) {
      const { error } = await supabase.from("owner_contacts").update({
        contact_permission: "opted_out",
        opted_out_at: new Date().toISOString(),
      }).eq("owner_id", owner.id).eq("organization_id", permission.organization_id);
      if (error) return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);
    }
  }

  const { error: consumeError } = await supabase.from("listing_contact_opt_out_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("token_hash", tokenHash)
    .is("consumed_at", null);
  if (consumeError) return message("<!doctype html><title>Opt out unavailable</title><p>Opt-out service is temporarily unavailable. Please reply to the email and request removal.</p>", 503);

  const { error: auditError } = await supabase.from("audit_logs").insert({
    organization_id: permission.organization_id,
    actor_id: null,
    action: "listing.contact_opted_out",
    entity_type: "listing",
    entity_id: permission.listing_id,
    metadata: { contact_type: permission.contact_type, source: "email_opt_out_link" },
  });
  if (auditError) return message("<!doctype html><title>Opt out recorded</title><p>Your opt-out was recorded, but the audit record could not be completed. Please contact the workspace administrator.</p>", 500);
  return message("<!doctype html><title>Opt out complete</title><p>You will not receive further property-related email from this workspace.</p>");
}
