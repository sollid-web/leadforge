import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const tokenSchema = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
const html = (body: string, status = 200) => new NextResponse(
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LeadForge email preferences</title><body><main>${body}</main></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
);

async function applyOptOut(token: string) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return { error: "Email preference service is temporarily unavailable.", status: 503 };
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: record, error: tokenError } = await supabase.from("business_prospect_opt_out_tokens")
    .select("token_hash,organization_id,prospect_id,email_fingerprint,expires_at,consumed_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (tokenError) return { error: "Email preference service is temporarily unavailable.", status: 503 };
  if (!record || Date.parse(record.expires_at) <= Date.now()) return { error: "This opt-out link is invalid or expired.", status: 410 };
  if (record.consumed_at) return { error: null, status: 200 };

  const { error: preferenceError } = await supabase.from("business_prospect_email_opt_outs").upsert({
    organization_id: record.organization_id,
    email_fingerprint: record.email_fingerprint,
    source: "email_link",
  }, { onConflict: "organization_id,email_fingerprint", ignoreDuplicates: true });
  if (preferenceError) return { error: "Your email preference could not be saved. Please reply to the email and ask to stop future messages.", status: 503 };
  const { error: auditError } = await supabase.from("audit_logs").insert({
    organization_id: record.organization_id,
    actor_id: null,
    action: "business_prospect.email_opted_out",
    entity_type: "business_prospect",
    entity_id: record.prospect_id,
    metadata: { source: "email_opt_out_link", email_fingerprint: record.email_fingerprint },
  });
  if (auditError && auditError.code !== "23505") return { error: "Your email preference was saved but its audit event could not be recorded.", status: 503 };
  const { error: consumedError } = await supabase.from("business_prospect_opt_out_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("token_hash", tokenHash)
    .is("consumed_at", null);
  if (consumedError) return { error: "Your email preference was saved but could not be confirmed.", status: 503 };
  return { error: null, status: 200 };
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!tokenSchema.safeParse(token).success) return html("<h1>Opt-out unavailable</h1><p>This email preference link is invalid.</p>", 400);
  return html(`<h1>Stop future business emails</h1><p>Confirm to stop this workspace from emailing this address about business offers.</p><form method="post"><input type="hidden" name="token" value="${token}"><button type="submit">Confirm opt out</button></form>`);
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  let token = new URL(request.url).searchParams.get("token") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const formToken = form?.get("token");
    if (typeof formToken === "string") token = formToken;
  }
  if (!tokenSchema.safeParse(token).success) return html("<h1>Opt-out unavailable</h1><p>This email preference link is invalid.</p>", 400);

  const result = await applyOptOut(token);
  if (result.error) return html(`<h1>Opt-out unavailable</h1><p>${result.error}</p><p>Please reply to the email and ask to stop future messages.</p>`, result.status);
  return html("<h1>Opt-out recorded</h1><p>This workspace will not send further business emails to this address.</p>");
}
