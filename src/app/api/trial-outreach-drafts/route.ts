import { NextResponse } from "next/server";
import { z } from "zod";
import { getSalesManagerContext } from "@/lib/sales-auth";

const dismissSchema = z.object({ id: z.string().uuid(), action: z.literal("dismiss") }).strict();

export async function GET(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  const { data: drafts, error } = await context.admin.from("trial_outreach_drafts")
    .select("id,listing_id,agent_directory_id,channel,message,status,created_at")
    .eq("organization_id", context.organizationId)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "Unable to load trial outreach drafts; confirm the pending migration is applied." }, { status: 503 });
  const listingIds = [...new Set((drafts ?? []).map((draft) => draft.listing_id))];
  const agentIds = [...new Set((drafts ?? []).map((draft) => draft.agent_directory_id))];
  const [{ data: listings, error: listingError }, { data: agents, error: agentError }] = await Promise.all([
    listingIds.length ? context.admin.from("listings").select("id,title,city,region,country_code,property_type").eq("organization_id", context.organizationId).in("id", listingIds) : Promise.resolve({ data: [], error: null }),
    agentIds.length ? context.admin.from("agent_directory").select("id,name,agency,city,country_code,preferred_channel,status").eq("organization_id", context.organizationId).in("id", agentIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (listingError || agentError) return NextResponse.json({ error: "Unable to load trial draft summaries" }, { status: 500 });
  const listingMap = new Map((listings ?? []).map((listing) => [listing.id, listing]));
  const agentMap = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  return NextResponse.json({ data: (drafts ?? []).map((draft) => ({
    ...draft,
    listing: listingMap.get(draft.listing_id) ?? null,
    agent: agentMap.get(draft.agent_directory_id) ?? null,
  })) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const parsed = dismissSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid trial-draft action" }, { status: 400 });
  const now = new Date().toISOString();
  const { data, error } = await result.context.admin.from("trial_outreach_drafts")
    .update({ status: "dismissed", dismissed_by: result.context.userId, dismissed_at: now })
    .eq("id", parsed.data.id).eq("organization_id", result.context.organizationId).eq("status", "draft")
    .select("id,status,dismissed_at").maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to dismiss trial outreach draft" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Draft was not found or is already dismissed" }, { status: 404 });
  const { error: auditError } = await result.context.admin.from("audit_logs").insert({
    organization_id: result.context.organizationId,
    actor_id: result.context.userId,
    action: "trial_outreach_draft.dismissed",
    entity_type: "trial_outreach_draft",
    entity_id: data.id,
    metadata: {},
  });
  if (auditError) return NextResponse.json({ error: "Draft dismissed, but the audit record could not be written" }, { status: 500 });
  return NextResponse.json({ data }, { headers: { "Cache-Control": "private, no-store" } });
}
