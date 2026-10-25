import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const organizationSchema = z.object({ name: z.string().trim().min(2).max(120) });

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data, error } = await supabase.from("organization_members")
    .select("organization_id,role,organizations(name,market,currency)")
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: "Unable to load organizations" }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const parsed = organizationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid organization name is required", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data, error } = await supabase.rpc("create_organization", { organization_name: parsed.data.name });
  if (error) return NextResponse.json({ error: "Unable to create organization" }, { status: 500 });
  try {
    await writeAuditLog(supabase, {
      organizationId: data,
      actorId: user.id,
      action: "organization.created",
      entityType: "organization",
      entityId: data,
    });
  } catch {
    return NextResponse.json({ error: "Organization was created but the audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { id: data, name: parsed.data.name } }, { status: 201 });
}
