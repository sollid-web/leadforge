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
  rentcast: z.object({
    listingType: z.enum(["sale", "rental"]),
    city: z.string().trim().min(2).max(120).optional(),
    state: z.string().trim().length(2).toUpperCase().regex(/^[A-Z]{2}$/).optional(),
    zipCode: z.string().trim().regex(/^\d{5}$/).optional(),
    maxResults: z.number().int().min(1).max(100).default(50),
  }).optional().refine((value) => {
    if (!value) return true;
    const hasZip = Boolean(value.zipCode);
    const hasCityAndState = Boolean(value.city && value.state);
    return hasZip !== hasCityAndState && !(hasZip && (value.city || value.state));
  }, {
    message: "Configure either a ZIP code or both city and state",
  }),
  untera: z.object({}).optional(),
  optOutInstructions: z.string().trim().max(1000).optional(),
}).superRefine((value, context) => {
  const apiConfigCount = Number(Boolean(value.rentcast)) + Number(Boolean(value.untera));
  if (value.sourceType === "public_api" && apiConfigCount !== 1) {
    context.addIssue({ code: "custom", path: ["rentcast"], message: "Select exactly one public API provider configuration" });
  }
  if (value.sourceType !== "public_api" && apiConfigCount > 0) {
    context.addIssue({ code: "custom", path: ["rentcast"], message: "Provider settings are only supported for public API sources" });
  }
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
    .select("id,name,source_key,source_type,source_url,configuration,approved,active,opt_out_instructions,created_at,source_health(status,last_checked_at,last_success_at,last_sync_attempt_at,consecutive_failures,message)")
    .eq("organization_id", member.organization_id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Unable to load sources" }, { status: 500 });
  return NextResponse.json({ canManage: ["owner", "admin", "manager"].includes(member.role), data });
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

  const builtInSourceKeys: Record<string, string> = {
    craigslist: "craigslist",
    "forsalebyowner.com": "forsalebyowner",
    "byowner.com": "byowner",
  };
  const normalizedSourceName = parsed.data.name.toLocaleLowerCase("en");
  const sourceKey = builtInSourceKeys[normalizedSourceName]
    ?? normalizedSourceName.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const manual = parsed.data.sourceType === "manual";
  const apiSource = parsed.data.sourceType === "public_api";
  const ingestionToken = manual || apiSource ? null : randomBytes(32).toString("base64url");
  const provider = parsed.data.untera ? "untera" : parsed.data.rentcast ? "rentcast" : null;
  const configuration = provider === "untera"
    ? { provider }
    : provider === "rentcast"
      ? { provider, ...parsed.data.rentcast }
      : {};
  const { data, error } = await supabase.from("listing_sources").insert({
    organization_id: member.organization_id,
    name: parsed.data.name,
    source_key: sourceKey,
    source_type: parsed.data.sourceType,
    source_url: apiSource ? provider === "untera" ? "https://api.untera.io" : "https://api.rentcast.io" : parsed.data.sourceUrl ?? null,
    configuration,
    ingestion_token_hash: ingestionToken ? createHash("sha256").update(ingestionToken).digest("hex") : null,
    approved: manual,
    active: manual,
    opt_out_instructions: parsed.data.optOutInstructions ?? null,
    created_by: user.id,
  }).select("id,name,source_key,source_type,source_url,configuration,approved,active,created_at").single();
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
      ...(apiSource && provider === "rentcast" ? { setupInstructions: "Configure RENTCAST_API_KEY on the server, then an owner/admin must approve the source. Scheduled sync runs at most once per source every 24 hours." } : {}),
      ...(apiSource && provider === "untera" ? { setupInstructions: "Configure UNTERA_API_KEY and confirm commercial-use and listing-reuse authorization on the server. An owner/admin must approve this source before live search." } : {}),
      ...(ingestionToken ? { ingestionToken } : {}),
    }, { status: 500 });
  }
  return NextResponse.json({
    data,
    ...(apiSource && provider === "untera" ? { setupInstructions: "Configure UNTERA_API_KEY and confirm commercial-use and listing-reuse authorization on the server. An owner/admin must approve this source before live search." } : {}),
    ...(ingestionToken ? { ingestionToken, tokenInstructions: "Copy this token now; it is shown only once. Configure it as the Bearer credential in the approved source or n8n." } : {}),
  }, { status: 201 });
}
