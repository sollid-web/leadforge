import { z } from "zod";
import type { PosterType } from "./types.ts";

const UNTERA_API_BASE = "https://api.untera.io/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;

export const unteraSearchSchema = z.object({
  country: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()),
  location: z.string().trim().min(2).max(160).optional(),
  propertyType: z.enum(["house", "apartment", "land", "commercial"]).optional(),
  transaction: z.enum(["sale", "rental"]).optional(),
  minPrice: z.number().nonnegative().max(1_000_000_000_000).optional(),
  maxPrice: z.number().nonnegative().max(1_000_000_000_000).optional(),
  minBedrooms: z.number().int().min(0).max(100).optional(),
  minSizeSqm: z.number().nonnegative().max(1_000_000).optional(),
  maxSizeSqm: z.number().nonnegative().max(1_000_000).optional(),
  page: z.number().int().min(1).max(20).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
}).refine((value) => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice, {
  message: "Minimum price must not exceed maximum price",
  path: ["minPrice"],
}).refine((value) => value.minSizeSqm === undefined || value.maxSizeSqm === undefined || value.minSizeSqm <= value.maxSizeSqm, {
  message: "Minimum property size must not exceed maximum size",
  path: ["minSizeSqm"],
});

export type UnteraSearchFilters = z.infer<typeof unteraSearchSchema>;
export type UnteraPosterType = PosterType;

export type UnteraListing = {
  providerId: string;
  title: string | null;
  description: string | null;
  url: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  address: string | null;
  propertyType: string | null;
  transaction: string | null;
  originalPrice: number | null;
  originalCurrency: string | null;
  priceUsd: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sizeSqm: number | null;
  sourceName: string | null;
  posterType: UnteraPosterType;
  posterEvidence: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  imageUrls: string[];
  contactAvailable: boolean;
  contact: { name?: string; email?: string; phone?: string } | null;
};

export class UnteraProviderError extends Error {
  readonly code: "unauthorized" | "rate_limited" | "not_found" | "unavailable" | "invalid_response" | "timeout";
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    code: "unauthorized" | "rate_limited" | "not_found" | "unavailable" | "invalid_response" | "timeout",
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "UnteraProviderError";
  }
}

function firstValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asUrl(value: unknown) {
  const candidate = asString(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function posterClassification(record: Record<string, unknown>) {
  const metadata = firstValue(record, ["poster_type", "posterType", "poster", "seller_type", "sellerType", "posted_by"]);
  const normalized = typeof metadata === "string" ? metadata.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (["owner", "private_owner", "private_seller", "landlord", "private_landlord"].includes(normalized)) {
    return { posterType: "OWNER_UNVERIFIED" as const, posterEvidence: `Untera source metadata identifies the poster as "${normalized}"; ownership is not independently verified.` };
  }
  if (["agent", "estate_agent", "real_estate_agent", "broker", "listing_agent"].includes(normalized)) {
    return { posterType: "AGENT" as const, posterEvidence: `Untera source metadata identifies the poster as "${normalized}".` };
  }
  if (["developer", "property_developer", "builder"].includes(normalized)) {
    return { posterType: "DEVELOPER" as const, posterEvidence: `Untera source metadata identifies the poster as "${normalized}".` };
  }
  if (["company", "agency", "business", "corporate"].includes(normalized)) {
    return { posterType: "COMPANY" as const, posterEvidence: `Untera source metadata identifies the poster as "${normalized}".` };
  }
  return {
    posterType: "UNKNOWN" as const,
    posterEvidence: metadata === undefined ? "No poster classification was supplied by Untera." : "Untera poster metadata did not match a recognized category.",
  };
}

function normalizeContact(record: Record<string, unknown>) {
  const candidate = firstValue(record, ["contact", "contact_details", "contactDetails", "agent", "listing_agent", "owner_contact", "seller_contact"]);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const data = candidate as Record<string, unknown>;
  const name = asString(firstValue(data, ["name", "contact_name", "contactName", "agent_name"]));
  const email = asString(firstValue(data, ["email", "contact_email", "contactEmail"]));
  const phone = asString(firstValue(data, ["phone", "telephone", "contact_phone", "contactPhone"]));
  return name || email || phone ? { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) } : null;
}

export function normalizeUnteraListing(value: unknown): UnteraListing | null {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) return null;
  const record = parsed.data;
  const images = firstValue(record, ["images", "image_urls", "imageUrls"]);
  const imageUrls = Array.isArray(images)
    ? images.map((image) => typeof image === "string" ? asUrl(image) : null).filter((url): url is string => url !== null).slice(0, 20)
    : [];
  const poster = posterClassification(record);
  const contact = normalizeContact(record);

  const id = firstValue(record, ["id", "listing_id", "listingId", "_id"]);
  if (typeof id !== "string" && typeof id !== "number") return null;
  return {
    providerId: String(id),
    title: asString(firstValue(record, ["title", "name"])),
    description: asString(firstValue(record, ["description", "summary"])),
    url: asUrl(firstValue(record, ["url", "listing_url", "listingUrl", "permalink"])),
    country: asString(firstValue(record, ["country_code", "countryCode", "country"])),
    city: asString(firstValue(record, ["city", "town"])),
    region: asString(firstValue(record, ["region", "state", "province", "county"])),
    address: asString(firstValue(record, ["address", "location"])),
    propertyType: asString(firstValue(record, ["type", "property_type", "propertyType"])),
    transaction: asString(firstValue(record, ["transaction", "listing_type", "listingType"])),
    originalPrice: asNumber(firstValue(record, ["original_price", "originalPrice"])),
    originalCurrency: asString(firstValue(record, ["original_currency", "originalCurrency"])),
    priceUsd: asNumber(firstValue(record, ["price_usd", "priceUsd"])),
    bedrooms: asNumber(firstValue(record, ["bedrooms", "beds"])),
    bathrooms: asNumber(firstValue(record, ["bathrooms", "baths"])),
    sizeSqm: asNumber(firstValue(record, ["sqm", "size_sqm", "sizeSqm", "area_sqm"])),
    sourceName: asString(firstValue(record, ["source_name", "sourceName", "portal", "source"])),
    posterType: poster.posterType,
    posterEvidence: poster.posterEvidence,
    publishedAt: asString(firstValue(record, ["published_at", "publishedAt", "listed_at", "created_at"])),
    updatedAt: asString(firstValue(record, ["updated_at", "updatedAt", "last_updated", "modified_at"])),
    imageUrls,
    contactAvailable: contact !== null,
    contact,
  };
}

function recordsFromPayload(payload: unknown) {
  if (Array.isArray(payload)) return payload;
  const parsed = z.record(z.string(), z.unknown()).safeParse(payload);
  if (!parsed.success) return null;
  const results = firstValue(parsed.data, ["results", "listings", "data"]);
  return Array.isArray(results) ? results : null;
}

function unwrapDetail(payload: unknown) {
  const parsed = z.record(z.string(), z.unknown()).safeParse(payload);
  if (!parsed.success) return payload;
  return firstValue(parsed.data, ["result", "listing", "data"]) ?? payload;
}

async function requestJson(url: URL, apiKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new UnteraProviderError("Untera request timed out. Try again later.", "timeout");
    }
    throw new UnteraProviderError("Untera could not be reached. Try again later.", "unavailable");
  }

  if (response.status === 401 || response.status === 403) {
    throw new UnteraProviderError("Untera rejected the configured API key or plan.", "unauthorized");
  }
  if (response.status === 429) {
    const retryHeader = Number(response.headers.get("retry-after"));
    throw new UnteraProviderError(
      "Untera rate limit reached. Wait before searching again.",
      "rate_limited",
      Number.isFinite(retryHeader) && retryHeader > 0 ? Math.min(3600, retryHeader) : 60,
    );
  }
  if (response.status === 404) throw new UnteraProviderError("Untera did not find that listing or resource.", "not_found");
  if (!response.ok) throw new UnteraProviderError(`Untera returned HTTP ${response.status}.`, "unavailable");
  try {
    return await response.json();
  } catch {
    throw new UnteraProviderError("Untera returned invalid JSON.", "invalid_response");
  }
}

export async function searchUnteraListings(filters: UnteraSearchFilters, apiKey: string) {
  const url = new URL(`${UNTERA_API_BASE}/listings/search`);
  url.searchParams.set("country", filters.country);
  if (filters.location) url.searchParams.set("location", filters.location);
  if (filters.propertyType) url.searchParams.set("type", filters.propertyType);
  if (filters.transaction) url.searchParams.set("transaction", filters.transaction === "rental" ? "rent" : "sale");
  if (filters.minPrice !== undefined) url.searchParams.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice !== undefined) url.searchParams.set("maxPrice", String(filters.maxPrice));
  if (filters.minBedrooms !== undefined) url.searchParams.set("minBeds", String(filters.minBedrooms));
  if (filters.minSizeSqm !== undefined) url.searchParams.set("minSqm", String(filters.minSizeSqm));
  if (filters.maxSizeSqm !== undefined) url.searchParams.set("maxSqm", String(filters.maxSizeSqm));
  url.searchParams.set("page", String(filters.page));
  url.searchParams.set("pageSize", String(filters.pageSize));

  const payload = await requestJson(url, apiKey);
  const rawRecords = recordsFromPayload(payload);
  if (!rawRecords) throw new UnteraProviderError("Untera search response did not contain a results array.", "invalid_response");
  const listings = rawRecords.map(normalizeUnteraListing).filter((listing): listing is UnteraListing => listing !== null);
  const parsedPayload = z.record(z.string(), z.unknown()).safeParse(payload);
  const pagination = parsedPayload.success && typeof parsedPayload.data.pagination === "object" && parsedPayload.data.pagination !== null
    ? parsedPayload.data.pagination as Record<string, unknown>
    : {};
  const total = asNumber(firstValue(parsedPayload.success ? parsedPayload.data : {}, ["total", "totalCount", "total_count"]))
    ?? asNumber(firstValue(pagination, ["total", "totalCount", "total_count"]))
    ?? undefined;
  const responsePage = asNumber(firstValue(parsedPayload.success ? parsedPayload.data : {}, ["page"]))
    ?? asNumber(firstValue(pagination, ["page"]))
    ?? filters.page;
  const responsePageSize = asNumber(firstValue(parsedPayload.success ? parsedPayload.data : {}, ["pageSize", "page_size"]))
    ?? asNumber(firstValue(pagination, ["pageSize", "page_size"]))
    ?? filters.pageSize;
  const hasMoreValue = firstValue(parsedPayload.success ? parsedPayload.data : {}, ["hasMore", "has_more", "nextPage"])
    ?? firstValue(pagination, ["hasMore", "has_more", "nextPage"]);
  const hasMore = typeof hasMoreValue === "boolean"
    ? hasMoreValue
    : typeof hasMoreValue === "number"
      ? hasMoreValue > responsePage
      : total !== undefined
        ? responsePage * responsePageSize < total
        : rawRecords.length === filters.pageSize;

  return {
    listings,
    discovered: rawRecords.length,
    total,
    page: responsePage,
    pageSize: responsePageSize,
    hasMore,
    rejected: rawRecords.length - listings.length,
  };
}

export async function getUnteraListingDetail(providerId: string, apiKey: string) {
  const url = new URL(`${UNTERA_API_BASE}/listings/${encodeURIComponent(providerId)}`);
  const payload = await requestJson(url, apiKey);
  const listing = normalizeUnteraListing(unwrapDetail(payload));
  if (!listing) throw new UnteraProviderError("Untera listing detail did not match the supported response schema.", "invalid_response");
  return listing;
}

export async function getUnteraSources(apiKey: string) {
  const payload = await requestJson(new URL(`${UNTERA_API_BASE}/sources`), apiKey);
  const records = recordsFromPayload(payload);
  if (!records) throw new UnteraProviderError("Untera source registry did not contain a results array.", "invalid_response");
  const sources = records.flatMap((value) => {
    const record = z.record(z.string(), z.unknown()).safeParse(value);
    if (!record.success) return [];
    const country = asString(firstValue(record.data, ["country_code", "countryCode", "country"]));
    const countryName = asString(firstValue(record.data, ["country_name", "countryName"]));
    const name = asString(firstValue(record.data, ["name", "source_name", "sourceName", "portal"]));
    const count = asNumber(firstValue(record.data, ["count", "listing_count", "listingCount", "live_count"]));
    return [{
      name,
      country,
      countryName,
      listingCount: count,
    }];
  });
  return sources;
}

export async function getUnteraStats(apiKey: string) {
  return requestJson(new URL(`${UNTERA_API_BASE}/stats`), apiKey);
}

export function unteraCountriesFromSources(sources: Awaited<ReturnType<typeof getUnteraSources>>) {
  const countries = new Map<string, string>();
  for (const source of sources) {
    if (!source.country || !/^[A-Za-z]{2}$/.test(source.country)) continue;
    const code = source.country.toUpperCase();
    const label = source.countryName ?? code;
    countries.set(code, label);
  }
  return [...countries.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function unteraPortalSource(record: UnteraListing) {
  return record.sourceName?.trim() || "Untera source";
}
