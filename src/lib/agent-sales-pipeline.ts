export type PipelineListing = {
  id: string;
  title: string;
  city: string;
  country_code: string;
  currency: string;
  property_type: string;
  listing_type: string;
  price: number | null;
  owner_led_claim: boolean;
  poster_type: string;
  source_url: string | null;
  status: string;
  suppressed_at?: string | null;
  has_contact_information: boolean;
  last_seen_at: string | null;
  first_seen_at?: string | null;
  created_at?: string | null;
  region?: string | null;
  source_name?: string | null;
};

export type BatchQualification = {
  qualified: PipelineListing[];
  rejected: Array<{ id: string; title: string; reasons: string[] }>;
  summary: {
    leadCount: number;
    city: string;
    region: string | null;
    countryCode: string;
    currency: string;
    ownerVerified: number;
    ownerUnverified: number;
    contactsAvailable: number;
    contactPercent: number;
    propertyTypes: Record<string, number>;
    listingTypes: Record<string, number>;
    priceMin: number | null;
    priceMax: number | null;
    sourceCoverage: string[];
    firstSeenFrom: string | null;
    lastSeenThrough: string | null;
  };
};

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
}

function safeHttpsUrl(value: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function qualifyBatchListings(
  listings: PipelineListing[],
  options: { now?: number; maxFreshnessDays?: number; soldListingIds?: Set<string> } = {},
): BatchQualification {
  const now = options.now ?? Date.now();
  const maxAgeMs = (options.maxFreshnessDays ?? 14) * 24 * 60 * 60 * 1000;
  const first = listings[0];
  const marketCity = normalize(first?.city);
  const marketCountry = (first?.country_code ?? "").trim().toUpperCase();
  const marketCurrency = (first?.currency ?? "").trim().toUpperCase();
  const qualified: PipelineListing[] = [];
  const rejected: BatchQualification["rejected"] = [];

  for (const listing of listings) {
    const reasons: string[] = [];
    if (!listing.city?.trim() || !/^[A-Z]{2}$/i.test(listing.country_code ?? "")) reasons.push("City or two-letter country code is missing or ambiguous.");
    if (normalize(listing.city) !== marketCity || listing.country_code.toUpperCase() !== marketCountry) reasons.push("Listing does not belong to the batch's exact city and country.");
    if (listing.currency.toUpperCase() !== marketCurrency) reasons.push("Currency differs from the batch currency.");
    if (!listing.owner_led_claim || !["OWNER_UNVERIFIED", "OWNER_VERIFIED"].includes(listing.poster_type)) reasons.push("Lead is not classified as an owner-indicated listing.");
    if (["closed", "suppressed"].includes(listing.status) || listing.suppressed_at) reasons.push("Listing is closed or suppressed.");
    if (!safeHttpsUrl(listing.source_url)) reasons.push("Original source URL is missing or is not valid HTTPS.");
    if (options.soldListingIds?.has(listing.id)) reasons.push("Listing is already sold or reserved under an active offer.");
    const seenAt = listing.last_seen_at ?? listing.first_seen_at ?? listing.created_at ?? null;
    const seenMs = seenAt ? Date.parse(seenAt) : Number.NaN;
    if (!Number.isFinite(seenMs)) reasons.push("Listing freshness date is missing or invalid.");
    else if (seenMs > now + 5 * 60 * 1000) reasons.push("Listing freshness timestamp is in the future.");
    else if (now - seenMs > maxAgeMs) reasons.push(`Listing is older than the ${options.maxFreshnessDays ?? 14}-day freshness limit.`);
    if (reasons.length) rejected.push({ id: listing.id, title: listing.title, reasons });
    else qualified.push(listing);
  }

  const prices = qualified.map((listing) => listing.price).filter((price): price is number => price !== null && Number.isFinite(price) && price >= 0).sort((a, b) => a - b);
  const propertyTypes: Record<string, number> = {};
  const listingTypes: Record<string, number> = {};
  for (const listing of qualified) {
    propertyTypes[listing.property_type] = (propertyTypes[listing.property_type] ?? 0) + 1;
    listingTypes[listing.listing_type] = (listingTypes[listing.listing_type] ?? 0) + 1;
  }
  const ownerVerified = qualified.filter((listing) => listing.poster_type === "OWNER_VERIFIED").length;
  const ownerUnverified = qualified.filter((listing) => listing.poster_type === "OWNER_UNVERIFIED").length;
  const contactsAvailable = qualified.filter((listing) => listing.has_contact_information).length;
  const dates = qualified.map((listing) => Date.parse(listing.last_seen_at ?? listing.first_seen_at ?? listing.created_at ?? "")).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    qualified,
    rejected,
    summary: {
      leadCount: qualified.length,
      city: first?.city?.trim() ?? "",
      region: first?.region?.trim() || null,
      countryCode: marketCountry,
      currency: marketCurrency,
      ownerVerified,
      ownerUnverified,
      contactsAvailable,
      contactPercent: qualified.length ? Math.round(contactsAvailable * 100 / qualified.length) : 0,
      propertyTypes,
      listingTypes,
      priceMin: prices[0] ?? null,
      priceMax: prices.at(-1) ?? null,
      sourceCoverage: [...new Set(qualified.map((listing) => listing.source_name).filter((value): value is string => Boolean(value)))].sort(),
      firstSeenFrom: dates.length ? new Date(dates[0]).toISOString() : null,
      lastSeenThrough: dates.length ? new Date(dates.at(-1)!).toISOString() : null,
    },
  };
}

export type BatchMatchFacts = {
  city: string;
  region?: string | null;
  countryCode: string;
  currency: string;
  leadCount: number;
  propertyTypes: Record<string, number>;
  listingTypes: Record<string, number>;
  priceMin: number | null;
  priceMax: number | null;
  freshnessDays: number;
};

export type DirectoryAgent = {
  id: string;
  name: string;
  country_code: string;
  city: string;
  service_areas: string[];
  preferred_property_types: string[];
  preferred_listing_types: string[];
  preferred_currency: string | null;
  min_lead_volume: number | null;
  max_lead_volume: number | null;
  min_budget: number | null;
  max_budget: number | null;
  status: string;
};

export type AgentBatchMatch = {
  agentId: string;
  agentName: string;
  score: number;
  factors: Array<{ factor: string; points: number; explanation: string }>;
};

export function matchAgentsToBatch(batch: BatchMatchFacts, agents: DirectoryAgent[]) {
  const matches: AgentBatchMatch[] = [];
  const excluded: Array<{ agentId: string; agentName: string; reason: string }> = [];
  const batchPropertyTypes = Object.keys(batch.propertyTypes);
  const batchListingTypes = Object.keys(batch.listingTypes);
  const batchPrices = [batch.priceMin, batch.priceMax].filter((value): value is number => value !== null);
  for (const agent of agents) {
    const reject = (reason: string) => excluded.push({ agentId: agent.id, agentName: agent.name, reason });
    if (["inactive", "opted_out"].includes(agent.status)) { reject("Agent is inactive or opted out."); continue; }
    if (agent.country_code.toUpperCase() !== batch.countryCode.toUpperCase()) { reject("Country does not match; cross-country offers are blocked."); continue; }
    const serviceAreas = new Set(agent.service_areas.map(normalize));
    const cityMatch = normalize(agent.city) === normalize(batch.city);
    const areaMatch = [batch.city, `${batch.city}, ${batch.region ?? ""}`, `${batch.city}, ${batch.countryCode}`].some((place) => serviceAreas.has(normalize(place)));
    if (!cityMatch && !areaMatch) { reject("Agent city/service area does not exactly cover this market."); continue; }
    if (agent.preferred_currency && agent.preferred_currency.toUpperCase() !== batch.currency.toUpperCase()) { reject("Preferred currency differs from batch currency."); continue; }
    if (agent.min_lead_volume !== null && batch.leadCount < agent.min_lead_volume) { reject("Batch is below the agent's minimum preferred lead volume."); continue; }
    if (agent.max_lead_volume !== null && batch.leadCount > agent.max_lead_volume) { reject("Batch exceeds the agent's maximum preferred lead volume."); continue; }
    if (agent.min_budget !== null && batch.priceMax !== null && batch.priceMax < agent.min_budget) { reject("Batch asking-price range is below the agent's minimum budget."); continue; }
    if (agent.max_budget !== null && batch.priceMin !== null && batch.priceMin > agent.max_budget) { reject("Batch asking-price range is above the agent's maximum budget."); continue; }

    let score = 0;
    const factors: AgentBatchMatch["factors"] = [];
    const geographyPoints = cityMatch ? 30 : 25;
    score += geographyPoints;
    factors.push({ factor: "Market coverage", points: geographyPoints, explanation: cityMatch ? `Agent city exactly matches ${batch.city}, ${batch.countryCode}.` : `Configured service area explicitly includes ${batch.city}.` });
    score += 15;
    factors.push({ factor: "Country", points: 15, explanation: `Country matches ${batch.countryCode}.` });
    if (agent.preferred_currency) {
      score += 10;
      factors.push({ factor: "Currency", points: 10, explanation: `Preferred currency matches ${batch.currency}.` });
    }
    const propertyOverlap = agent.preferred_property_types.includes("all") ? batchPropertyTypes.length : batchPropertyTypes.filter((value) => agent.preferred_property_types.includes(value)).length;
    if (agent.preferred_property_types.length) {
      if (!propertyOverlap) { reject("No preferred property type overlaps the batch."); continue; }
      const points = Math.round(15 * propertyOverlap / Math.max(batchPropertyTypes.length, 1));
      score += points;
      factors.push({ factor: "Property type", points, explanation: `${propertyOverlap} of ${batchPropertyTypes.length} batch property types match preferences.` });
    } else {
      score += 8;
      factors.push({ factor: "Property type", points: 8, explanation: "No property-type preference was provided; neutral partial match." });
    }
    const listingOverlap = agent.preferred_listing_types.filter((value) => batchListingTypes.includes(value)).length;
    if (agent.preferred_listing_types.length) {
      if (!listingOverlap) { reject("No sale/rental category overlaps the batch."); continue; }
      const points = Math.round(15 * listingOverlap / Math.max(batchListingTypes.length, 1));
      score += points;
      factors.push({ factor: "Sale/rental", points, explanation: `${listingOverlap} of ${batchListingTypes.length} listing categories match preferences.` });
    } else {
      score += 8;
      factors.push({ factor: "Sale/rental", points: 8, explanation: "No sale/rental preference was provided; neutral partial match." });
    }
    const freshnessPoints = Math.max(0, Math.min(15, 15 - Math.round(batch.freshnessDays / 2)));
    score += freshnessPoints;
    factors.push({ factor: "Freshness", points: freshnessPoints, explanation: `Batch meets the ${batch.freshnessDays}-day freshness limit.` });
    if (batchPrices.length && (agent.min_budget !== null || agent.max_budget !== null)) {
      score += 7;
      factors.push({ factor: "Budget", points: 7, explanation: "Known batch asking-price range overlaps the agent's stated budget." });
    }
    matches.push({ agentId: agent.id, agentName: agent.name, score: Math.min(100, score), factors });
  }
  matches.sort((a, b) => b.score - a.score || a.agentName.localeCompare(b.agentName));
  return { matches, excluded };
}

export type OfferMessageFacts = {
  batchName: string;
  city: string;
  countryCode: string;
  leadCount: number;
  contactCount: number;
  ownerVerified: number;
  ownerUnverified: number;
  propertyTypes: Record<string, number>;
  listingTypes: Record<string, number>;
  exclusive: boolean;
  priceLabel: string;
};

export type OfferTemplateKey = "initial_offer" | "follow_up" | "sample_request" | "negotiation" | "purchase_confirmation" | "delivery_notification";

export function composeOfferTemplate(template: OfferTemplateKey, agentName: string, batch: OfferMessageFacts) {
  const properties = Object.keys(batch.propertyTypes).sort().join(", ") || "property types not reported";
  const categories = Object.keys(batch.listingTypes).sort().join(" and ") || "listing categories not reported";
  const sharing = batch.exclusive ? "This offer is for an exclusive batch; availability is subject to the recorded sale check." : "This is a shared batch and may be offered to other buyers.";
  const facts = `${batch.leadCount} owner-indicated property listings in ${batch.city}, ${batch.countryCode}, covering ${properties} and ${categories}; ${batch.contactCount} of ${batch.leadCount} records have contact information recorded, with ${batch.ownerVerified} manager-verified and ${batch.ownerUnverified} owner-unverified classifications. Contact availability is not marketing consent. ${sharing}`;
  const greeting = `Hi ${agentName},`;
  const templates: Record<OfferTemplateKey, string> = {
    initial_offer: `${greeting} I have prepared ${facts} Asking price: ${batch.priceLabel}. Would you like to review the batch details?`,
    follow_up: `${greeting} following up on the ${facts} Asking price: ${batch.priceLabel}. Would you like to discuss the actual batch summary?`,
    sample_request: `${greeting} I can review a permitted sample of the ${batch.batchName}. The sample will not expose restricted contact details; the batch contains ${batch.leadCount} records in ${batch.city}, ${batch.countryCode}.`,
    negotiation: `${greeting} the configured asking price for ${batch.batchName} is ${batch.priceLabel}. Any revised amount will be recorded against this offer before acceptance. ${sharing}`,
    purchase_confirmation: `${greeting} your recorded offer for ${batch.batchName} is accepted at ${batch.priceLabel}. Payment must be reconciled by an authorized operator before access is enabled.`,
    delivery_notification: `${greeting} access to ${batch.batchName} is now available in your authorized LeadForge account. The batch contains ${batch.leadCount} records; sharing terms: ${batch.exclusive ? "exclusive" : "shared"}.`,
  };
  return templates[template];
}

export function toMinorUnits(amount: number, currency: string) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Amount must be a non-negative finite number.");
  const normalizedCurrency = currency.trim().toUpperCase();
  const fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency: normalizedCurrency }).resolvedOptions().maximumFractionDigits ?? 2;
  const multiplier = 10 ** fractionDigits;
  const scaled = amount * multiplier;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-7) throw new Error(`Amount has more than ${fractionDigits} fraction digits for ${normalizedCurrency}.`);
  return Math.round(scaled);
}

export function formatCurrencyAmount(minorUnits: number, currency: string) {
  const normalizedCurrency = currency.trim().toUpperCase();
  const fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency: normalizedCurrency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat("en", { style: "currency", currency: normalizedCurrency }).format(minorUnits / 10 ** fractionDigits);
}

export const offerTransitions: Record<string, string[]> = {
  draft: ["ready_for_review", "cancelled"],
  ready_for_review: ["approved", "declined", "expired", "cancelled"],
  approved: ["sent", "declined", "expired", "cancelled"],
  sent: ["responded", "declined", "expired", "cancelled"],
  responded: ["interested", "declined", "cancelled"],
  interested: ["accepted", "declined", "expired", "cancelled"],
  accepted: ["cancelled"],
  paid: ["delivered", "refunded"],
  delivered: ["refunded"],
};

export function canTransitionOffer(from: string, to: string) {
  return offerTransitions[from]?.includes(to) ?? false;
}
