import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getOrganizationMember, writeAuditLog } from "@/lib/api-auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const searchSchema = z.object({
  area: z.string().trim().min(2).max(120),
  radiusKm: z.union([z.literal(5), z.literal(10), z.literal(25), z.literal(50)]).default(10),
  category: z.enum(["agents", "brokerages", "property_management"]).default("agents"),
}).strict();

const geocodeSchema = z.array(z.object({
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
})).min(1);

const overpassSchema = z.object({
  elements: z.array(z.object({
    type: z.enum(["node", "way", "relation"]),
    id: z.number().int().positive(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    center: z.object({ lat: z.number(), lon: z.number() }).optional(),
    tags: z.record(z.string(), z.string()).default({}),
  })),
});

function textResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return textResponse("Supabase is not configured", 503);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return textResponse("Authentication required", 401);
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return textResponse("Unable to check organization permissions", 500);
  if (!member) return textResponse("Manager permission required", 403);

  const { data, error } = await supabase.from("business_prospects")
    .select("id,osm_type,osm_id,name,business_type,phone,email,website,address,latitude,longitude,osm_url,search_area,status,notes,discovered_at,updated_at")
    .eq("organization_id", member.organization_id)
    .order("updated_at", { ascending: false })
    .limit(300);
  if (error) return textResponse("Unable to load business prospects", 500);
  const prospects = data ?? [];
  const fingerprints = [...new Set(prospects.flatMap((prospect) => prospect.email
    ? [createHash("sha256").update(prospect.email.trim().toLocaleLowerCase("en")).digest("hex")]
    : []))];
  const ids = prospects.map((prospect) => prospect.id);
  const [{ data: optOuts, error: optOutError }, { data: outreach, error: outreachError }] = await Promise.all([
    fingerprints.length
      ? supabase.from("business_prospect_email_opt_outs").select("email_fingerprint").eq("organization_id", member.organization_id).in("email_fingerprint", fingerprints)
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? supabase.from("business_prospect_outreach").select("prospect_id,status,sent_at").eq("organization_id", member.organization_id).in("prospect_id", ids).order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (optOutError || outreachError) return textResponse("Unable to load business contact preferences", 500);
  const optedOut = new Set((optOuts ?? []).map((item) => item.email_fingerprint));
  const latestOutreach = new Map<string, { status: string; sent_at: string | null }>();
  for (const item of outreach ?? []) if (!latestOutreach.has(item.prospect_id)) {
    latestOutreach.set(item.prospect_id, { status: item.status, sent_at: item.sent_at });
  }
  return NextResponse.json({
    data: prospects.map((prospect) => ({
      ...prospect,
      emailOptedOut: prospect.email
        ? optedOut.has(createHash("sha256").update(prospect.email.trim().toLocaleLowerCase("en")).digest("hex"))
        : false,
      lastEmailStatus: latestOutreach.get(prospect.id)?.status ?? null,
      lastEmailedAt: latestOutreach.get(prospect.id)?.sent_at ?? null,
    })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const parsed = searchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a search area and valid search options", details: parsed.error.flatten() }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return textResponse("Supabase is not configured", 503);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return textResponse("Authentication required", 401);
  const { member, error: membershipError } = await getOrganizationMember(supabase, user.id, ["owner", "admin", "manager"]);
  if (membershipError) return textResponse("Unable to check organization permissions", 500);
  if (!member) return textResponse("Manager permission required", 403);

  const { data: reservation, error: reservationError } = await supabase.rpc("reserve_business_prospect_search", {
    target_organization: member.organization_id,
  });
  if (reservationError) return textResponse("Unable to reserve a business search; confirm the latest database migration is applied", 503);
  if (reservation === "global_cooldown") return textResponse("The discovery service is busy. Wait a moment and try again.", 429);
  if (reservation === "organization_cooldown") return textResponse("To protect the shared discovery service, wait 30 seconds between searches for this workspace.", 429);
  if (reservation !== "reserved") return textResponse("Business search could not be reserved", 503);

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const contactEmail = process.env.OPENSTREETMAP_CONTACT_EMAIL;
  const userAgent = `LeadForge business discovery${baseUrl ? ` (${baseUrl})` : ""}${contactEmail ? ` (${contactEmail})` : ""}`;
  const geocodeUrl = new URL("https://nominatim.openstreetmap.org/search");
  geocodeUrl.searchParams.set("q", parsed.data.area);
  geocodeUrl.searchParams.set("format", "jsonv2");
  geocodeUrl.searchParams.set("limit", "1");

  let geocodeResponse: Response;
  try {
    geocodeResponse = await fetch(geocodeUrl, {
      headers: { "User-Agent": userAgent, "Accept-Language": "en" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return textResponse("The OpenStreetMap location search is temporarily unavailable", 502);
  }
  if (!geocodeResponse.ok) return textResponse(`Location search provider returned ${geocodeResponse.status}`, 502);
  const geocodeBody = geocodeSchema.safeParse(await geocodeResponse.json().catch(() => null));
  if (!geocodeBody.success) return textResponse("No matching location was found. Include a city and country or region.", 404);
  const location = geocodeBody.data[0];
  const latitude = Number(location.lat);
  const longitude = Number(location.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return textResponse("Location provider returned invalid coordinates", 502);

  const radius = parsed.data.radiusKm * 1000;
  const categoryFilter = parsed.data.category === "agents"
    ? `nwr["office"="real_estate_agent"](around:${radius},${latitude},${longitude});nwr["shop"="estate_agent"](around:${radius},${latitude},${longitude});`
    : parsed.data.category === "brokerages"
      ? `nwr["office"="estate_agent"](around:${radius},${latitude},${longitude});`
      : `nwr["office"="property_management"](around:${radius},${latitude},${longitude});`;
  const query = `[out:json][timeout:25];(${categoryFilter});out center tags 50;`;

  let overpassResponse: Response;
  try {
    overpassResponse = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
      body: new URLSearchParams({ data: query }),
      cache: "no-store",
      signal: AbortSignal.timeout(35_000),
    });
  } catch {
    return textResponse("The OpenStreetMap business search is temporarily unavailable; try again later.", 502);
  }
  if (!overpassResponse.ok) return textResponse(`Business search provider returned ${overpassResponse.status}`, 502);
  const overpassBody = overpassSchema.safeParse(await overpassResponse.json().catch(() => null));
  if (!overpassBody.success) return textResponse("Business search provider returned an invalid response", 502);

  const prospects = overpassBody.data.elements.flatMap((element) => {
    const tags = element.tags;
    const name = tags.name?.trim();
    if (!name) return [];
    const website = tags.website ?? tags["contact:website"];
    const safeWebsite = website && /^https?:\/\//i.test(website) ? website : null;
    const coordinates = element.center ?? (element.lat !== undefined && element.lon !== undefined
      ? { lat: element.lat, lon: element.lon }
      : null);
    const businessType = tags.office === "property_management"
      ? "Property management"
      : tags.office === "estate_agent"
        ? "Brokerage / agency"
        : tags.office === "real_estate_agent"
          ? "Real-estate agent office"
        : tags.shop === "estate_agent" ? "Real estate agent" : "Real-estate business";
    const streetAddress = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
    const address = [streetAddress, tags["addr:suburb"], tags["addr:city"], tags["addr:state"], tags["addr:postcode"], tags["addr:country"]]
      .filter(Boolean)
      .join(", ");
    return [{
      organization_id: member.organization_id,
      osm_type: element.type,
      osm_id: element.id,
      name,
      business_type: businessType,
      phone: tags["contact:phone"] ?? tags.phone ?? null,
      email: tags["contact:email"] ?? tags.email ?? null,
      website: safeWebsite,
      address: address || null,
      latitude: coordinates?.lat ?? null,
      longitude: coordinates?.lon ?? null,
      osm_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      search_area: location.display_name,
      discovered_by: user.id,
      updated_at: new Date().toISOString(),
    }];
  });

  let saved: Record<string, unknown>[] = [];
  if (prospects.length) {
    const { error: saveError } = await supabase.from("business_prospects").upsert(prospects, {
      onConflict: "organization_id,osm_type,osm_id",
    });
    if (saveError) return textResponse("Search completed but prospects could not be saved", 500);
    const osmIds = prospects.map((prospect) => prospect.osm_id);
    const { data, error: reloadError } = await supabase.from("business_prospects")
      .select("id,osm_type,osm_id,name,business_type,phone,email,website,address,latitude,longitude,osm_url,search_area,status,notes,discovered_at,updated_at")
      .eq("organization_id", member.organization_id)
      .in("osm_id", osmIds)
      .order("updated_at", { ascending: false });
    if (reloadError) return textResponse("Prospects were saved but could not be loaded", 500);
    saved = data ?? [];
  }

  try {
    await writeAuditLog(supabase, {
      organizationId: member.organization_id,
      actorId: user.id,
      action: "business_prospects.discovered",
      entityType: "business_prospect_search",
      metadata: { area: location.display_name, category: parsed.data.category, result_count: saved.length },
    });
  } catch {
    return textResponse("Prospects were saved but the discovery event could not be audited", 500);
  }
  return NextResponse.json({
    data: saved,
    search: { area: location.display_name, category: parsed.data.category, found: saved.length },
    attribution: "© OpenStreetMap contributors",
  }, { headers: { "Cache-Control": "private, no-store" } });
}
