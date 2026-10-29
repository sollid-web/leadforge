import type { CsvRecord } from "@/lib/listing-csv";

export type ScraperImportSource = {
  name: string;
  source_type: string;
  source_url: string | null;
  approved: boolean;
  active: boolean;
};

export type ScraperListingPayload = {
  sourceName: string;
  sourceType: "approved_feed" | "partner_feed";
  sourceUrl: string;
  externalId?: string;
  title: string;
  description?: string;
  propertyType: "house" | "apartment" | "land" | "commercial" | "other";
  listingType: "sale" | "rental";
  area: string;
  city: string;
  region?: string;
  countryCode: string;
  price?: number;
  currency: string;
  ownerLedClaim: boolean;
  posterType: "OWNER_UNVERIFIED" | "AGENT" | "DEVELOPER" | "COMPANY" | "UNKNOWN";
  posterDecision: "owner_candidate" | "reject_agent" | "hold_ambiguous";
  posterDecisionReason?: string;
  posterEvidence?: string;
  posterMethod: "source_metadata";
  publishedAt?: string;
  publicContactContext?: string;
  privateDetails?: {
    ownerName?: string;
    ownerEmail?: string;
    ownerPhone?: string;
    otherContactName?: string;
    otherContactEmail?: string;
    otherContactPhone?: string;
  };
};

export type ScraperCsvMapping = {
  payload?: ScraperListingPayload;
  errors: string[];
  warnings: string[];
  title: string;
  city: string;
  sourceName: string;
  hasContact: boolean;
};

const propertyTypes = new Set(["house", "apartment", "land", "commercial", "other"]);
const posterTypes = new Set(["OWNER_UNVERIFIED", "AGENT", "DEVELOPER", "COMPANY", "UNKNOWN"]);
const countryCurrencies: Record<string, string> = { US: "USD", NG: "NGN", GB: "GBP", CA: "CAD" };

function stringValue(value: string | undefined) {
  return (value ?? "").trim();
}

function inferCountryAndRegion(row: CsvRecord) {
  const explicitCountry = stringValue(row.country_code).toUpperCase();
  if (/^[A-Z]{2}$/.test(explicitCountry)) {
    return { countryCode: explicitCountry, region: stringValue(row.region) || undefined };
  }
  const locationParts = stringValue(row.location).split(",").map((part) => part.trim()).filter(Boolean);
  const state = locationParts.at(-1) ?? "";
  if (/^(FL|FLORIDA)$/i.test(state)) {
    return { countryCode: "US", region: stringValue(row.region) || "FL" };
  }
  return { countryCode: "", region: stringValue(row.region) || undefined };
}

function priceAndCurrency(row: CsvRecord, countryCode: string) {
  const rawPrice = stringValue(row.price);
  const explicitCurrency = stringValue(row.currency).toUpperCase();
  if (explicitCurrency && !/^[A-Z]{3}$/.test(explicitCurrency)) {
    return { error: "Currency must be a three-letter ISO code." };
  }
  if (!rawPrice || /^(n\/?a|unknown|not provided|not available)$/i.test(rawPrice)) {
    const currency = explicitCurrency || countryCurrencies[countryCode];
    return currency ? { currency } : { error: "Currency is missing; add a three-letter ISO code." };
  }
  const embeddedCurrency = rawPrice.match(/\b([A-Z]{3})\b/i)?.[1]?.toUpperCase();
  let currency = explicitCurrency || embeddedCurrency || "";
  if (!currency && /₦/.test(rawPrice)) currency = "NGN";
  if (!currency && /£/.test(rawPrice)) currency = "GBP";
  if (!currency && /C\$/.test(rawPrice)) currency = "CAD";
  if (!currency && /\$/.test(rawPrice) && countryCode === "US") currency = "USD";
  currency ||= countryCurrencies[countryCode] ?? "";
  const numericText = rawPrice.replace(/\b[A-Z]{3}\b/gi, "").replace(/C\$|[$£₦]/g, "").replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(numericText)) {
    return { currency: currency || undefined, warning: "Price omitted because the source value was not a single unambiguous numeric amount." };
  }
  const price = Number(numericText);
  if (!Number.isFinite(price) || price <= 0) {
    return { currency: currency || undefined, warning: "Price omitted because the source value was not a positive amount." };
  }
  if (!currency) return { error: "Price has no verifiable currency; add its three-letter ISO currency code." };
  return { price, currency };
}

function parsePublishedAt(value: string) {
  const raw = value.trim();
  if (!raw) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return undefined;
  if (dateOnly && new Date(timestamp).toISOString().slice(0, 10) !== raw) return undefined;
  return new Date(timestamp).toISOString();
}

function secureListingUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function approvedHostMatches(baseHost: string, listingHost: string) {
  const normalizedBase = baseHost.toLocaleLowerCase("en").replace(/^www\./, "");
  const normalizedListing = listingHost.toLocaleLowerCase("en").replace(/^www\./, "");
  return normalizedListing === normalizedBase || normalizedListing.endsWith(`.${normalizedBase}`);
}

export function mapScraperCsvRow(row: CsvRecord, sources: ScraperImportSource[]): ScraperCsvMapping {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sourceName = stringValue(row.source_name || row.source);
  const title = stringValue(row.title);
  const city = stringValue(row.city);
  const rawUrl = stringValue(row.source_url || row.link);
  const externalUrl = secureListingUrl(rawUrl);
  const configuredSource = sources.find((source) => source.name.trim().toLocaleLowerCase("en") === sourceName.toLocaleLowerCase("en"));

  if (!title) errors.push("Listing title is missing.");
  if (!city) errors.push("City is missing.");
  if (!sourceName) errors.push("Source name is missing.");
  if (!externalUrl) errors.push("Original listing URL is missing or is not a valid HTTPS URL.");
  if (!configuredSource) {
    errors.push("Register this source in LeadForge and approve it before importing scraper results.");
  } else {
    if (!configuredSource.approved || !configuredSource.active) errors.push("The configured LeadForge source is not approved and active.");
    if (!["approved_feed", "partner_feed"].includes(configuredSource.source_type)) {
      errors.push("Scraper CSV requires an approved external feed source, not a manual or API-provider source.");
    }
    if (!configuredSource.source_url) errors.push("The approved source needs its HTTPS base URL configured.");
    else {
      const baseUrl = secureListingUrl(configuredSource.source_url);
      if (!baseUrl) errors.push("The configured source URL is not a valid HTTPS URL.");
      else if (externalUrl && !approvedHostMatches(baseUrl.hostname, externalUrl.hostname)) {
        errors.push("Listing URL host does not match the approved source host.");
      }
    }
  }

  const { countryCode, region } = inferCountryAndRegion(row);
  if (!countryCode) errors.push("Country code is missing; provide country_code or an explicitly recognized location such as a Florida state suffix.");

  const rawListingType = stringValue(row.listing_type || row.type).toLocaleLowerCase("en");
  let listingType: "sale" | "rental" | null = null;
  if (["sale", "for sale", "fsbo", "for-sale", "buy"].includes(rawListingType)) listingType = "sale";
  else if (["rental", "rent", "for rent", "lease"].includes(rawListingType)) listingType = "rental";
  if (!listingType) errors.push("Sale or rental status is missing or unrecognized; it will not be guessed.");

  const rawPropertyType = stringValue(row.property_type).toLocaleLowerCase("en");
  const propertyType = propertyTypes.has(rawPropertyType) ? rawPropertyType as ScraperListingPayload["propertyType"] : "other";
  if (!rawPropertyType) warnings.push("Property type was not supplied; mapped to the explicit unclassified 'other' category.");
  else if (!propertyTypes.has(rawPropertyType)) warnings.push("Unrecognized property type was mapped to 'other'.");

  const explicitPosterType = stringValue(row.poster_type).toUpperCase();
  let posterType: ScraperListingPayload["posterType"] = "UNKNOWN";
  if (explicitPosterType === "OWNER_VERIFIED") {
    errors.push("Scraper CSV cannot assert OWNER_VERIFIED; manager verification is required in LeadForge.");
  } else if (posterTypes.has(explicitPosterType)) {
    posterType = explicitPosterType as ScraperListingPayload["posterType"];
  } else if (/\bfsbo\b|for sale by owner/i.test(stringValue(row.type))) {
    posterType = "OWNER_UNVERIFIED";
  }
  const requestedDecision = stringValue(row.poster_decision);
  let posterDecision: ScraperListingPayload["posterDecision"] =
    requestedDecision === "reject_agent" || requestedDecision === "hold_ambiguous" || requestedDecision === "owner_candidate"
      ? requestedDecision
      : posterType === "AGENT" || posterType === "DEVELOPER" || posterType === "COMPANY"
        ? "reject_agent"
        : posterType === "OWNER_UNVERIFIED" ? "owner_candidate" : "hold_ambiguous";
  if (posterDecision === "owner_candidate" && posterType !== "OWNER_UNVERIFIED") {
    errors.push("Owner candidate decision must remain OWNER_UNVERIFIED; source data cannot assert ownership verification.");
    posterDecision = "hold_ambiguous";
    posterType = "UNKNOWN";
  }
  if (posterDecision === "reject_agent") posterType = "AGENT";
  if (posterDecision === "hold_ambiguous") posterType = "UNKNOWN";
  const ownerLedClaim = posterDecision === "owner_candidate";
  const posterEvidence = stringValue(row.poster_evidence) || (ownerLedClaim
    ? "Scraper source labeled this record FSBO; this is not independent owner verification."
    : undefined);
  if (ownerLedClaim && !posterEvidence) errors.push("An owner-unverified classification requires source evidence.");

  const amount = priceAndCurrency(row, countryCode);
  if ("error" in amount && typeof amount.error === "string") errors.push(amount.error);
  else if (amount.warning) warnings.push(amount.warning);
  const currency = "currency" in amount ? amount.currency : "";
  const price = "price" in amount ? amount.price : undefined;
  const area = stringValue(row.area) || city;
  const bedrooms = stringValue(row.bedrooms);
  const bathrooms = stringValue(row.bathrooms);
  const bedsBaths = stringValue(row.beds_baths);
  const bedroomCount = bedrooms || bedsBaths.match(/(\d+)\s*(?:bd|bed(?:room)?s?)\b/i)?.[1];
  const bathroomCount = bathrooms || bedsBaths.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath(?:room)?s?)\b/i)?.[1];
  const bedroomValue = bedroomCount === undefined ? undefined : Number(bedroomCount);
  const bathroomValue = bathroomCount === undefined ? undefined : Number(bathroomCount);
  if (bedroomValue !== undefined && (!Number.isInteger(bedroomValue) || bedroomValue < 0 || bedroomValue > 100)) errors.push("Bedroom count is invalid.");
  if (bathroomValue !== undefined && (!Number.isFinite(bathroomValue) || bathroomValue < 0 || bathroomValue > 100)) errors.push("Bathroom count is invalid.");

  const contactName = stringValue(row.owner_name);
  const contactEmail = stringValue(row.email || row.owner_email);
  const contactPhone = stringValue(row.phone || row.owner_phone);
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) errors.push("Contact email is malformed.");
  const hasContact = Boolean(contactName || contactEmail || contactPhone);
  const contactFields = hasContact
    ? ownerLedClaim
      ? {
          ownerName: contactName || undefined,
          ownerEmail: contactEmail || undefined,
          ownerPhone: contactPhone || undefined,
        }
      : {
          otherContactName: contactName || undefined,
          otherContactEmail: contactEmail || undefined,
          otherContactPhone: contactPhone || undefined,
        }
    : undefined;
  const dateRaw = stringValue(row.published_at || row.date_posted);
  const publishedAt = parsePublishedAt(dateRaw);
  if (dateRaw && !publishedAt) warnings.push("Publication date was not a valid ISO-compatible date and was omitted.");

  if (errors.length || !configuredSource || !externalUrl || !listingType || !countryCode || !currency) {
    return { errors, warnings, title, city, sourceName, hasContact };
  }

  const payload: ScraperListingPayload = {
    sourceName: configuredSource.name,
    sourceType: configuredSource.source_type as "approved_feed" | "partner_feed",
    sourceUrl: externalUrl.toString(),
    externalId: stringValue(row.external_id || row.id) || undefined,
    title,
    description: stringValue(row.description || row.notes) || undefined,
    propertyType,
    listingType,
    area,
    city,
    region,
    countryCode,
    price,
    currency,
    ownerLedClaim,
    posterType,
    posterDecision,
    posterDecisionReason: stringValue(row.poster_decision_reason) || undefined,
    posterEvidence,
    posterMethod: "source_metadata",
    publishedAt,
    publicContactContext: hasContact
      ? ownerLedClaim
        ? "Unverified owner-contact candidate extracted from an owner-listed source page; identity and role require manager verification. Contact permission remains unknown."
        : "Contact details were extracted from the source listing by the scraper; identity and role are not independently verified. Contact permission remains unknown."
      : undefined,
    privateDetails: contactFields,
  };
  return { payload, errors, warnings, title, city, sourceName, hasContact };
}

export function hasLegacyScraperHeaders(headers: string[]) {
  const normalized = new Set(headers.map((header) => header.trim().toLocaleLowerCase("en").replace(/[\s-]+/g, "_")));
  return ["source", "city", "title", "link"].every((header) => normalized.has(header));
}
