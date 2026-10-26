import { createHash } from "node:crypto";
import { z } from "zod";
import { listingTypeSchema, posterTypeSchema } from "./providers/types.ts";

export const listingBaseSchema = z.object({
  sourceName: z.string().trim().min(2).max(120).default("Manual entry"),
  sourceType: z.enum(["manual", "approved_feed", "partner_feed", "public_api"]).default("manual"),
  sourceUrl: z.string().url().max(2048).refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  }, "Source URL must use HTTPS and must not contain credentials").optional(),
  externalId: z.string().trim().max(200).optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).optional(),
  propertyType: z.enum(["house", "apartment", "land", "commercial", "other"]),
  listingType: listingTypeSchema.default("sale"),
  area: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(120),
  region: z.string().trim().max(120).optional(),
  countryCode: z.string().trim().length(2).toUpperCase().regex(/^[A-Z]{2}$/),
  price: z.number().positive().max(1_000_000_000_000).optional(),
  bedrooms: z.number().int().min(0).max(100).optional(),
  bathrooms: z.number().min(0).max(100).optional(),
  currency: z.string().trim().length(3).toUpperCase().regex(/^[A-Z]{3}$/).default("USD"),
  ownerLedClaim: z.boolean().default(false),
  posterType: posterTypeSchema.exclude(["OWNER_VERIFIED"]).default("UNKNOWN"),
  posterConfidence: z.number().int().min(0).max(100).optional(),
  posterEvidence: z.string().trim().max(1000).optional(),
  posterMethod: z.enum(["source_metadata", "owner_submission", "manual_review"]).default("manual_review"),
  publicContactContext: z.string().trim().max(500).optional(),
  firstSeenAt: z.coerce.date().optional(),
  publishedAt: z.coerce.date().optional(),
  listingUpdatedAt: z.coerce.date().optional(),
  privateDetails: z.object({
    address: z.string().trim().max(500).optional(),
    ownerName: z.string().trim().max(200).optional(),
    ownerEmail: z.string().trim().email().max(254).optional(),
    ownerPhone: z.string().trim().max(40).optional(),
    listingAgentName: z.string().trim().max(200).optional(),
    listingAgentEmail: z.string().trim().email().max(254).optional(),
    listingAgentPhone: z.string().trim().max(40).optional(),
    listingOfficeName: z.string().trim().max(200).optional(),
    listingOfficeEmail: z.string().trim().email().max(254).optional(),
    listingOfficePhone: z.string().trim().max(40).optional(),
    notes: z.string().trim().max(2000).optional(),
  }).optional(),
});

export const listingInputSchema = listingBaseSchema.superRefine((input, context) => {
  if (input.sourceType === "manual" && input.ownerLedClaim) {
    if (!input.sourceUrl) {
      context.addIssue({ code: "custom", path: ["sourceUrl"], message: "Owner-seller leads need a source URL or evidence link" });
    }
    if (!input.privateDetails?.ownerEmail && !input.privateDetails?.ownerPhone) {
      context.addIssue({ code: "custom", path: ["privateDetails"], message: "Owner-seller leads need at least one owner email or phone number" });
    }
  }
  if (input.posterType === "OWNER_UNVERIFIED" && !input.posterEvidence && !input.sourceUrl) {
    context.addIssue({ code: "custom", path: ["posterEvidence"], message: "Record source evidence for an owner-unverified classification" });
  }
  if (input.posterType !== "UNKNOWN" && !input.posterEvidence && !input.sourceUrl) {
    context.addIssue({ code: "custom", path: ["posterEvidence"], message: "Record source evidence for the poster classification" });
  }
  if (input.ownerLedClaim && input.posterType !== "OWNER_UNVERIFIED") {
    context.addIssue({ code: "custom", path: ["posterType"], message: "Unverified owner claims must use the OWNER_UNVERIFIED classification" });
  }
  if (input.publicContactContext && !input.sourceUrl) {
    context.addIssue({ code: "custom", path: ["publicContactContext"], message: "A source listing URL is required to record publicly listed contact details" });
  }
});

export type ListingInput = z.infer<typeof listingInputSchema>;

export function normalizeListing(input: ListingInput) {
  const normalizedAddress = [input.area, input.city, input.region, input.countryCode]
    .filter(Boolean)
    .join("|")
    .normalize("NFKC")
    .toLocaleLowerCase("en");
  const canonicalUrl = canonicalListingUrl(input.sourceUrl);
  const identity = canonicalUrl
    ? `url:${canonicalUrl}`
    : input.externalId
      ? `external:${input.sourceName.trim().toLocaleLowerCase("en")}:${input.externalId.trim().toLocaleLowerCase("en")}`
      : `listing:${titleKey(input.title)}|${normalizedAddress}|${input.propertyType}|${input.listingType}|${input.price ?? ""}`;
  const dedupeKey = createHash("sha256").update(identity).digest("hex");
  const title = input.title.replace(/\s+/g, " ").trim();
  const summary = `${title} in ${input.area}, ${input.city}`;

  return {
    dedupeKey,
    title,
    summary: summary.slice(0, 280),
    description: input.description?.replace(/\s+/g, " ").trim() || null,
    propertyType: input.propertyType,
    listingType: input.listingType,
    area: input.area.replace(/\s+/g, " ").trim(),
    city: input.city.replace(/\s+/g, " ").trim(),
    region: input.region?.replace(/\s+/g, " ").trim() || null,
    countryCode: input.countryCode.toUpperCase(),
    price: input.price ?? null,
    bedrooms: input.bedrooms ?? null,
    bathrooms: input.bathrooms ?? null,
    currency: input.currency.toUpperCase(),
    ownerLedClaim: input.ownerLedClaim,
    posterType: input.posterType,
    posterConfidence: input.posterConfidence ?? (input.posterType === "UNKNOWN" ? null : 25),
    posterEvidence: input.posterEvidence ?? null,
    posterMethod: input.posterMethod,
    publishedAt: input.publishedAt?.toISOString() ?? input.firstSeenAt?.toISOString() ?? null,
    listingUpdatedAt: input.listingUpdatedAt?.toISOString() ?? null,
    firstSeenAt: input.firstSeenAt?.toISOString() ?? new Date().toISOString(),
    sourceUrl: canonicalUrl,
    externalId: input.externalId?.trim() || null,
  };
}

export function canonicalListingUrl(value?: string) {
  if (!value) return null;
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLocaleLowerCase("en");
  return url.toString();
}

function titleKey(title: string) {
  return title.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

export function scoreListing(input: Pick<ListingInput, "sourceType" | "ownerLedClaim" | "price" | "description" | "sourceUrl" | "firstSeenAt">) {
  const factors = [
    { id: "source", label: "Source quality", score: input.sourceType === "approved_feed" || input.sourceType === "public_api" ? 30 : input.sourceType === "partner_feed" ? 24 : 15, evidence: `Submitted via ${input.sourceType.replace("_", " ")}` },
    { id: "owner-led", label: "Owner-led signal", score: input.ownerLedClaim ? 20 : 0, evidence: input.ownerLedClaim ? "Source claims owner-listed; verification still required" : "No owner-listed signal provided" },
    { id: "completeness", label: "Listing completeness", score: (input.price ? 10 : 0) + (input.description && input.description.length >= 80 ? 15 : input.description ? 8 : 0) + (input.sourceUrl ? 10 : 0), evidence: "Based on price, description, and source reference" },
    { id: "recency", label: "Recency", score: input.firstSeenAt ? Math.min(15, Math.max(0, 15 - Math.floor((Date.now() - input.firstSeenAt.getTime()) / 86_400_000))) : 0, evidence: input.firstSeenAt ? "Based on reported first-seen date" : "First-seen date unavailable" },
  ];
  const score = Math.min(100, factors.reduce((sum, factor) => sum + factor.score, 0));
  return {
    score,
    trustScore: input.sourceType === "approved_feed" || input.sourceType === "public_api" ? 75 : input.sourceType === "partner_feed" ? 60 : 40,
    ownerLedScore: input.ownerLedClaim ? 55 : 0,
    urgencyScore: input.firstSeenAt ? Math.max(0, 100 - Math.floor((Date.now() - input.firstSeenAt.getTime()) / 86_400_000) * 6) : 0,
    qualityScore: score,
    factors,
    ruleVersion: "1.0",
  };
}

export function scoreAgentMatch(
  listing: { city: string; region: string | null; property_type: string; price?: number | null; currency?: string },
  profile: { service_areas: string[]; specialties: string[]; active: boolean; min_budget?: number | null; max_budget?: number | null; currency?: string | null },
) {
  if (!profile.active) return { score: 0, reasons: ["Agent profile is inactive"] };
  const areas = profile.service_areas.map((area) => area.toLocaleLowerCase("en"));
  const specialties = profile.specialties.map((specialty) => specialty.toLocaleLowerCase("en"));
  const cityMatch = areas.some((area) => area === listing.city.toLocaleLowerCase("en"));
  const regionMatch = Boolean(listing.region && areas.includes(listing.region.toLocaleLowerCase("en")));
  const propertyMatch = specialties.includes(listing.property_type.toLocaleLowerCase("en")) || specialties.includes("all");
  const currencyMatch = !listing.currency || !profile.currency || listing.currency === profile.currency;
  const budgetMatch = listing.price !== undefined && listing.price !== null && currencyMatch
    ? (profile.min_budget === null || profile.min_budget === undefined || listing.price >= profile.min_budget)
      && (profile.max_budget === null || profile.max_budget === undefined || listing.price <= profile.max_budget)
    : null;
  const reasons = [
    cityMatch ? "Exact city service-area match" : regionMatch ? "Regional service-area match" : "No direct service-area match",
    propertyMatch ? "Property specialty match" : "No property specialty match",
    budgetMatch === null ? "Budget compatibility not configured" : budgetMatch ? "Asking price fits agent budget" : "Asking price or currency is outside agent budget",
  ];
  return {
    score: Math.min(100, (cityMatch ? 40 : regionMatch ? 25 : 0) + (propertyMatch ? 35 : 0) + (budgetMatch === null ? 5 : budgetMatch ? 25 : 0)),
    reasons,
  };
}
