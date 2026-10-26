import { z } from "zod";

export const listingTypeSchema = z.enum(["sale", "rental"]);
export const posterTypeSchema = z.enum([
  "OWNER_VERIFIED",
  "OWNER_UNVERIFIED",
  "AGENT",
  "DEVELOPER",
  "COMPANY",
  "UNKNOWN",
]);

export type ListingType = z.infer<typeof listingTypeSchema>;
export type PosterType = z.infer<typeof posterTypeSchema>;

export type ListingSearchFilters = {
  countryCode: string;
  region?: string;
  city?: string;
  area?: string;
  propertyType?: string;
  listingType?: ListingType;
  minPrice?: number;
  maxPrice?: number;
  bedrooms?: number;
  publishedAfter?: string;
  updatedAfter?: string;
  posterType?: PosterType[];
};

export type ProviderSearchResult<TListing> = {
  listings: TListing[];
  discovered: number;
  total?: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  rejected: number;
};

export type ListingProvider<TConfiguration, TListing> = {
  id: string;
  supportedCountries: readonly string[];
  minimumIntervalMs: number;
  parseConfiguration: (value: unknown) => TConfiguration;
  search: (configuration: TConfiguration, apiKey: string) => Promise<ProviderSearchResult<TListing>>;
};
