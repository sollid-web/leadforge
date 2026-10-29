import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/api-auth";
import { getSalesManagerContext } from "@/lib/sales-auth";
import { ownerScraperCities, ownerScraperSourceSupportsCity, validateOwnerScraperSource } from "@/lib/scraper-worker";

const enableSchema = z.object({
  enabled: z.literal(true),
  authorizationConfirmed: z.literal(true),
  city: z.enum(ownerScraperCities),
  countryCode: z.literal("US"),
  resultLimit: z.number().int().min(1).max(50).default(20),
  cadenceHours: z.number().int().min(24).max(168).default(24),
  authorizationReference: z.string().trim().min(3).max(500),
  authorizationScope: z.string().trim().min(10).max(2000),
  authorizationExpiresAt: z.string().datetime({ offset: true }),
}).strict();

function safePolicy(policy: Record<string, unknown>) {
  return {
    id: policy.id,
    source_id: policy.source_id,
    city: policy.city,
    country_code: policy.country_code,
    result_limit: policy.result_limit,
    cadence_hours: policy.cadence_hours,
    authorization_scope: policy.authorization_scope,
    authorization_expires_at: policy.authorization_expires_at,
    authorization_reference_present: Boolean(policy.authorization_reference),
    enabled: policy.enabled,
    next_run_at: policy.next_run_at,
    last_run_id: policy.last_run_id,
    last_run_at: policy.last_run_at,
    last_run_status: policy.last_run_status,
    last_run_error: policy.last_run_error,
    approved_at: policy.approved_at,
    updated_at: policy.updated_at,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { id } = await params;
  const { data, error } = await result.context.admin.from("owner_discovery_policies")
    .select("id,source_id,city,country_code,result_limit,cadence_hours,authorization_reference,authorization_scope,authorization_expires_at,enabled,next_run_at,last_run_id,last_run_at,last_run_status,last_run_error,approved_at,updated_at")
    .eq("organization_id", result.context.organizationId)
    .eq("source_id", id)
    .order("city", { ascending: true });
  if (error) return NextResponse.json({ error: "Unable to load discovery authorization policies" }, { status: 500 });
  return NextResponse.json({ data: (data ?? []).map((policy) => safePolicy(policy as unknown as Record<string, unknown>)) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Invalid source ID" }, { status: 400 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (body?.enabled === false) {
    if (Object.keys(body).some((key) => key !== "enabled")) return NextResponse.json({ error: "To disable a policy, send only { enabled: false }." }, { status: 400 });
    const { data: policies, error: disableError } = await result.context.admin.from("owner_discovery_policies")
      .update({ enabled: false, next_run_at: null, lease_expires_at: null, updated_at: new Date().toISOString() })
      .eq("source_id", id).eq("organization_id", result.context.organizationId)
      .select("id,city");
    if (disableError) return NextResponse.json({ error: "Unable to disable discovery policy" }, { status: 500 });
    if (!policies?.length) return NextResponse.json({ error: "No discovery policy exists for this source" }, { status: 404 });
    try {
      await writeAuditLog(result.context.supabase, {
        organizationId: result.context.organizationId,
        actorId: result.context.userId,
        action: "owner_discovery.disabled",
        entityType: "listing_source",
        entityId: id,
        metadata: { policy_count: policies.length },
      });
    } catch {
      return NextResponse.json({ error: "Policy disabled but the audit record could not be written" }, { status: 500 });
    }
    return NextResponse.json({ data: { disabled: policies.length }, note: "An already-dispatched worker job may finish; no later run will be scheduled." });
  }

  const parsed = enableSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid owner-discovery authorization", details: parsed.error.flatten() }, { status: 400 });
  const authExpiresAt = new Date(parsed.data.authorizationExpiresAt);
  if (authExpiresAt.getTime() <= Date.now()) return NextResponse.json({ error: "Collection authorization must expire in the future." }, { status: 400 });
  const sourceResult = await result.context.admin.from("listing_sources")
    .select("id,organization_id,source_key,name,source_type,source_url,approved,active")
    .eq("id", id).eq("organization_id", result.context.organizationId).maybeSingle();
  if (sourceResult.error) return NextResponse.json({ error: "Unable to verify source configuration" }, { status: 500 });
  if (!sourceResult.data) return NextResponse.json({ error: "Source not found" }, { status: 404 });
  const sourceError = validateOwnerScraperSource(sourceResult.data);
  if (sourceError) return NextResponse.json({ error: sourceError }, { status: 409 });
  if (!ownerScraperSourceSupportsCity(sourceResult.data.source_key, parsed.data.city)) return NextResponse.json({ error: "This worker adapter does not have a configured search for the selected city." }, { status: 400 });

  const now = new Date().toISOString();
  const policyPayload = {
    organization_id: result.context.organizationId,
    source_id: id,
    city: parsed.data.city,
    country_code: parsed.data.countryCode,
    result_limit: parsed.data.resultLimit,
    cadence_hours: parsed.data.cadenceHours,
    authorization_reference: parsed.data.authorizationReference,
    authorization_scope: parsed.data.authorizationScope,
    authorization_expires_at: authExpiresAt.toISOString(),
    enabled: true,
    next_run_at: now,
    lease_expires_at: null,
    created_by: result.context.userId,
    approved_by: result.context.userId,
    approved_at: now,
    updated_at: now,
  };
  const { data, error } = await result.context.admin.from("owner_discovery_policies")
    .upsert(policyPayload, { onConflict: "source_id,city" })
    .select("id,source_id,city,country_code,result_limit,cadence_hours,authorization_reference,authorization_scope,authorization_expires_at,enabled,next_run_at,last_run_id,last_run_at,last_run_status,last_run_error,approved_at,updated_at")
    .single();
  if (error || !data) return NextResponse.json({ error: "Unable to save owner-discovery authorization" }, { status: 500 });
  try {
    await writeAuditLog(result.context.supabase, {
      organizationId: result.context.organizationId,
      actorId: result.context.userId,
      action: "owner_discovery.enabled",
      entityType: "listing_source",
      entityId: id,
      metadata: { city: parsed.data.city, country_code: parsed.data.countryCode, result_limit: parsed.data.resultLimit, cadence_hours: parsed.data.cadenceHours, authorization_expires_at: authExpiresAt.toISOString() },
    });
  } catch {
    return NextResponse.json({ error: "Policy saved but the audit record could not be written; disable it and resolve the audit issue before collection." }, { status: 500 });
  }
  return NextResponse.json({ data: safePolicy(data as unknown as Record<string, unknown>), note: "Policy is enabled and due for the next scheduled worker tick. Collection will begin only when the authorized scheduler is installed and configured." }, { status: 201 });
}
