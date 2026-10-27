import { NextResponse } from "next/server";
import { getSalesManagerContext } from "@/lib/sales-auth";

export const runtime = "nodejs";

function workerRunsUrl() {
  const raw = process.env.LEADFORGE_SCRAPER_WORKER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.pathname.replace(/\/+$/, "") !== "/runs" || url.search || url.hash || url.username || url.password) return null;
    url.pathname = "/runs";
    if (url.protocol === "https:") return url.toString().replace(/\/$/, "");
    if (process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return url.toString().replace(/\/$/, "");
  } catch { /* reject invalid configuration */ }
  return null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Invalid run ID" }, { status: 400 });
  const { context } = result;
  const { data: run, error } = await context.admin.from("listing_collection_runs")
    .select("id,status,provider,worker_artifact_name")
    .eq("id", id).eq("organization_id", context.organizationId).maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to verify worker run" }, { status: 500 });
  if (!run || run.provider !== "leadforge_scraper_worker") return NextResponse.json({ error: "Worker run not found" }, { status: 404 });
  if (!["completed", "degraded"].includes(run.status) || run.worker_artifact_name !== `${id}.csv`) return NextResponse.json({ error: "A complete or partial manifest is not available for this run" }, { status: 409 });
  const base = workerRunsUrl();
  const token = process.env.LEADFORGE_SCRAPER_WORKER_TOKEN;
  if (!base || !token) return NextResponse.json({ error: "Worker artifact service is not configured" }, { status: 503 });
  try {
    const response = await fetch(`${base}/${id}/artifact`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), cache: "no-store" });
    if (!response.ok) return NextResponse.json({ error: response.status === 404 ? "Worker artifact has expired or is unavailable" : "Unable to retrieve worker artifact" }, { status: response.status === 404 ? 404 : 502 });
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 10 * 1024 * 1024) return NextResponse.json({ error: "Worker artifact exceeds the download size limit" }, { status: 413 });
    const payload = await response.arrayBuffer();
    if (payload.byteLength > 10 * 1024 * 1024) return NextResponse.json({ error: "Worker artifact exceeds the download size limit" }, { status: 413 });
    await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: "scraper_run.artifact_downloaded", entity_type: "listing_collection_run", entity_id: id, metadata: { artifact_name: run.worker_artifact_name } });
    return new Response(payload, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="leadforge-${id}.csv"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({ error: "Worker artifact service timed out or could not connect" }, { status: 502 });
  }
}
