import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrganizationMember } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const leadInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  location: z.string().trim().max(120).optional(),
  propertyType: z.string().trim().max(80).optional(),
  budget: z.number().nonnegative().max(1_000_000_000_000).optional(),
  source: z.string().trim().min(1).max(80),
  sourceType: z.enum(["inbound_form", "manual", "referral", "partner", "permitted_public_data"]).default("manual"),
});

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });
  const { data, error } = await supabase.from("leads")
    .select("id,first_name,last_name,email,phone,location,property_type,budget,currency,source,stage,score,consent_status,created_at")
    .eq("organization_id", member.organization_id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: "Unable to load inbound leads" }, { status: 500 });
  return NextResponse.json({ mode: "live", data }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const parsed = leadInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead payload", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id);
  if (membershipError) return NextResponse.json({ error: "Unable to load organization membership" }, { status: 500 });
  if (!member) return NextResponse.json({ error: "No organization membership found" }, { status: 403 });
  const [firstName, ...lastName] = parsed.data.name.split(/\s+/);
  const normalizedEmail = parsed.data.email?.toLocaleLowerCase("en") ?? null;
  const normalizedPhone = parsed.data.phone?.replace(/[^\d+]/g, "") ?? null;
  const { data, error } = await supabase.from("leads").insert({
    organization_id: member.organization_id,
    first_name: firstName,
    last_name: lastName.join(" ") || null,
    email: parsed.data.email ?? null,
    normalized_email: normalizedEmail,
    phone: parsed.data.phone ?? null,
    normalized_phone: normalizedPhone,
    location: parsed.data.location ?? null,
    property_type: parsed.data.propertyType ?? null,
    budget: parsed.data.budget ?? null,
    source: `${parsed.data.sourceType}:${parsed.data.source}`,
    consent_status: "unknown",
  }).select("id,first_name,last_name,email,phone,location,property_type,budget,currency,source,stage,score,consent_status,created_at").single();
  if (error) return NextResponse.json({ error: "Unable to create inbound lead" }, { status: 500 });
  return NextResponse.json({ mode: "live", data }, { status: 201 });
}
