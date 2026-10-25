import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const agentSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().trim().min(2).max(120),
  serviceAreas: z.array(z.string().trim().min(2).max(120)).max(50),
  specialties: z.array(z.enum(["house", "apartment", "land", "commercial", "other", "all"])).min(1).max(6),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  minBudget: z.number().nonnegative().optional(),
  maxBudget: z.number().positive().optional(),
}).refine((value) => value.minBudget === undefined || value.maxBudget === undefined || value.maxBudget >= value.minBudget, {
  message: "Maximum budget must be at least the minimum budget",
  path: ["maxBudget"],
});

export async function POST(request: Request) {
  const parsed = agentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent profile", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization permissions" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Organization membership required" }, { status: 403 });
  if (parsed.data.userId !== user.id && !["owner", "admin", "manager"].includes(member.role)) {
    return NextResponse.json({ error: "You may only create your own agent profile" }, { status: 403 });
  }
  const { data: targetMembership, error: targetError } = await supabase.from("organization_members")
    .select("user_id")
    .eq("organization_id", member.organization_id)
    .eq("user_id", parsed.data.userId)
    .maybeSingle();
  if (targetError) return NextResponse.json({ error: "Unable to validate target organization member" }, { status: 500 });
  if (!targetMembership) return NextResponse.json({ error: "Agent must be an existing organization member" }, { status: 400 });

  const { data: agent, error: agentError } = await supabase.from("agents").insert({
    organization_id: member.organization_id,
    user_id: parsed.data.userId,
  }).select("id").single();
  if (agentError) return NextResponse.json({ error: agentError.code === "23505" ? "Agent profile already exists" : "Unable to create agent profile" }, { status: agentError.code === "23505" ? 409 : 500 });
  const { error: profileError } = await supabase.from("agent_profiles").insert({
    organization_id: member.organization_id,
    agent_id: agent.id,
    display_name: parsed.data.displayName,
    service_areas: parsed.data.serviceAreas,
    specialties: parsed.data.specialties,
    currency: parsed.data.currency ?? null,
    min_budget: parsed.data.minBudget ?? null,
    max_budget: parsed.data.maxBudget ?? null,
  });
  if (profileError) {
    const { error: rollbackError } = await supabase.from("agents").delete().eq("id", agent.id);
    if (rollbackError) return NextResponse.json({ error: "Agent profile setup failed and cleanup also failed" }, { status: 500 });
    return NextResponse.json({ error: "Unable to save agent matching profile" }, { status: 500 });
  }
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "agent.profile_created",
      entityType: "agent",
      entityId: agent.id,
    });
  } catch {
    return NextResponse.json({ error: "Agent profile saved but the audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { id: agent.id } }, { status: 201 });
}
