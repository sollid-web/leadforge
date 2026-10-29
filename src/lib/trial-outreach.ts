import type { SupabaseClient } from "@supabase/supabase-js";

export type TrialListingFacts = {
  id: string;
  title: string;
  city: string;
  region: string | null;
  countryCode: string;
  currency: string;
  propertyType: string;
  listingType: string;
  verificationStatus: string;
  posterType: string;
  ownerContactPermission: string[];
  suppressedAt: string | null;
  status: string;
};

export type TrialAgentFacts = {
  id: string;
  name: string;
  city: string;
  countryCode: string;
  serviceAreas: string[];
  preferredPropertyTypes: string[];
  preferredListingTypes: string[];
  preferredCurrency: string | null;
  status: string;
  optedOutAt: string | null;
  hasContact: boolean;
  hasUsedTrial: boolean;
  linkedAccountActive?: boolean;
};

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
}

export function eligibleForTrialOutreach(listing: TrialListingFacts, agent: TrialAgentFacts) {
  if (listing.listingType !== "sale" || listing.verificationStatus !== "verified" || listing.posterType !== "OWNER_VERIFIED") return false;
  if (listing.suppressedAt || ["closed", "suppressed"].includes(listing.status)) return false;
  if (!listing.ownerContactPermission.length || listing.ownerContactPermission.every((permission) => permission === "opted_out")) return false;
  if (agent.status !== "reviewed" && agent.status !== "interested") return false;
  if (agent.optedOutAt || !agent.hasContact || agent.hasUsedTrial || agent.linkedAccountActive === false) return false;
  if (agent.countryCode.toUpperCase() !== listing.countryCode.toUpperCase()) return false;
  const market = normalize(listing.city);
  const serviceAreas = new Set(agent.serviceAreas.map(normalize));
  const cityMatches = normalize(agent.city) === market;
  const areaMatches = [listing.city, `${listing.city}, ${listing.region ?? ""}`, `${listing.city}, ${listing.countryCode}`].some((area) => serviceAreas.has(normalize(area)));
  if (!cityMatches && !areaMatches) return false;
  if (agent.preferredCurrency && agent.preferredCurrency.toUpperCase() !== listing.currency.toUpperCase()) return false;
  if (agent.preferredPropertyTypes.length && !agent.preferredPropertyTypes.includes("all") && !agent.preferredPropertyTypes.includes(listing.propertyType)) return false;
  if (agent.preferredListingTypes.length && !agent.preferredListingTypes.includes(listing.listingType)) return false;
  return true;
}

export function composeTrialOutreachDraft(agentName: string, listing: Pick<TrialListingFacts, "city" | "countryCode" | "propertyType">) {
  const greeting = agentName.trim() ? `Hi ${agentName.trim()},` : "Hello,";
  return `${greeting}\n\nWe have one owner-verified ${listing.propertyType} sale lead available in ${listing.city}, ${listing.countryCode}. Would you be interested in learning about a one-lead, no-charge trial, subject to agent eligibility and availability? If you are interested, reply and our team will confirm the next step.\n\nThis is an invitation only: no seller contact details are included, and access is not granted by this message. If you would prefer not to receive future opportunity messages, let us know.`;
}

export async function prepareTrialOutreachDrafts(
  admin: SupabaseClient,
  organizationId: string,
  listingId: string,
  actorId: string,
) {
  const { data: listingRow, error: listingError } = await admin.from("listings")
    .select("id,title,city,region,country_code,currency,property_type,listing_type,poster_type,status,suppressed_at")
    .eq("id", listingId).eq("organization_id", organizationId).maybeSingle();
  if (listingError) throw new Error("Unable to load the verified trial lead.");
  if (!listingRow) throw new Error("Verified trial lead was not found.");

  const { data: owner, error: ownerError } = await admin.from("owners")
    .select("id,verification_status").eq("organization_id", organizationId).eq("listing_id", listingId).maybeSingle();
  if (ownerError) throw new Error("Unable to verify the trial lead's owner-review state.");
  if (owner?.verification_status !== "verified" || listingRow.poster_type !== "OWNER_VERIFIED") return 0;

  const { data: contacts, error: contactError } = await admin.from("owner_contacts")
    .select("contact_permission,opted_out_at").eq("organization_id", organizationId).eq("owner_id", owner.id);
  if (contactError) throw new Error("Unable to check trial lead contact permission.");
  const ownerContactPermission = (contacts ?? [])
    .filter((contact) => !contact.opted_out_at)
    .map((contact) => contact.contact_permission);

  const listing: TrialListingFacts = {
    id: listingRow.id,
    title: listingRow.title,
    city: listingRow.city,
    region: listingRow.region,
    countryCode: listingRow.country_code,
    currency: listingRow.currency,
    propertyType: listingRow.property_type,
    listingType: listingRow.listing_type,
    verificationStatus: owner.verification_status,
    posterType: listingRow.poster_type,
    ownerContactPermission,
    suppressedAt: listingRow.suppressed_at,
    status: listingRow.status,
  };

  const { data: directoryAgents, error: agentsError } = await admin.from("agent_directory")
    .select("id,name,country_code,city,service_areas,preferred_property_types,preferred_listing_types,preferred_currency,status,opted_out_at,contact_ciphertext,preferred_channel,linked_user_id")
    .eq("organization_id", organizationId)
    .in("status", ["reviewed", "interested"])
    .is("opted_out_at", null)
    .not("contact_ciphertext", "is", null)
    .limit(500);
  if (agentsError) throw new Error("Unable to load reviewed agent prospects.");
  if (!directoryAgents?.length) return 0;

  const linkedUsers = [...new Set(directoryAgents.map((agent) => agent.linked_user_id).filter((value): value is string => Boolean(value)))];
  const linkedAgentIds = new Set<string>();
  const linkedUserHasUsedTrial = new Map<string, boolean>();
  const linkedUserIsActive = new Map<string, boolean>();
  if (linkedUsers.length) {
    const { data: linkedAgents, error: linkedError } = await admin.from("agents")
      .select("id,user_id,active").eq("organization_id", organizationId).in("user_id", linkedUsers);
    if (linkedError) throw new Error("Unable to verify linked agent trial eligibility.");
    const agentIds = (linkedAgents ?? []).map((agent) => agent.id);
    if (agentIds.length) {
      const { data: samplePurchases, error: sampleError } = await admin.from("lead_purchases")
        .select("agent_id").eq("organization_id", organizationId).eq("purchase_type", "sample").in("agent_id", agentIds);
      if (sampleError) throw new Error("Unable to check whether a linked agent already used their one-lead trial.");
      for (const purchase of samplePurchases ?? []) linkedAgentIds.add(purchase.agent_id);
    }
    for (const agent of linkedAgents ?? []) {
      linkedUserHasUsedTrial.set(agent.user_id, linkedAgentIds.has(agent.id));
      linkedUserIsActive.set(agent.user_id, agent.active);
    }
  }

  const rows = directoryAgents.filter((agent) => eligibleForTrialOutreach(listing, {
    id: agent.id,
    name: agent.name,
    city: agent.city,
    countryCode: agent.country_code,
    serviceAreas: agent.service_areas ?? [],
    preferredPropertyTypes: agent.preferred_property_types ?? [],
    preferredListingTypes: agent.preferred_listing_types ?? [],
    preferredCurrency: agent.preferred_currency,
    status: agent.status,
    optedOutAt: agent.opted_out_at,
    hasContact: Boolean(agent.contact_ciphertext),
    hasUsedTrial: Boolean(agent.linked_user_id && linkedUserHasUsedTrial.get(agent.linked_user_id)),
    linkedAccountActive: agent.linked_user_id ? linkedUserIsActive.get(agent.linked_user_id) ?? false : undefined,
  })).map((agent) => ({
    organization_id: organizationId,
    listing_id: listingId,
    agent_directory_id: agent.id,
    channel: agent.preferred_channel,
    message: composeTrialOutreachDraft(agent.name, listing),
    status: "draft",
    created_by: actorId,
  }));

  if (!rows.length) return 0;
  const { data, error } = await admin.from("trial_outreach_drafts")
    .upsert(rows, { onConflict: "listing_id,agent_directory_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error("Unable to persist one-lead trial outreach drafts.");
  const eligibleAgentIds = rows.map((row) => row.agent_directory_id);
  const { data: pending, error: pendingError } = await admin.from("trial_outreach_drafts")
    .select("id").eq("organization_id", organizationId).eq("listing_id", listingId)
    .eq("status", "draft").in("agent_directory_id", eligibleAgentIds);
  if (pendingError) throw new Error("Unable to check pending trial outreach drafts.");
  return pending?.length ?? data?.length ?? 0;
}
