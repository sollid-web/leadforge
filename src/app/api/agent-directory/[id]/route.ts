import { NextResponse } from "next/server";
import { z } from "zod";
import { getSalesManagerContext } from "@/lib/sales-auth";

const updateSchema = z.object({
  status: z.enum(["discovered", "reviewed", "contacted", "interested", "customer", "inactive", "opted_out"]).optional(),
  notes: z.string().trim().max(4000).optional(),
  followUpAt: z.string().datetime().nullable().optional(),
  summary: z.string().trim().min(1).max(2000).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent update", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  const { data: existing, error: queryError } = await context.admin.from("agent_directory")
    .select("id,status,opted_out_at").eq("id", id).eq("organization_id", context.organizationId).maybeSingle();
  if (queryError) return NextResponse.json({ error: "Unable to load agent record" }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Agent record not found" }, { status: 404 });
  if (existing.status === "opted_out" && parsed.data.status && parsed.data.status !== "opted_out") {
    return NextResponse.json({ error: "Opted-out records cannot be reactivated for outreach" }, { status: 409 });
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.status) {
    patch.status = parsed.data.status;
    if (parsed.data.status === "opted_out") patch.opted_out_at = existing.opted_out_at ?? new Date().toISOString();
  }
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
  if (parsed.data.followUpAt !== undefined) patch.follow_up_at = parsed.data.followUpAt;
  const { error } = await context.admin.from("agent_directory").update(patch).eq("id", id).eq("organization_id", context.organizationId);
  if (error) return NextResponse.json({ error: "Unable to update agent record" }, { status: 500 });
  const summary = parsed.data.summary ?? (parsed.data.status ? `Status changed from ${existing.status} to ${parsed.data.status}.` : parsed.data.notes ? `Note updated: ${parsed.data.notes}` : "Follow-up schedule updated.");
  const { error: interactionError } = await context.admin.from("agent_directory_interactions").insert({
    organization_id: context.organizationId,
    agent_directory_id: id,
    interaction_type: parsed.data.status === "opted_out" ? "opt_out" : parsed.data.status ? "status_change" : "note",
    channel: "manual",
    summary,
    follow_up_at: parsed.data.followUpAt ?? null,
    created_by: context.userId,
  });
  if (interactionError) return NextResponse.json({ error: "Agent record updated but its interaction history could not be written" }, { status: 500 });
  await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: parsed.data.status === "opted_out" ? "agent_directory.opted_out" : "agent_directory.updated", entity_type: "agent_directory", entity_id: id, metadata: { status: parsed.data.status ?? existing.status } });
  return NextResponse.json({ data: { id, status: parsed.data.status ?? existing.status } });
}
