import { z } from "zod";
import type { ListingProvider } from "./types";

export const rentCastConfigurationSchema = z.object({
  provider: z.literal("rentcast"),
  listingType: z.enum(["sale", "rental"]),
  city: z.string().trim().min(2).max(120).optional(),
  state: z.string().trim().length(2).regex(/^[A-Z]{2}$/).optional(),
  zipCode: z.string().trim().regex(/^\d{5}$/).optional(),
  maxResults: z.number().int().min(1).max(100),
}).refine((value) => {
  const hasZip = Boolean(value.zipCode);
  const hasCityAndState = Boolean(value.city && value.state);
  return hasZip !== hasCityAndState && !(hasZip && (value.city || value.state));
});

const contactSchema = z.object({
  name: z.string().trim().max(200).nullish().transform((value) => value || undefined),
  email: z.string().trim().max(254).nullish().transform((value) => value || undefined),
  phone: z.string().trim().max(40).nullish().transform((value) => value || undefined),
}).passthrough();

export const rentCastListingSchema = z.object({
  id: z.string().trim().min(1).max(200),
  formattedAddress: z.string().trim().max(500).nullish().transform((value) => value || undefined),
  city: z.string().trim().min(2).max(120),
  state: z.string().trim().min(2).max(120).nullish().transform((value) => value || undefined),
  zipCode: z.string().trim().max(20).nullish().transform((value) => value || undefined),
  propertyType: z.string().trim().max(100).nullish().transform((value) => value || undefined),
  price: z.number().nonnegative().max(1_000_000_000_000).nullish().transform((value) => value ?? undefined),
  listingDate: z.string().nullish().transform((value) => value || undefined),
  bedrooms: z.number().int().nonnegative().max(100).nullish().transform((value) => value ?? undefined),
  bathrooms: z.number().nonnegative().max(100).nullish().transform((value) => value ?? undefined),
  listingAgent: contactSchema.nullish().transform((value) => value ?? undefined),
  listingOffice: contactSchema.nullish().transform((value) => value ?? undefined),
}).passthrough();

export type RentCastConfiguration = z.infer<typeof rentCastConfigurationSchema>;
export type RentCastListing = z.infer<typeof rentCastListingSchema>;

async function search(configuration: RentCastConfiguration, apiKey: string) {
  const endpointType = configuration.listingType === "sale" ? "sale" : "rental/long-term";
  const url = new URL(`https://api.rentcast.io/v1/listings/${endpointType}`);
  if (configuration.zipCode) url.searchParams.set("zipCode", configuration.zipCode);
  else {
    url.searchParams.set("city", configuration.city!);
    url.searchParams.set("state", configuration.state!);
  }
  url.searchParams.set("limit", String(configuration.maxResults));

  const response = await fetch(url, {
    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`RentCast returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("RentCast returned an unexpected response format");

  const listings: RentCastListing[] = [];
  let rejected = 0;
  for (const item of payload) {
    const parsed = rentCastListingSchema.safeParse(item);
    if (parsed.success) listings.push(parsed.data);
    else rejected += 1;
  }
  if (rejected && !listings.length) throw new Error("RentCast returned records that did not match the supported listing schema");
  return { listings, discovered: payload.length, rejected };
}

export const rentCastProvider: ListingProvider<RentCastConfiguration, RentCastListing> = {
  id: "rentcast",
  supportedCountries: ["US"],
  minimumIntervalMs: 24 * 60 * 60 * 1000,
  parseConfiguration(value) {
    return rentCastConfigurationSchema.parse(value);
  },
  search,
};
