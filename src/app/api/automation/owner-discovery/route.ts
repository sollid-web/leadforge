import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { assertPrivateDataEncryptionConfigured } from "@/lib/private-data";
import { hasValidBearer, ownerScraperSourceSupportsCity, trustedCallbackOrigin, validateOwnerScraperSource, workerRunsEndpoint, type WorkerSource } from "@/lib/scraper-worker";

export const runtime = "nodejs";

function safeText(value: unknown) {
  return typeof value === "string" ? value.slice(0, 160) : "";
}

export async function POST(request: Request) {
  if (!hasValidBearer(request, process.env.CRON_SECRET)) return NextResponse.json({ error: "Scheduler authentication failed" }, { status: 401 });
  const endpoint = workerRunsEndpoint();
  const token = process.env.LEADFORGE_SCRAPER_WORKER_TOKEN;
  const callbackOrigin = trustedCallbackOrigin();
  if (!endpoint || !token || token.length < 32 || !callbackOrigin) {
    return NextResponse.json({ error: "Trusted worker URL, worker token, and HTTPS callback origin must be configured before scheduling. No policy was claimed." }, { status: 503 });
  }
  try {
    assertPrivateDataEncryptionConfigured();
  } catch {
    return NextResponse.json({ error: "Valid contact-data encryption is required before scheduling. No policy was claimed." }, { status: 503 });
  }
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase service role is unavailable" }, { status: 503 });
  const { data, error } = await admin.rpc("claim_due_owner_discovery_policy");
  if (error) return NextResponse.json({ error: "Unable to claim a due owner-discovery policy" }, { status: 500 });
  const claim = Array.isArray(data) ? data[0] : null;
  if (!claim) return NextResponse.json({ dispatched: false, reason: "No enabled and authorized policy is due." });

  const source = {
    source_key: safeText(claim.source_key),
    name: safeText(claim.source_name),
    source_type: safeText(claim.source_type),
    source_url: typeof claim.source_url === "string" ? claim.source_url : null,
    approved: true,
    active: true,
  } satisfies WorkerSource;
  const sourceError = validateOwnerScraperSource(source)
    ?? (!ownerScraperSourceSupportsCity(source.source_key, safeText(claim.city)) ? "This worker adapter does not support the configured city." : null);
  const policyId = safeText(claim.policy_id);
  const runId = safeText(claim.run_id);
  const failClaim = async (message: string) => {
    const finishedAt = new Date().toISOString();
    await Promise.all([
      admin.from("listing_collection_runs").update({
        status: "failed",
        error_message: message,
        completed_at: finishedAt,
        worker_progress: { stage: "dispatch_failed", message },
      }).eq("id", runId),
      admin.from("owner_discovery_policies").update({
        lease_expires_at: null,
        last_run_status: "failed",
        last_run_error: message,
        updated_at: finishedAt,
      }).eq("id", policyId),
    ]);
  };
  if (sourceError) {
    await failClaim(sourceError);
    return NextResponse.json({ error: sourceError, runId }, { status: 409 });
  }
  const configuration = {
    policyId,
    sourceKey: source.source_key,
    sourceId: safeText(claim.source_id),
    sourceName: source.name,
    sourceType: source.source_type,
    sourceApproved: true,
    sourceActive: true,
    authorizationConfirmed: true,
    authorizationScope: typeof claim.authorization_scope === "string" ? claim.authorization_scope.slice(0, 2000) : "",
    authorizationExpiresAt: typeof claim.authorization_expires_at === "string" ? claim.authorization_expires_at : "",
    sourceUrl: source.source_url,
    countryCode: safeText(claim.country_code),
    city: safeText(claim.city),
    propertyType: "all",
    listingIntent: "sale",
    resultLimit: Number(claim.result_limit),
    scheduled: true,
    liveCollectionEnabled: process.env.LEADFORGE_SCRAPER_LIVE_COLLECTION_ENABLED === "true",
  };
  const { error: configError } = await admin.from("listing_collection_runs")
    .update({ worker_configuration: configuration })
    .eq("id", runId).eq("status", "running");
  if (configError) {
    const message = "Unable to persist worker dispatch configuration.";
    await failClaim(message);
    return NextResponse.json({ error: message, runId }, { status: 500 });
  }
  const callbackUrl = new URL(`/api/scraper-runs/${runId}/events`, callbackOrigin).toString();
  try {
    const dispatch = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        callbackUrl,
        configuration,
        authorizationReference: typeof claim.authorization_reference === "string" ? claim.authorization_reference.slice(0, 500) : "",
      }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (dispatch.status !== 202) {
      const message = `Worker dispatch failed with HTTP ${dispatch.status}.`;
      await failClaim(message);
      return NextResponse.json({ error: message, runId }, { status: 502 });
    }
  } catch {
    const message = "Worker dispatch timed out or could not connect.";
    await failClaim(message);
    return NextResponse.json({ error: message, runId }, { status: 502 });
  }
  return NextResponse.json({ dispatched: true, runId, sourceName: source.name, city: configuration.city, status: "running" }, { status: 202 });
}
