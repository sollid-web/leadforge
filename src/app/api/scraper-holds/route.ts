import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/api-auth";
import { getSalesManagerContext } from "@/lib/sales-auth";

const resolveSchema = z.object({
  id: z.string().uuid(),
  action: z.literal("dismiss"),
}).strict();

export async function GET(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { data, error } = await result.context.admin.from("scraper_candidate_holds")
    .select("id,source_id,run_id,external_id,title,listing_url,city,country_code,reason_code,evidence_codes,review_status,created_at,last_seen_at")
    .eq("organization_id", result.context.organizationId)
    .eq("review_status", "open")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "Unable to load ambiguous scraper candidates; confirm the owner-discovery migration is applied." }, { status: 503 });
  return NextResponse.json({ data: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid scraper-hold resolution" }, { status: 400 });
  const now = new Date().toISOString();
  const { data, error } = await result.context.admin.from("scraper_candidate_holds")
    .update({ review_status: "dismissed", dismissed_by: result.context.userId, dismissed_at: now })
    .eq("id", parsed.data.id)
    .eq("organization_id", result.context.organizationId)
    .eq("review_status", "open")
    .select("id,source_id,run_id,title,reason_code,review_status,dismissed_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to resolve ambiguous scraper candidate" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Open scraper hold was not found" }, { status: 404 });
  try {
    await writeAuditLog(result.context.supabase, {
      organizationId: result.context.organizationId,
      actorId: result.context.userId,
      action: "scraper_candidate_hold.dismissed",
      entityType: "scraper_candidate_hold",
      entityId: data.id,
      metadata: { source_id: data.source_id, run_id: data.run_id, reason_code: data.reason_code },
    });
  } catch {
    return NextResponse.json({ error: "Hold dismissed, but the audit record could not be written." }, { status: 500 });
  }
  return NextResponse.json({ data }, { headers: { "Cache-Control": "private, no-store" } });
}
