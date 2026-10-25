import type { SupabaseClient } from "@supabase/supabase-js";

export type OrganizationMember = {
  organization_id: string;
  role: "owner" | "admin" | "manager" | "agent";
};

export async function getOrganizationMember(supabase: SupabaseClient, userId: string, roles?: OrganizationMember["role"][]) {
  const query = supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", userId);
  const { data, error } = await query;
  if (error) return { member: null, error };
  const members = (data ?? []) as OrganizationMember[];
  const member = roles ? members.find((item) => roles.includes(item.role)) : members[0];
  return { member: member ?? null, error: null };
}

export async function writeAuditLog(
  supabase: SupabaseClient,
  event: { organizationId: string; actorId: string; action: string; entityType: string; entityId?: string; metadata?: Record<string, unknown> },
) {
  const { error } = await supabase.from("audit_logs").insert({
    organization_id: event.organizationId,
    actor_id: event.actorId,
    action: event.action,
    entity_type: event.entityType,
    entity_id: event.entityId ?? null,
    metadata: event.metadata ?? {},
  });
  if (error) throw new Error(`Audit logging failed: ${error.message}`);
}
