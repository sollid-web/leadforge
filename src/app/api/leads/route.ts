import { NextResponse } from "next/server";
import { z } from "zod";
import { leads } from "@/lib/demo-data";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const leadInput = z.object({ name: z.string().trim().min(1).max(120), email: z.string().email().max(254).optional(), phone: z.string().trim().max(40).optional(), location: z.string().trim().max(120).optional(), propertyType: z.string().trim().max(80).optional(), budget: z.number().nonnegative().max(1_000_000_000_000).optional(), source: z.string().trim().min(1).max(80), sourceType: z.enum(["inbound_form", "manual", "referral", "partner", "permitted_public_data"]).default("manual") });

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ mode: "demo", data: leads });
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data: memberships, error: membershipError } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  const organizationIds = (memberships ?? []).map((membership) => membership.organization_id);
  if (!organizationIds.length) return NextResponse.json({ mode: "live", data: [] });
  const { data, error } = await supabase.from("leads").select("*").in("organization_id", organizationIds).order("created_at", { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: "Unable to load leads" }, { status: 500 });
  return NextResponse.json({ mode: "live", data });
}

export async function POST(request: Request) {
  const parsed = leadInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead payload", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Demo mode is read-only. Configure Supabase to create leads." }, { status: 503 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { data: membership } = await supabase.from("organization_members").select("organization_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!membership) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });
  const { data, error } = await supabase.from("leads").insert({ organization_id: membership.organization_id, created_by: user.id, full_name: parsed.data.name, email: parsed.data.email ?? null, phone: parsed.data.phone ?? null, property_type: parsed.data.propertyType ?? null, preferred_areas: parsed.data.location ? [parsed.data.location] : [], budget_max: parsed.data.budget ?? null, source_type: parsed.data.sourceType, source_reference: parsed.data.source, contact_permission: "unknown", status: "new" }).select().single();
  if (error) return NextResponse.json({ error: "Unable to create lead", code: error.code }, { status: 400 });
  return NextResponse.json({ mode: "live", data }, { status: 201 });
}
