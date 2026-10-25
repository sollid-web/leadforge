import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const preferencesSchema = z.object({ notifyEmail: z.boolean() });

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Organization membership required" }, { status: 403 });
  const { data: agent, error: agentError } = await supabase.from("agents")
    .select("id")
    .eq("organization_id", member.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (agentError) return NextResponse.json({ error: "Unable to load agent profile" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "Create an agent profile before managing email preferences" }, { status: 404 });
  const { data, error } = await supabase.from("agent_preferences")
    .select("notify_email,opt_out_at")
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to load email preferences" }, { status: 500 });
  return NextResponse.json({ data: { notifyEmail: data?.notify_email ?? false, optedOut: Boolean(data?.opt_out_at) } });
}

export async function PATCH(request: Request) {
  const parsed = preferencesSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid email preference", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to check organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "Organization membership required" }, { status: 403 });
  const { data: agent, error: agentError } = await supabase.from("agents")
    .select("id")
    .eq("organization_id", member.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (agentError) return NextResponse.json({ error: "Unable to load agent profile" }, { status: 500 });
  if (!agent) return NextResponse.json({ error: "Create an agent profile before managing email preferences" }, { status: 404 });
  const { data: existing, error: preferenceError } = await supabase.from("agent_preferences")
    .select("opt_out_at")
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (preferenceError) return NextResponse.json({ error: "Unable to load email preferences" }, { status: 500 });
  const { error } = await supabase.from("agent_preferences").upsert({
    agent_id: agent.id,
    organization_id: member.organization_id,
    notify_email: parsed.data.notifyEmail,
    opt_out_at: parsed.data.notifyEmail ? null : existing?.opt_out_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: "Unable to save email preferences" }, { status: 500 });
  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: parsed.data.notifyEmail ? "agent.email_notifications_enabled" : "agent.email_notifications_disabled",
      entityType: "agent",
      entityId: agent.id,
    });
  } catch {
    return NextResponse.json({ error: "Preference was saved but the audit record could not be written" }, { status: 500 });
  }
  return NextResponse.json({ data: { notifyEmail: parsed.data.notifyEmail, optedOut: !parsed.data.notifyEmail } });
}
