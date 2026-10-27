import { NextResponse } from "next/server";
import { z } from "zod";
import { getSalesManagerContext } from "@/lib/sales-auth";

const runSchema = z.object({
  sourceId: z.string().uuid(),
  countryCode: z.literal("US"),
  city: z.enum(["Miami", "Fort Lauderdale", "West Palm Beach", "Broward", "Boca Raton", "Hialeah", "Palm Beach"]),
  propertyType: z.literal("all"),
  listingIntent: z.literal("sale"),
  resultLimit: z.number().int().min(1).max(50),
  authorizationReference: z.string().trim().min(6).max(500),
  authorizationConfirmed: z.literal(true),
}).strict();

function workerUrl() {
  const raw = process.env.LEADFORGE_SCRAPER_WORKER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (path !== "/runs" || url.search || url.hash || url.username || url.password) return null;
    url.pathname = path;
    if (url.protocol === "https:") return url.toString().replace(/\/$/, "");
    if (process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return url.toString().replace(/\/$/, "");
  } catch { /* reject invalid configuration */ }
  return null;
}

function callbackBaseUrl() {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export async function GET(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  const { data, error } = await context.admin.from("listing_collection_runs")
    .select("id,source_id,provider,status,discovered_count,imported_count,duplicate_count,rejected_count,contacts_found_count,error_message,started_at,completed_at,worker_configuration,worker_progress,worker_artifact_name,worker_heartbeat_at,authorization_reference")
    .eq("organization_id", context.organizationId).eq("provider", "leadforge_scraper_worker")
    .order("started_at", { ascending: false }).limit(50);
  if (error) return NextResponse.json({ error: "Unable to load scraper runs" }, { status: 500 });
  return NextResponse.json({ workerConfigured: Boolean(workerUrl() && callbackBaseUrl() && process.env.LEADFORGE_SCRAPER_WORKER_TOKEN), data }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const parsed = runSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid scraper run configuration", details: parsed.error.flatten() }, { status: 400 });
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const endpoint = workerUrl();
  const token = process.env.LEADFORGE_SCRAPER_WORKER_TOKEN;
  const callbackBase = callbackBaseUrl();
  if (!endpoint || !token || !callbackBase) return NextResponse.json({ error: "The separate scraper worker or trusted HTTPS callback URL is not configured. No collection run was created." }, { status: 503 });
  const { context } = result;
  const { data: source, error: sourceError } = await context.admin.from("listing_sources")
    .select("id,name,source_key,source_type,source_url,approved,active")
    .eq("id", parsed.data.sourceId).eq("organization_id", context.organizationId).maybeSingle();
  if (sourceError) return NextResponse.json({ error: "Unable to verify approved source" }, { status: 500 });
  if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });
  if (!source.approved || !source.active) return NextResponse.json({ error: "Source must be approved and active before a run can be dispatched" }, { status: 409 });
  if (!source.source_url) return NextResponse.json({ error: "Approved source must have an HTTPS base URL" }, { status: 400 });
  const allowedHostSuffix: Record<string, string> = { craigslist: "craigslist.org", forsalebyowner: "forsalebyowner.com", byowner: "byowner.com" };
  const expectedSourceName: Record<string, string> = { craigslist: "Craigslist", forsalebyowner: "ForSaleByOwner.com", byowner: "ByOwner.com" };
  const hostSuffix = allowedHostSuffix[source.source_key];
  let approvedHost = "";
  try {
    const sourceUrl = new URL(source.source_url);
    if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) return NextResponse.json({ error: "Approved source must be a credential-free HTTPS base URL" }, { status: 400 });
    approvedHost = sourceUrl.hostname.toLowerCase();
  } catch { return NextResponse.json({ error: "Approved source URL is invalid" }, { status: 400 }); }
  if (!hostSuffix || !(approvedHost === hostSuffix || approvedHost.endsWith(`.${hostSuffix}`))) return NextResponse.json({ error: "This source is not one of the worker's configured owner-listing adapters or its host does not match the adapter" }, { status: 400 });
  if (source.name !== expectedSourceName[source.source_key]) return NextResponse.json({ error: `Rename the approved source to exactly “${expectedSourceName[source.source_key]}” so the worker manifest retains source provenance for preview/import` }, { status: 400 });
  if (!["approved_feed", "partner_feed"].includes(source.source_type)) return NextResponse.json({ error: "Scraper worker requires an approved external feed source" }, { status: 400 });
  const configuration = {
    sourceKey: source.source_key,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.source_type,
    sourceApproved: source.approved,
    sourceActive: source.active,
    authorizationConfirmed: parsed.data.authorizationConfirmed,
    sourceUrl: source.source_url,
    countryCode: parsed.data.countryCode,
    city: parsed.data.city,
    propertyType: parsed.data.propertyType,
    listingIntent: parsed.data.listingIntent,
    resultLimit: parsed.data.resultLimit,
  };
  const { data: run, error: runError } = await context.admin.from("listing_collection_runs").insert({
    organization_id: context.organizationId,
    source_id: source.id,
    provider: "leadforge_scraper_worker",
    status: "running",
    worker_configuration: configuration,
    worker_progress: { stage: "dispatching", message: "Waiting for worker acknowledgement", pages_processed: 0, rows_seen: 0 },
    worker_heartbeat_at: new Date().toISOString(),
    authorization_reference: parsed.data.authorizationReference,
  }).select("id,status,started_at").single();
  if (runError || !run) return NextResponse.json({ error: "Unable to create scraper run record" }, { status: 500 });
  const callbackUrl = new URL(`/api/scraper-runs/${run.id}/events`, callbackBase).toString();
  try {
    const dispatch = await fetch(endpoint, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.id, callbackUrl, configuration, authorizationReference: parsed.data.authorizationReference }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!dispatch.ok && dispatch.status !== 202) {
      const safeError = `Worker dispatch failed with HTTP ${dispatch.status}.`;
      await context.admin.from("listing_collection_runs").update({ status: "failed", error_message: safeError, completed_at: new Date().toISOString(), worker_progress: { stage: "dispatch_failed", message: safeError } }).eq("id", run.id);
      return NextResponse.json({ error: safeError, runId: run.id }, { status: 502 });
    }
    return NextResponse.json({ data: { ...run, configuration, status: "running" } }, { status: 202 });
  } catch {
    const safeError = "Worker dispatch timed out or could not connect.";
    await context.admin.from("listing_collection_runs").update({ status: "failed", error_message: safeError, completed_at: new Date().toISOString(), worker_progress: { stage: "dispatch_failed", message: safeError } }).eq("id", run.id);
    return NextResponse.json({ error: safeError, runId: run.id }, { status: 502 });
  }
}
