import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const sourceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  sourceType: z.enum(["manual", "approved_feed", "partner_feed", "public_api"]),
  sourceUrl: z.string().url().max(2048).refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  }, "Source URL must use HTTPS and must not contain credentials").optional(),
  optOutInstructions: z.string().trim().max(1000).optional(),
});

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });
  const { data, error } = await supabase.from("listing_sources")
    .select("id,name,source_key,source_type,source_url,approved,active,opt_out_instructions,created_at,source_health(status,last_checked_at,last_success_at,consecutive_failures,message)")
    .eq("organization_id", member.organization_id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Unable to load sources" }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const parsed = sourceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid source payload", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });

  const sourceKey = parsed.data.name.toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const manual = parsed.data.sourceType === "manual";
  const ingestionToken = manual ? null : randomBytes(32).toString("base64url");
  const { data, error } = await supabase.from("listing_sources").insert({
    organization_id: member.organization_id,
    name: parsed.data.name,
    source_key: sourceKey,
    source_type: parsed.data.sourceType,
    source_url: parsed.data.sourceUrl ?? null,
    ingestion_token_hash: ingestionToken ? createHash("sha256").update(ingestionToken).digest("hex") : null,
    approved: manual,
    active: manual,
    opt_out_instructions: parsed.data.optOutInstructions ?? null,
    created_by: user.id,
  }).select("id,name,source_key,source_type,source_url,approved,active,created_at").single();
  if (error) return NextResponse.json({ error: error.code === "23505" ? "A source with this name already exists" : "Unable to create source" }, { status: error.code === "23505" ? 409 : 500 });
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "source.created",
      entityType: "listing_source",
      entityId: data.id,
      metadata: { source_type: data.source_type, initially_approved: manual },
    });
  } catch {
    return NextResponse.json({
      error: "Source was created but the audit record could not be written; retain the token below and resolve the audit issue before enabling the source",
      data,
      ...(ingestionToken ? { ingestionToken } : {}),
    }, { status: 500 });
  }
  return NextResponse.json({
    data,
    ...(ingestionToken ? { ingestionToken, tokenInstructions: "Copy this token now; it is shown only once. Configure it as the Bearer credential in the approved source or n8n." } : {}),
  }, { status: 201 });
}
