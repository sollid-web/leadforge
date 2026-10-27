import { NextResponse } from "next/server";
import { z } from "zod";
import { decryptPrivateData, encryptPrivateData } from "@/lib/private-data";
import { getSalesManagerContext } from "@/lib/sales-auth";

export const runtime = "nodejs";

const contactSchema = z.object({
  name: z.string().trim().max(160).optional(),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
}).optional();
const agentSchema = z.object({
  name: z.string().trim().min(2).max(160),
  agency: z.string().trim().max(160).optional(),
  countryCode: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/),
  city: z.string().trim().min(1).max(120),
  serviceAreas: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  preferredPropertyTypes: z.array(z.enum(["house", "apartment", "land", "commercial", "other", "all"])).max(6).default([]),
  preferredListingTypes: z.array(z.enum(["sale", "rental"])).max(2).default([]),
  preferredCurrency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).optional(),
  minLeadVolume: z.number().int().min(1).max(500).optional(),
  maxLeadVolume: z.number().int().min(1).max(500).optional(),
  minBudget: z.number().nonnegative().max(1_000_000_000_000).optional(),
  maxBudget: z.number().nonnegative().max(1_000_000_000_000).optional(),
  preferredChannel: z.enum(["email", "phone", "whatsapp", "manual"]).default("manual"),
  contact: contactSchema,
  sourceName: z.string().trim().min(2).max(160).default("Manual entry"),
  sourceUrl: z.string().url().max(2048).optional().refine((value) => !value || (new URL(value).protocol === "https:" && !new URL(value).username && !new URL(value).password), "Source URL must use HTTPS"),
  linkedUserId: z.string().uuid().optional(),
  status: z.enum(["discovered", "reviewed", "contacted", "interested", "customer", "inactive", "opted_out"]).default("discovered"),
  notes: z.string().trim().max(4000).optional(),
  followUpAt: z.string().datetime().optional(),
}).refine((value) => value.minLeadVolume === undefined || value.maxLeadVolume === undefined || value.minLeadVolume <= value.maxLeadVolume, { path: ["maxLeadVolume"], message: "Maximum lead volume must be at least the minimum" })
  .refine((value) => value.minBudget === undefined || value.maxBudget === undefined || value.minBudget <= value.maxBudget, { path: ["maxBudget"], message: "Maximum budget must be at least the minimum" });

function plainContact(contact: Record<string, string> | null) {
  if (!contact) return null;
  return { name: contact.name ?? "", email: contact.email ?? "", phone: contact.phone ?? "" };
}

export async function GET(request: Request) {
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { admin, organizationId } = result.context;
  const { data, error } = await admin.from("agent_directory")
    .select("id,organization_id,linked_user_id,name,agency,country_code,city,service_areas,preferred_property_types,preferred_listing_types,preferred_currency,min_lead_volume,max_lead_volume,min_budget,max_budget,preferred_channel,contact_ciphertext,contact_iv,contact_auth_tag,contact_key_version,source_name,source_url,status,opted_out_at,notes,follow_up_at,created_at,updated_at")
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false }).limit(250);
  if (error) return NextResponse.json({ error: "Unable to load agent directory" }, { status: 500 });
  const { data: interactions, error: interactionError } = await admin.from("agent_directory_interactions")
    .select("id,agent_directory_id,interaction_type,channel,summary,occurred_at,follow_up_at")
    .eq("organization_id", organizationId).order("occurred_at", { ascending: false }).limit(500);
  if (interactionError) return NextResponse.json({ error: "Unable to load agent interaction history" }, { status: 500 });
  try {
    const agents = (data ?? []).map((agent) => {
      const { contact_ciphertext, contact_iv, contact_auth_tag, contact_key_version, ...safe } = agent;
      const contact = contact_ciphertext && contact_iv && contact_auth_tag
        ? plainContact(decryptPrivateData({ ciphertext: contact_ciphertext, iv: contact_iv, auth_tag: contact_auth_tag }))
        : null;
      return { ...safe, contact, interactions: (interactions ?? []).filter((event) => event.agent_directory_id === agent.id).slice(0, 20) };
    });
    return NextResponse.json({ data: agents }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Agent contact decryption is unavailable; verify the server encryption key" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const parsed = agentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid agent record", details: parsed.error.flatten() }, { status: 400 });
  const result = await getSalesManagerContext(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const { context } = result;
  if (parsed.data.linkedUserId) {
    const contactEmail = parsed.data.contact?.email?.trim().toLowerCase();
    if (!contactEmail) return NextResponse.json({ error: "A buyer account can be linked only when a matching contact email is recorded" }, { status: 400 });
    const { data: member, error } = await context.admin.from("organization_members").select("user_id,role")
      .eq("organization_id", context.organizationId).eq("user_id", parsed.data.linkedUserId).maybeSingle();
    if (error) return NextResponse.json({ error: "Unable to verify buyer organization membership" }, { status: 500 });
    if (!member || member.role !== "agent") return NextResponse.json({ error: "A delivery account must be an agent member of this organization" }, { status: 400 });
    const { data: authUser, error: authUserError } = await context.admin.auth.admin.getUserById(parsed.data.linkedUserId);
    if (authUserError) return NextResponse.json({ error: "Unable to verify buyer account email" }, { status: 500 });
    if (!authUser.user.email || !authUser.user.email_confirmed_at || authUser.user.email.toLowerCase() !== contactEmail) {
      return NextResponse.json({ error: "Buyer account must have a verified email matching the directory contact email" }, { status: 403 });
    }
  }
  const duplicate = await context.admin.from("agent_directory").select("id")
    .eq("organization_id", context.organizationId).ilike("name", parsed.data.name).ilike("city", parsed.data.city).limit(1).maybeSingle();
  if (duplicate.error) return NextResponse.json({ error: "Unable to check for an existing agent record" }, { status: 500 });
  if (duplicate.data) return NextResponse.json({ error: "A directory record with this name and city already exists", duplicateId: duplicate.data.id }, { status: 409 });
  const { contact, ...fields } = parsed.data;
  let encrypted: ReturnType<typeof encryptPrivateData> | null = null;
  if (contact && Object.values(contact).some((value) => Boolean(value?.trim()))) {
    try { encrypted = encryptPrivateData(contact); }
    catch { return NextResponse.json({ error: "Agent contact encryption is not configured" }, { status: 503 }); }
  }
  const { data, error } = await context.admin.from("agent_directory").insert({
    organization_id: context.organizationId,
    linked_user_id: fields.linkedUserId ?? null,
    name: fields.name,
    agency: fields.agency || null,
    country_code: fields.countryCode.toUpperCase(),
    city: fields.city,
    service_areas: fields.serviceAreas,
    preferred_property_types: fields.preferredPropertyTypes,
    preferred_listing_types: fields.preferredListingTypes,
    preferred_currency: fields.preferredCurrency?.toUpperCase() ?? null,
    min_lead_volume: fields.minLeadVolume ?? null,
    max_lead_volume: fields.maxLeadVolume ?? null,
    min_budget: fields.minBudget ?? null,
    max_budget: fields.maxBudget ?? null,
    preferred_channel: fields.preferredChannel,
    contact_ciphertext: encrypted?.ciphertext ?? null,
    contact_iv: encrypted?.iv ?? null,
    contact_auth_tag: encrypted?.authTag ?? null,
    contact_key_version: encrypted?.keyVersion ?? null,
    source_name: fields.sourceName,
    source_url: fields.sourceUrl ?? null,
    status: fields.status,
    opted_out_at: fields.status === "opted_out" ? new Date().toISOString() : null,
    notes: fields.notes ?? null,
    follow_up_at: fields.followUpAt ?? null,
    created_by: context.userId,
  }).select("id,name,status").single();
  if (error || !data) return NextResponse.json({ error: "Unable to save agent directory record" }, { status: 500 });
  if (fields.notes) {
    const { error: interactionError } = await context.admin.from("agent_directory_interactions").insert({
      organization_id: context.organizationId,
      agent_directory_id: data.id,
      interaction_type: "note",
      channel: "manual",
      summary: `Initial note: ${fields.notes}`,
      follow_up_at: fields.followUpAt ?? null,
      created_by: context.userId,
    });
    if (interactionError) return NextResponse.json({ error: "Agent record was created but its initial note could not be recorded", id: data.id }, { status: 500 });
  }
  await context.supabase.from("audit_logs").insert({ organization_id: context.organizationId, actor_id: context.userId, action: "agent_directory.created", entity_type: "agent_directory", entity_id: data.id, metadata: { source_name: fields.sourceName, linked_user: Boolean(fields.linkedUserId) } });
  return NextResponse.json({ data }, { status: 201 });
}
