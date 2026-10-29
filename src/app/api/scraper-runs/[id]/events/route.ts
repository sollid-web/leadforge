import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { ingestScraperManifest } from "@/lib/scraper-manifest-ingestion";
import { hasValidBearer, ownerScraperSourceSupportsCity, validateOwnerScraperSource, workerRunsEndpoint, type WorkerSource } from "@/lib/scraper-worker";

export const runtime = "nodejs";

const eventSchema = z.object({
  event: z.enum(["progress", "completed", "degraded", "failed"]),
  progress: z.object({
    stage: z.string().trim().min(1).max(80),
    message: z.string().trim().max(240).optional(),
    pagesProcessed: z.number().int().min(0).max(10000).optional(),
    rowsSeen: z.number().int().min(0).max(100000).optional(),
  }).strict().optional(),
  counts: z.object({
    discovered: z.number().int().min(0).max(100000).optional(),
    imported: z.number().int().min(0).max(100000).optional(),
    duplicates: z.number().int().min(0).max(100000).optional(),
    rejected: z.number().int().min(0).max(100000).optional(),
    contactsFound: z.number().int().min(0).max(100000).optional(),
  }).strict().optional(),
  errorMessage: z.string().trim().max(1000).optional(),
  artifactName: z.string().regex(/^[A-Za-z0-9._-]{1,160}$/).optional(),
}).strict();

function cleanError(message: string | undefined) {
  if (!message) return null;
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/\+?\d[\d ().-]{7,}\d/g, "[phone redacted]")
    .replace(/https?:\/\/\S+/gi, "[url redacted]")
    .slice(0, 500);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function finishPolicy(admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>, policyId: unknown, status: "completed" | "degraded" | "failed", errorMessage: string | null) {
  if (!isUuid(policyId)) return;
  await admin.from("owner_discovery_policies").update({
    lease_expires_at: null,
    last_run_status: status,
    last_run_error: errorMessage,
    updated_at: new Date().toISOString(),
  }).eq("id", policyId);
}

async function updateSourceHealth(admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>, organizationId: string, sourceId: string, status: "healthy" | "degraded" | "failed", message: string | null) {
  const { data: current } = await admin.from("source_health").select("consecutive_failures").eq("source_id", sourceId).maybeSingle();
  const failures = status === "healthy" ? 0 : Math.min(1000, (current?.consecutive_failures ?? 0) + 1);
  await admin.from("source_health").upsert({
    organization_id: organizationId,
    source_id: sourceId,
    status,
    last_checked_at: new Date().toISOString(),
    ...(status === "healthy" ? { last_success_at: new Date().toISOString() } : {}),
    consecutive_failures: failures,
    message,
  }, { onConflict: "source_id" });
}

async function getArtifact(runId: string, expectedName: string) {
  const endpoint = workerRunsEndpoint();
  const token = process.env.LEADFORGE_SCRAPER_WORKER_TOKEN;
  if (!endpoint || !token || expectedName !== `${runId}.csv`) throw new Error("A valid worker manifest is not available for ingestion.");
  const response = await fetch(`${endpoint}/${runId}/artifact`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(response.status === 404 ? "Worker manifest is unavailable or expired." : "Unable to retrieve the worker manifest.");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 10 * 1024 * 1024) throw new Error("Worker manifest exceeds the 10 MB size limit.");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Worker manifest exceeds the 10 MB size limit.");
  return Buffer.from(bytes).toString("utf8");
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidBearer(request, process.env.LEADFORGE_SCRAPER_WORKER_TOKEN)) return NextResponse.json({ error: "Worker authentication failed" }, { status: 401 });
  const parsed = eventSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid worker event" }, { status: 400 });
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase worker callback is unavailable" }, { status: 503 });
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Invalid run ID" }, { status: 400 });
  const { data: run, error: runError } = await admin.from("listing_collection_runs")
    .select("id,status,provider,organization_id,source_id,worker_configuration,worker_manifest_ingest_status,worker_artifact_name")
    .eq("id", id).maybeSingle();
  if (runError) return NextResponse.json({ error: "Unable to load worker run" }, { status: 500 });
  if (!run || run.provider !== "leadforge_scraper_worker") return NextResponse.json({ error: "Worker run not found" }, { status: 404 });
  if (run.status !== "running") return NextResponse.json({ error: "Worker run is already terminal" }, { status: 409 });

  const body = parsed.data;
  const terminal = body.event !== "progress";
  const counts = body.counts ?? {};
  const now = new Date().toISOString();
  const configuration = (run.worker_configuration ?? {}) as Record<string, unknown>;
  const policyId = configuration.policyId;
  const safeProgress = {
    stage: body.progress?.stage ?? body.event,
    message: body.progress?.message ? cleanError(body.progress.message) : body.event,
    pages_processed: body.progress?.pagesProcessed ?? null,
    rows_seen: body.progress?.rowsSeen ?? counts.discovered ?? null,
  };

  if (!terminal) {
    const { error } = await admin.from("listing_collection_runs").update({
      status: "running",
      discovered_count: counts.discovered,
      imported_count: counts.imported,
      duplicate_count: counts.duplicates,
      rejected_count: counts.rejected,
      contacts_found_count: counts.contactsFound,
      worker_heartbeat_at: now,
      worker_progress: safeProgress,
    }).eq("id", id).eq("status", "running");
    if (error) return NextResponse.json({ error: "Unable to persist worker progress" }, { status: 500 });
    return NextResponse.json({ accepted: true, runId: id, terminal: false });
  }

  if (body.event === "failed") {
    const message = cleanError(body.errorMessage) ?? "Worker reported a failed run.";
    const { error } = await admin.from("listing_collection_runs").update({
      status: "failed",
      discovered_count: counts.discovered ?? 0,
      imported_count: 0,
      duplicate_count: 0,
      rejected_count: counts.rejected ?? 0,
      contacts_found_count: counts.contactsFound ?? 0,
      error_message: message,
      completed_at: now,
      worker_heartbeat_at: now,
      worker_progress: safeProgress,
      worker_artifact_name: body.artifactName ?? null,
      worker_manifest_ingest_status: "failed",
      worker_manifest_ingest_error: message,
    }).eq("id", id).eq("status", "running");
    if (error) return NextResponse.json({ error: "Unable to persist failed worker state" }, { status: 500 });
    await Promise.all([
      finishPolicy(admin, policyId, "failed", message),
      updateSourceHealth(admin, run.organization_id, run.source_id, "failed", message),
    ]);
    return NextResponse.json({ accepted: true, runId: id, terminal: true, ingested: false });
  }

  if (body.event === "degraded") {
    const message = "Partial worker output requires manager review and was not automatically ingested.";
    const { error } = await admin.from("listing_collection_runs").update({
      status: "degraded",
      discovered_count: counts.discovered ?? 0,
      imported_count: 0,
      duplicate_count: 0,
      rejected_count: counts.rejected ?? 0,
      contacts_found_count: counts.contactsFound ?? 0,
      error_message: message,
      completed_at: now,
      worker_heartbeat_at: now,
      worker_progress: { ...safeProgress, message },
      worker_artifact_name: body.artifactName ?? null,
      worker_manifest_ingest_status: "failed",
      worker_manifest_ingest_error: message,
    }).eq("id", id).eq("status", "running");
    if (error) return NextResponse.json({ error: "Unable to persist degraded worker state" }, { status: 500 });
    await Promise.all([
      finishPolicy(admin, policyId, "degraded", message),
      updateSourceHealth(admin, run.organization_id, run.source_id, "degraded", message),
    ]);
    return NextResponse.json({ accepted: true, runId: id, terminal: true, ingested: false });
  }

  if (body.progress?.stage === "dry_run") {
    const { error } = await admin.from("listing_collection_runs").update({
      status: "completed",
      discovered_count: 0,
      imported_count: 0,
      duplicate_count: 0,
      rejected_count: 0,
      contacts_found_count: 0,
      error_message: null,
      completed_at: now,
      worker_heartbeat_at: now,
      worker_progress: { stage: "dry_run", message: "Worker validation completed; no source was contacted and no leads were imported." },
      worker_artifact_name: null,
      worker_manifest_ingest_status: "completed",
      worker_manifest_ingest_error: null,
    }).eq("id", id).eq("status", "running");
    if (error) return NextResponse.json({ error: "Unable to persist worker dry-run result" }, { status: 500 });
    await finishPolicy(admin, policyId, "completed", null);
    return NextResponse.json({ accepted: true, runId: id, terminal: true, dryRun: true, ingested: false });
  }
  const rejectCompletion = async (message: string) => {
    const completedAt = new Date().toISOString();
    const { error } = await admin.from("listing_collection_runs").update({
      status: "failed",
      error_message: message,
      completed_at: completedAt,
      worker_heartbeat_at: completedAt,
      worker_progress: { stage: "failed", message },
      worker_manifest_ingest_status: "failed",
      worker_manifest_ingest_error: message,
    }).eq("id", id).eq("status", "running");
    if (error) return NextResponse.json({ error: "Unable to persist rejected worker completion" }, { status: 500 });
    await Promise.all([
      finishPolicy(admin, policyId, "failed", message),
      updateSourceHealth(admin, run.organization_id, run.source_id, "degraded", message),
    ]);
    return NextResponse.json({ error: message, runId: id }, { status: 409 });
  };
  if (configuration.liveCollectionEnabled !== true) return rejectCompletion("LeadForge live collection is disabled; artifact was not ingested.");
  if (body.artifactName !== `${id}.csv`) return rejectCompletion("Completed worker event has no valid manifest artifact.");
  if (configuration.authorizationConfirmed !== true) return rejectCompletion("Run has no recorded collection authorization confirmation.");
  const { data: claim, error: claimError } = await admin.from("listing_collection_runs").update({
    worker_manifest_ingest_status: "processing",
    worker_manifest_ingest_started_at: now,
    worker_manifest_ingest_error: null,
    worker_artifact_name: body.artifactName,
    worker_heartbeat_at: now,
    worker_progress: { stage: "ingesting", message: "Securely importing authorized owner-seller candidates" },
  }).eq("id", id).eq("status", "running").eq("worker_manifest_ingest_status", "pending").select("id").maybeSingle();
  if (claimError) return NextResponse.json({ error: "Unable to claim manifest ingestion" }, { status: 500 });
  if (!claim) return NextResponse.json({ error: "Manifest ingestion is already claimed or complete" }, { status: 409 });

  try {
    const { data: source, error: sourceError } = await admin.from("listing_sources")
      .select("id,name,source_key,source_type,source_url,approved,active")
      .eq("id", run.source_id).eq("organization_id", run.organization_id).maybeSingle();
    if (sourceError || !source) throw new Error("Unable to validate the authorized listing source.");
    const adapterError = validateOwnerScraperSource(source as WorkerSource);
    if (adapterError) throw new Error(adapterError);
    if (configuration.scheduled === true) {
      const scope = typeof configuration.authorizationScope === "string" ? configuration.authorizationScope.trim() : "";
      const expiresAt = typeof configuration.authorizationExpiresAt === "string" ? Date.parse(configuration.authorizationExpiresAt) : NaN;
      if (scope.length < 10 || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new Error("Recorded collection authorization is missing or expired; manifest was not ingested.");
      }
    }
    const resultLimit = Number(configuration.resultLimit);
    const city = typeof configuration.city === "string" ? configuration.city : "";
    const countryCode = typeof configuration.countryCode === "string" ? configuration.countryCode : "";
    if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 50 || !city || countryCode !== "US") {
      throw new Error("Run scope is missing or exceeds the approved worker capabilities.");
    }
    if (!ownerScraperSourceSupportsCity(source.source_key, city)) throw new Error("Configured source does not support this city; manifest was not ingested.");
    const csvText = await getArtifact(id, body.artifactName);
    const ingestion = await ingestScraperManifest({
      admin,
      organizationId: run.organization_id,
      runId: id,
      source,
      expectedCity: city,
      expectedCountryCode: countryCode,
      maxRows: resultLimit,
      csvText,
    });
    const completedAt = new Date().toISOString();
    const { error: finishError } = await admin.from("listing_collection_runs").update({
      status: "completed",
      discovered_count: ingestion.discovered,
      imported_count: ingestion.imported,
      duplicate_count: ingestion.duplicates,
      rejected_count: ingestion.rejected,
      held_count: ingestion.held,
      contacts_found_count: ingestion.contactsFound,
      error_message: null,
      completed_at: completedAt,
      worker_heartbeat_at: completedAt,
      worker_progress: {
        stage: "ingested",
        message: "Authorized manifest processed; owner candidates remain unverified and ambiguous records are held for manager review.",
        pages_processed: body.progress?.pagesProcessed ?? null,
        rows_seen: ingestion.discovered,
        rejection_reasons: ingestion.rejectionReasons,
      },
      worker_artifact_name: body.artifactName,
      worker_manifest_ingest_status: "completed",
      worker_manifest_ingested_at: completedAt,
      worker_manifest_digest: ingestion.digest,
      worker_manifest_ingest_error: null,
    }).eq("id", id).eq("status", "running");
    if (finishError) throw new Error("Manifest was processed but run completion could not be recorded.");
    await Promise.all([
      finishPolicy(admin, policyId, "completed", null),
      updateSourceHealth(admin, run.organization_id, run.source_id, "healthy", null),
    ]);
    return NextResponse.json({ accepted: true, runId: id, terminal: true, ingested: true, counts: {
      discovered: ingestion.discovered,
      imported: ingestion.imported,
      duplicates: ingestion.duplicates,
      rejected: ingestion.rejected,
      held: ingestion.held,
      contactsFound: ingestion.contactsFound,
    } });
  } catch (error) {
    const message = cleanError(error instanceof Error ? error.message : "Manifest ingestion failed.") ?? "Manifest ingestion failed.";
    const failedAt = new Date().toISOString();
    await Promise.all([
      admin.from("listing_collection_runs").update({
        status: "failed",
        error_message: message,
        completed_at: failedAt,
        worker_heartbeat_at: failedAt,
        worker_progress: { stage: "ingest_failed", message },
        worker_manifest_ingest_status: "failed",
        worker_manifest_ingest_error: message,
      }).eq("id", id).eq("status", "running"),
      finishPolicy(admin, policyId, "failed", message),
      updateSourceHealth(admin, run.organization_id, run.source_id, "failed", message),
    ]);
    return NextResponse.json({ error: message, runId: id, ingested: false }, { status: 500 });
  }
}
