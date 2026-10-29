export const ownerScraperCities = [
  "Miami",
  "Fort Lauderdale",
  "West Palm Beach",
  "Broward",
  "Boca Raton",
  "Hialeah",
  "Palm Beach",
] as const;

export const ownerScraperAdapters: Record<string, { name: string; host: string }> = {
  craigslist: { name: "Craigslist", host: "craigslist.org" },
  forsalebyowner: { name: "ForSaleByOwner.com", host: "forsalebyowner.com" },
  byowner: { name: "ByOwner.com", host: "byowner.com" },
};

const sourceKeyAliases: Record<string, string> = {
  "forsalebyowner-com": "forsalebyowner",
  "byowner-com": "byowner",
};

const citiesByAdapter: Record<string, readonly string[]> = {
  craigslist: ["Miami", "Fort Lauderdale", "West Palm Beach", "Broward"],
  forsalebyowner: ["Miami", "Fort Lauderdale", "West Palm Beach", "Boca Raton", "Hialeah"],
  byowner: ["Miami", "Broward", "Palm Beach"],
};

export function canonicalOwnerScraperSourceKey(sourceKey: string) {
  const key = sourceKey.trim().toLocaleLowerCase("en");
  return sourceKeyAliases[key] ?? key;
}

export function ownerScraperCitiesForSource(sourceKey: string) {
  return citiesByAdapter[canonicalOwnerScraperSourceKey(sourceKey)] ?? [];
}

export function ownerScraperSourceSupportsCity(sourceKey: string, city: string) {
  return ownerScraperCitiesForSource(sourceKey).includes(city);
}
