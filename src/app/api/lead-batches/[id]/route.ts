import { NextResponse } from "next/server";
import { z } from "zod";
import { getSalesManagerContext } from "@/lib/sales-auth";

const actionSchema = z.object({ action: z.enum(["approve", "archive"]) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid batch action" }, { status: 400 });
  const { id } = await params;
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  if (parsed.data.action === "approve") {
    const { error } = await context.supabase.rpc("approve_lead_batch", { target_batch: id });
    if (error) return NextResponse.json({ error: error.message.includes("20") || error.message.includes("qualifying") ? error.message : "Unable to approve batch; confirm it remains in review and all records qualify." }, { status: 409 });
  } else {
    const { error } = await context.admin.from("lead_batches").update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", id).eq("organization_id", context.organizationId).in("status", ["draft", "ready_for_review"]);
    if (error) return NextResponse.json({ error: "Unable to archive batch" }, { status: 500 });
  }
  await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: parsed.data.action === "approve" ? "lead_batch.approved" : "lead_batch.archived", entity_type: "lead_batch", entity_id: id });
  return NextResponse.json({ data: { id, status: parsed.data.action === "approve" ? "approved" : "archived" } });
}
