import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const updateSchema = z.object({
  status: z.enum(["new", "reviewed", "contacted", "qualified", "archived"]).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict().refine((value) => value.status !== undefined || value.notes !== undefined);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide a valid status or note update", details: parsed.error.flatten() }, { status: 400 });
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Manager permission required" }, { status: 403 });
  const { data, error } = await supabase.from("business_prospects")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", member.organization_id)
    .select("id,status,notes,updated_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to update business prospect" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Business prospect not found" }, { status: 404 });
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "business_prospect.updated",
      entityType: "business_prospect",
      entityId: id,
      metadata: { status: data.status, notes_updated: parsed.data.notes !== undefined },
    });
  } catch {
    return NextResponse.json({ error: "Prospect was updated but its audit event could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data });
}
