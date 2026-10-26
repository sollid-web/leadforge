import { getOrganizationMember } from "@/lib/api-auth";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function getUnteraManagerContext() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { error: "Supabase is not configured", status: 503 } as const;
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { error: "Authentication required", status: 401 } as const;
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return { error: "Unable to check organization permissions", status: 500 } as const;
  if (!member) return { error: "Manager permission required", status: 403 } as const;
  const admin = getSupabaseAdminClient();
  if (!admin) return { error: "Supabase service role is not configured", status: 503 } as const;

  return {
    supabase,
    admin,
    userId: user.id,
    organizationId: member.organization_id,
  } as const;
}

export async function getActiveUnteraSource(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  organizationId: string,
  sourceId: string,
) {
  const { data, error } = await supabase.from("listing_sources")
    .select("id,name,source_type,source_url,configuration,approved,active")
    .eq("id", sourceId)
    .eq("organization_id", organizationId)
    .eq("source_type", "public_api")
    .maybeSingle();
  if (error) return { source: null, error: "Unable to load the Untera source." };
  if (!data || data.configuration?.provider !== "untera") return { source: null, error: "The selected source is not configured for Untera." };
  if (!data.approved || !data.active) return { source: null, error: "The Untera source must be approved and active by an organization owner or admin." };
  return { source: data, error: null };
}
