import { timingSafeEqual } from "node:crypto";

export const ownerScraperCities = [
  "Miami",
  "Fort Lauderdale",
  "West Palm Beach",
  "Broward",
  "Boca Raton",
  "Hialeah",
  "Palm Beach",
] as const;

const adapters: Record<string, { name: string; host: string }> = {
  craigslist: { name: "Craigslist", host: "craigslist.org" },
  forsalebyowner: { name: "ForSaleByOwner.com", host: "forsalebyowner.com" },
  byowner: { name: "ByOwner.com", host: "byowner.com" },
};

const citiesByAdapter: Record<string, readonly string[]> = {
  craigslist: ["Miami", "Fort Lauderdale", "West Palm Beach", "Broward"],
  forsalebyowner: ["Miami", "Fort Lauderdale", "West Palm Beach", "Boca Raton", "Hialeah"],
  byowner: ["Miami", "Broward", "Palm Beach"],
};

export type WorkerSource = {
  source_key: string;
  name: string;
  source_type: string;
  source_url: string | null;
  approved: boolean;
  active: boolean;
};

export function ownerScraperCitiesForSource(sourceKey: string) {
  return citiesByAdapter[sourceKey] ?? [];
}

export function ownerScraperSourceSupportsCity(sourceKey: string, city: string) {
  return ownerScraperCitiesForSource(sourceKey).includes(city);
}

export function validateOwnerScraperSource(source: WorkerSource) {
  const adapter = adapters[source.source_key];
  if (!adapter) return "This source is not one of the worker's supported owner-listing adapters.";
  if (source.name !== adapter.name) return `The source name must exactly match ${adapter.name} so scraper provenance remains attributable.`;
  if (!source.approved || !source.active) return "The source must be approved and active before collection.";
  if (!["approved_feed", "partner_feed"].includes(source.source_type)) return "The worker requires an approved external feed source.";
  if (!source.source_url) return "The source must have an HTTPS base URL configured.";
  try {
    const url = new URL(source.source_url);
    const host = url.hostname.toLocaleLowerCase("en").replace(/^www\./, "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "The source URL must be a credential-free HTTPS base URL.";
    if (url.pathname !== "/") return "The source URL must be a base domain without a page path.";
    if (host !== adapter.host && !host.endsWith(`.${adapter.host}`)) return "The source URL host does not match the configured owner-listing adapter.";
  } catch {
    return "The approved source URL is invalid.";
  }
  return null;
}

export function workerRunsEndpoint() {
  const raw = process.env.LEADFORGE_SCRAPER_WORKER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.pathname.replace(/\/+$/, "") !== "/runs" || url.search || url.hash || url.username || url.password) return null;
    if (url.protocol === "https:") return url.toString().replace(/\/$/, "");
    if (process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return url.toString().replace(/\/$/, "");
  } catch {
    // Reject malformed configuration without exposing it.
  }
  return null;
}

export function trustedCallbackOrigin() {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function hasValidBearer(request: Request, expected: string | undefined, minimumLength = 32) {
  if (!expected || expected.length < minimumLength) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
