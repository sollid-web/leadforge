import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

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

function authorized(request: Request) {
  const expected = process.env.LEADFORGE_SCRAPER_WORKER_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function cleanError(message: string | undefined) {
  if (!message) return null;
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/\+?\d[\d ().-]{7,}\d/g, "[phone redacted]")
    .replace(/https?:\/\/\S+/gi, "[url redacted]")
    .slice(0, 500);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return NextResponse.json({ error: "Worker authentication failed" }, { status: 401 });
  const parsed = eventSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid worker event" }, { status: 400 });
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase worker callback is unavailable" }, { status: 503 });
  const { id } = await params;
  const { data: run, error: runError } = await admin.from("listing_collection_runs")
    .select("id,status,provider,organization_id,source_id").eq("id", id).maybeSingle();
  if (runError) return NextResponse.json({ error: "Unable to load worker run" }, { status: 500 });
  if (!run || run.provider !== "leadforge_scraper_worker") return NextResponse.json({ error: "Worker run not found" }, { status: 404 });
  if (run.status !== "running") return NextResponse.json({ error: "Worker run is already terminal" }, { status: 409 });
  const body = parsed.data;
  const terminal = body.event !== "progress";
  const counts = body.counts ?? {};
  const update = {
    status: terminal ? body.event : "running",
    discovered_count: counts.discovered,
    imported_count: counts.imported,
    duplicate_count: counts.duplicates,
    rejected_count: counts.rejected,
    contacts_found_count: counts.contactsFound,
    error_message: body.event === "failed" ? cleanError(body.errorMessage) ?? "Worker reported a failed run." : body.event === "degraded" ? cleanError(body.errorMessage) : null,
    completed_at: terminal ? new Date().toISOString() : null,
    worker_heartbeat_at: new Date().toISOString(),
    worker_progress: {
      stage: body.progress?.stage ?? body.event,
      message: body.progress?.message ? cleanError(body.progress.message) : body.event,
      pages_processed: body.progress?.pagesProcessed ?? null,
      rows_seen: body.progress?.rowsSeen ?? counts.discovered ?? null,
    },
    worker_artifact_name: body.artifactName ?? null,
  };
  const { error } = await admin.from("listing_collection_runs").update(update).eq("id", id).eq("status", "running");
  if (error) return NextResponse.json({ error: "Unable to persist worker event" }, { status: 500 });
  return NextResponse.json({ accepted: true, runId: id, terminal });
}
