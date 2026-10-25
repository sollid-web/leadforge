import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const PAGE_SIZE = 500;
const DEGRADED_AFTER_HOURS = 24;
const FAILED_AFTER_HOURS = 72;

function authorized(request: Request, secret: string) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Source health job is not configured" }, { status: 503 });
  if (!authorized(request, secret)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const supabase = getSupabaseAdminClient();
  if (!supabase) return NextResponse.json({ error: "Supabase service role is not configured" }, { status: 503 });

  const { data: sources, error: sourcesError } = await supabase.from("listing_sources")
    .select("id,organization_id,name,source_type")
    .eq("approved", true)
    .eq("active", true)
    .neq("source_type", "manual")
    .order("created_at", { ascending: true })
    .limit(PAGE_SIZE + 1);
  if (sourcesError) return NextResponse.json({ error: "Unable to load active approved sources" }, { status: 500 });
  if ((sources ?? []).length > PAGE_SIZE) {
    return NextResponse.json({ error: `Too many active sources for one check; maximum is ${PAGE_SIZE}` }, { status: 413 });
  }

  const checkedAt = new Date();
  const degradedCutoff = checkedAt.getTime() - DEGRADED_AFTER_HOURS * 60 * 60 * 1000;
  const failedCutoff = checkedAt.getTime() - FAILED_AFTER_HOURS * 60 * 60 * 1000;
  const { data: healthRows, error: healthError } = sources?.length
    ? await supabase.from("source_health").select("source_id,status,last_success_at").in("source_id", sources.map((source) => source.id))
    : { data: [], error: null };
  if (healthError) return NextResponse.json({ error: "Unable to load source ingestion history" }, { status: 500 });
  const lastSuccessBySource = new Map((healthRows ?? []).map((row) => [row.source_id, row.last_success_at]));
  const changed: { id: string; organization_id: string; name: string; from: string | null; to: string; message: string }[] = [];

  const updates = (sources ?? []).map((source) => {
    const lastSuccess = lastSuccessBySource.get(source.id) ?? null;
    let status: "unknown" | "healthy" | "degraded" | "failed" = "unknown";
    let message = "No successful ingestion has been recorded.";
    if (lastSuccess) {
      const lastSuccessTime = Date.parse(lastSuccess);
      if (!Number.isFinite(lastSuccessTime)) {
        return null;
      }
      if (lastSuccessTime < failedCutoff) {
        status = "failed";
        message = `No successful ingestion in more than ${FAILED_AFTER_HOURS} hours.`;
      } else if (lastSuccessTime < degradedCutoff) {
        status = "degraded";
        message = `No successful ingestion in more than ${DEGRADED_AFTER_HOURS} hours.`;
      } else {
        status = "healthy";
        message = "Recent successful ingestion.";
      }
    }
    return {
      source_id: source.id,
      organization_id: source.organization_id,
      status,
      last_checked_at: checkedAt.toISOString(),
      last_success_at: lastSuccess,
      message,
    };
  });
  if (updates.some((update) => update === null)) {
    return NextResponse.json({ error: "Invalid last-success timestamp found in source health data" }, { status: 500 });
  }
  const validUpdates = updates.filter((update): update is NonNullable<typeof update> => update !== null);
  const { error: updateError } = validUpdates.length
    ? await supabase.from("source_health").upsert(validUpdates, { onConflict: "source_id" })
    : { error: null };
  if (updateError) return NextResponse.json({ error: "Unable to update source health" }, { status: 500 });

  const previousBySource = new Map((healthRows ?? []).map((row) => [row.source_id, row.status]));
  const sourceById = new Map((sources ?? []).map((source) => [source.id, source]));
  for (const update of validUpdates) {
    const previous = previousBySource.get(update.source_id);
    if (previous && previous !== update.status) {
      const source = sourceById.get(update.source_id);
      if (!source) continue;
      changed.push({
        id: source.id,
        organization_id: source.organization_id,
        name: source.name,
        from: previous,
        to: update.status,
        message: update.message,
      });
    }
  }

  if (changed.length) {
    const { error } = await supabase.from("audit_logs").insert(changed.map((source) => ({
      organization_id: source.organization_id,
      actor_id: null,
      action: "source.health_status_changed",
      entity_type: "listing_source",
      entity_id: source.id,
      metadata: { source_name: source.name, previous_status: source.from, status: source.to, message: source.message },
    })));
    if (error) return NextResponse.json({ error: "Source health was updated but status changes could not be audited" }, { status: 500 });
  }

  return NextResponse.json({
    data: {
      checked: updates.length,
      statusChanges: changed.length,
      asOf: checkedAt.toISOString(),
    },
  });
}
