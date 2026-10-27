import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type SalesContext = {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  organizationId: string;
  role: string;
};

type ContextResult = { ok: true; context: SalesContext } | { ok: false; error: string; status: number };

async function resolveContext(request: Request, managerOnly: boolean): Promise<ContextResult> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured", status: 503 };
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, error: "Authentication required", status: 401 };
  const { data: memberships, error: membershipError } = await supabase.from("organization_members")
    .select("organization_id,role")
    .eq("user_id", user.id);
  if (membershipError) return { ok: false, error: "Unable to load organization membership", status: 500 };
  const allowed = (memberships ?? []).filter((membership) => !managerOnly || ["owner", "admin", "manager"].includes(membership.role));
  if (!allowed.length) return { ok: false, error: managerOnly ? "Manager permission required" : "Organization membership required", status: 403 };
  const requestedOrganizationId = request.headers.get("x-organization-id")?.trim();
  let member = requestedOrganizationId ? allowed.find((candidate) => candidate.organization_id === requestedOrganizationId) : undefined;
  if (requestedOrganizationId && !member) return { ok: false, error: "Selected organization is not available to this account", status: 403 };
  if (!requestedOrganizationId) member = allowed[0];
  const admin = getSupabaseAdminClient();
  if (!admin) return { ok: false, error: "Supabase service role is not configured for this workflow", status: 503 };
  return { ok: true, context: { supabase, admin, userId: user.id, organizationId: member!.organization_id, role: member!.role } };
}

export async function getSalesManagerContext(request: Request) {
  return resolveContext(request, true);
}

export async function getSalesBuyerContext(request: Request) {
  return resolveContext(request, false);
}
