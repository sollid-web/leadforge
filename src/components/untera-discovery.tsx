"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Image from "next/image";

type ProviderResult = {
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
  posterType: string;
  posterEvidence: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  imageUrls: string[];
  contactAvailable: boolean;
};

type Source = { id: string; name: string; approved: boolean; active: boolean; source_health?: { status: string; last_sync_attempt_at: string | null; last_success_at: string | null; consecutive_failures: number; message: string | null } | null };
type Run = { id: string; source_id: string; status: string; discovered_count: number; imported_count: number; duplicate_count: number; rejected_count: number; contacts_found_count: number; known_poster_count: number; unknown_poster_count: number; error_message: string | null; started_at: string; completed_at: string | null; search_filters: Record<string, unknown> };
type Catalog = { countries: { code: string; name: string }[]; sources: { name: string | null }[]; totals: { listings?: unknown; sources?: unknown; countries?: unknown } | null };
type Integration = { apiKeyConfigured: boolean; commercialUseAuthorized: boolean; listingReuseAuthorized: boolean };
type Filters = { country: string; location: string; region: string; propertyType: string; transaction: string; minPrice: string; maxPrice: string; currency: string; minBedrooms: string; minSizeSqm: string; maxSizeSqm: string; sourceName: string; posterFilter: string; contactAvailability: string; freshnessDays: string; page: number };

const initialFilters: Filters = {
  country: "", location: "", region: "", propertyType: "", transaction: "", minPrice: "", maxPrice: "", currency: "",
  minBedrooms: "", minSizeSqm: "", maxSizeSqm: "", sourceName: "", posterFilter: "owner_candidates",
  contactAvailability: "any", freshnessDays: "", page: 1,
};
const posterNames: Record<string, string> = {
  OWNER_VERIFIED: "Owner verified", OWNER_UNVERIFIED: "Owner candidate · unverified",
  AGENT: "Agent", DEVELOPER: "Developer", COMPANY: "Company", UNKNOWN: "Unknown poster",
};

async function readError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
}

function formatPrice(price: number | null, currency: string | null) {
  if (price === null) return "Price not supplied";
  return `${currency ?? "Price"} ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(price)}`;
}

function dateLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not provided";
  return new Date(value).toLocaleDateString();
}

export function UnteraDiscovery() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [results, setResults] = useState<ProviderResult[]>([]);
  const [runId, setRunId] = useState("");
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [unknownCount, setUnknownCount] = useState<number | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [searching, setSearching] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadRuns = useCallback(async () => {
    try {
      const response = await fetch("/api/untera/runs", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setSources(body.sources as Source[]);
      setRuns(body.runs as Run[]);
      setIntegration(body.integration as Integration);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load provider diagnostics.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRuns(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRuns]);

  const activeSource = sources.find((source) => source.approved && source.active);
  const canUseApi = Boolean(integration?.apiKeyConfigured && integration.commercialUseAuthorized && activeSource);
  const canLoadCatalog = Boolean(integration?.apiKeyConfigured && integration.commercialUseAuthorized);
  const canSave = Boolean(integration?.apiKeyConfigured && integration.commercialUseAuthorized && integration.listingReuseAuthorized);

  async function loadCatalog() {
    setLoadingCatalog(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/untera/catalog", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setCatalog(body as Catalog);
      if (!filters.country && body.countries?.length) updateFilter("country", body.countries.some((country: { code: string }) => country.code === "NG") ? "NG" : body.countries[0].code);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load Untera countries and sources.");
    } finally {
      setLoadingCatalog(false);
    }
  }

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value, ...(key === "page" ? {} : { page: 1 }) }));
  }

  function asNumber(value: string, label: string) {
    if (!value.trim()) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number.`);
    return number;
  }

  async function search(event?: FormEvent<HTMLFormElement>, page = 1) {
    event?.preventDefault();
    setSearching(true);
    setError("");
    setMessage("");
    setResults([]);
    setResultCount(null);
    setUnknownCount(null);
    setNotices([]);
    try {
      if (!activeSource) throw new Error("Register an Untera public API source in Settings, then have an organization owner/admin approve it.");
      if (!filters.country.trim()) throw new Error("Choose a country from Untera's supported country list.");
      const location = [filters.location.trim(), filters.region.trim()].filter(Boolean).join(", ");
      const response = await fetch("/api/untera/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: activeSource.id,
          filters: {
            country: filters.country.trim().toUpperCase(),
            ...(location ? { location } : {}),
            ...(filters.propertyType ? { propertyType: filters.propertyType } : {}),
            ...(filters.transaction ? { transaction: filters.transaction } : {}),
            ...(filters.minPrice ? { minPrice: asNumber(filters.minPrice, "Minimum price") } : {}),
            ...(filters.maxPrice ? { maxPrice: asNumber(filters.maxPrice, "Maximum price") } : {}),
            ...(filters.minBedrooms ? { minBedrooms: asNumber(filters.minBedrooms, "Minimum bedrooms") } : {}),
            ...(filters.minSizeSqm ? { minSizeSqm: asNumber(filters.minSizeSqm, "Minimum size") } : {}),
            ...(filters.maxSizeSqm ? { maxSizeSqm: asNumber(filters.maxSizeSqm, "Maximum size") } : {}),
            page,
            pageSize: 20,
          },
          posterFilter: filters.posterFilter,
          ...(filters.currency ? { currency: filters.currency.trim().toUpperCase() } : {}),
          contactAvailability: filters.contactAvailability,
          ...(filters.freshnessDays ? { freshnessDays: Number(filters.freshnessDays) } : {}),
          ...(filters.sourceName ? { sourceName: filters.sourceName } : {}),
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setResults(body.data as ProviderResult[]);
      setRunId(body.runId as string);
      setResultCount(body.resultsReturned as number);
      setTotal(typeof body.total === "number" ? body.total : null);
      setHasMore(Boolean(body.hasMore));
      setUnknownCount(body.unknownPosterCount as number);
      setNotices(body.localFiltersApplied as string[]);
      setFilters((current) => ({ ...current, page }));
      if (!body.data.length) setMessage("Search succeeded but no listings matched the selected filters on this page.");
      else setMessage(`${body.data.length} of ${body.resultsReturned} records returned by Untera on this page.`);
      await loadRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Untera search failed.");
      await loadRuns();
    } finally {
      setSearching(false);
    }
  }

  async function saveListing(listing: ProviderResult) {
    if (!runId) return;
    setSavingId(listing.providerId);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/untera/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, providerListingId: listing.providerId }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setMessage(body.message as string);
      await loadRuns();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save this listing.");
    } finally {
      setSavingId("");
    }
  }

  const filteredSources = Array.from(new Set((catalog?.sources ?? []).map((source) => source.name).filter((name): name is string => Boolean(name)))).sort();

  return <section className="panel untera-discovery" aria-labelledby="untera-discovery-heading">
    <div className="panel-header">
      <div><p className="eyebrow">International provider</p><h2 id="untera-discovery-heading">Live property discovery</h2><p>Search Untera’s provider index, inspect source-attributed results, then explicitly import eligible records into this organization’s saved opportunities.</p></div>
      <a className="secondary-button small" href="https://untera.io" target="_blank" rel="noreferrer">Powered by Untera ↗</a>
    </div>

    <div className="untera-health">
      <div><b>Provider configuration</b><span className={integration?.apiKeyConfigured ? "health-ready" : "health-missing"}>{integration?.apiKeyConfigured ? "API key configured" : "API key missing"}</span></div>
      <div><b>Commercial search</b><span className={integration?.commercialUseAuthorized ? "health-ready" : "health-missing"}>{integration?.commercialUseAuthorized ? "Authorized" : "Written authorization required"}</span></div>
      <div><b>Save / reuse records</b><span className={integration?.listingReuseAuthorized ? "health-ready" : "health-missing"}>{integration?.listingReuseAuthorized ? "Authorized" : "Written authorization required"}</span></div>
      <div><b>Approved source</b><span className={activeSource ? "health-ready" : "health-missing"}>{activeSource?.name ?? "Not registered / approved"}</span></div>
    </div>
    {integration && !integration.apiKeyConfigured && <div className="workspace-state compact"><h3>Untera credentials are not configured</h3><p>Add the server-only UNTERA_API_KEY environment variable to enable provider catalog and search calls. Never add it to a NEXT_PUBLIC_ variable.</p></div>}
    {integration?.apiKeyConfigured && !integration.commercialUseAuthorized && <div className="workspace-state compact"><h3>Provider permission required</h3><p>Before calling Untera for this commercial workflow, confirm your plan permits commercial use. Set UNTERA_COMMERCIAL_USE_AUTHORIZED=true only after receiving written authorization.</p></div>}
    {integration?.commercialUseAuthorized && !integration.listingReuseAuthorized && <p className="form-hint">Search can be used under your confirmed plan, but saving provider records is disabled until written permission confirms retention and lead redistribution. Set UNTERA_LISTING_REUSE_AUTHORIZED=true only after confirmation.</p>}

    <div className="untera-toolbar">
      <div><b>Coverage and sources</b><small>{catalog ? `${catalog.countries.length} supported country codes loaded from the provider registry.` : "Country coverage is fetched from Untera; it is not hard-coded."}</small></div>
      <button className="secondary-button small" type="button" onClick={() => void loadCatalog()} disabled={!canLoadCatalog || loadingCatalog}>{loadingCatalog ? "Loading coverage…" : catalog ? "Refresh coverage" : "Load coverage"}</button>
    </div>
    {!activeSource && <p className="form-hint">Register a source in Settings → Approved listing sources → Public listing API → Untera. An owner/admin must approve and activate it before search.</p>}
    {catalog?.totals && <p className="form-hint">Provider registry statistics: listings {String(catalog.totals.listings ?? "not reported")}, sources {String(catalog.totals.sources ?? "not reported")}, countries {String(catalog.totals.countries ?? catalog.countries.length)}. Provider-wide counts are not this organization’s discoveries.</p>}

    <form className="untera-filter-grid" onSubmit={(event) => void search(event)}>
      <label>Country<select required value={filters.country} onChange={(event) => updateFilter("country", event.target.value)}><option value="">Select supported country</option>{catalog?.countries.map((country) => <option key={country.code} value={country.code}>{country.name} ({country.code})</option>)}</select></label>
      <label>City or location<input value={filters.location} maxLength={160} placeholder="City, neighborhood, or provider location" onChange={(event) => updateFilter("location", event.target.value)} /></label>
      <label>State / region / province<input value={filters.region} maxLength={100} placeholder="Combined with city in provider location search" onChange={(event) => updateFilter("region", event.target.value)} /></label>
      <label>Property type<select value={filters.propertyType} onChange={(event) => updateFilter("propertyType", event.target.value)}><option value="">Any type</option><option value="house">House</option><option value="apartment">Apartment</option><option value="land">Land</option><option value="commercial">Commercial</option></select></label>
      <label>Listing type<select value={filters.transaction} onChange={(event) => updateFilter("transaction", event.target.value)}><option value="">Sale or rental</option><option value="sale">For sale</option><option value="rental">For rent</option></select></label>
      <label>Min price (USD)<input type="number" min="0" value={filters.minPrice} onChange={(event) => updateFilter("minPrice", event.target.value)} /></label>
      <label>Max price (USD)<input type="number" min="0" value={filters.maxPrice} onChange={(event) => updateFilter("maxPrice", event.target.value)} /></label>
      <label>Original currency (page filter)<input value={filters.currency} maxLength={3} placeholder="e.g. NGN" onChange={(event) => updateFilter("currency", event.target.value)} /></label>
      <label>Min bedrooms<input type="number" min="0" value={filters.minBedrooms} onChange={(event) => updateFilter("minBedrooms", event.target.value)} /></label>
      <label>Min size (m²)<input type="number" min="0" value={filters.minSizeSqm} onChange={(event) => updateFilter("minSizeSqm", event.target.value)} /></label>
      <label>Max size (m²)<input type="number" min="0" value={filters.maxSizeSqm} onChange={(event) => updateFilter("maxSizeSqm", event.target.value)} /></label>
      <label>Listing source (page filter)<select value={filters.sourceName} onChange={(event) => updateFilter("sourceName", event.target.value)}><option value="">Any source</option>{filteredSources.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
      <label>Poster category<select value={filters.posterFilter} onChange={(event) => updateFilter("posterFilter", event.target.value)}><option value="owner_candidates">Owner candidates only (default)</option><option value="all">All poster categories</option>{Object.entries(posterNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <label>Contact availability (page filter)<select value={filters.contactAvailability} onChange={(event) => updateFilter("contactAvailability", event.target.value)}><option value="any">Any</option><option value="available">Provider contact available</option><option value="unavailable">No provider contact</option></select></label>
      <label>Freshness (page filter)<select value={filters.freshnessDays} onChange={(event) => updateFilter("freshnessDays", event.target.value)}><option value="">Any age</option><option value="7">Updated in 7 days</option><option value="30">Updated in 30 days</option><option value="90">Updated in 90 days</option></select></label>
      <div className="untera-search-actions"><button className="primary-button" type="submit" disabled={!canUseApi || searching}>{searching ? "Searching provider…" : "Search live listings"}</button>{catalog?.countries.length ? <small>City and region are combined in Untera’s single location filter. Page 20 · results are not saved until you select Import.</small> : <small>Load provider coverage before choosing a country.</small>}</div>
    </form>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice" role="status">{message}</div>}
    {unknownCount !== null && <div className="untera-counts"><span><b>{resultCount ?? 0}</b> provider results returned</span>{total !== null && <span><b>{total}</b> total provider results reported</span>}<span><b>{unknownCount}</b> records with unknown poster identity before page filters</span></div>}
    {notices.map((notice) => <p className="form-hint" key={notice}>{notice}</p>)}
    {searching && <div className="workspace-state compact" role="status"><h3>Searching Untera</h3><p>Results are validated by the server and remain live-only until you import them.</p></div>}
    {!searching && resultCount === 0 && <div className="workspace-state compact"><h3>No matching live results</h3><p>The provider search succeeded. Try another supported country, location, or filter combination.</p></div>}
    {results.length > 0 && <div className="untera-results" aria-live="polite">{results.map((listing) => <article className="untera-result" key={listing.providerId}>
      {listing.imageUrls[0] && <Image src={listing.imageUrls[0]} alt="" width={240} height={160} loading="lazy" unoptimized referrerPolicy="no-referrer" />}
      <div className="untera-result-content">
        <div className="untera-result-heading"><div><span className={`poster-label poster-${listing.posterType.toLowerCase()}`}>{posterNames[listing.posterType] ?? listing.posterType}</span><h3>{listing.title ?? "Untitled provider listing"}</h3></div><strong>{formatPrice(listing.originalPrice ?? listing.priceUsd, listing.originalCurrency ?? (listing.priceUsd !== null ? "USD" : null))}</strong></div>
        <p>{[listing.address, listing.city, listing.region, listing.country].filter(Boolean).join(", ") || "Location not supplied"} · {listing.propertyType ?? "Property type not supplied"} · {listing.transaction ?? "Listing type not supplied"}{listing.bedrooms !== null ? ` · ${listing.bedrooms} beds` : ""}{listing.sizeSqm !== null ? ` · ${listing.sizeSqm} m²` : ""}</p>
        <p className="untera-source-line">Source: {listing.sourceName ?? "Untera source not identified"} · Contact details {listing.contactAvailable ? "are supplied by provider; hidden until approved detail workflow" : "not supplied; visit original source listing"} · Published {dateLabel(listing.publishedAt)} · Updated {dateLabel(listing.updatedAt)}</p>
        {listing.posterEvidence && <small>{listing.posterEvidence}</small>}
        <div className="untera-result-actions">{listing.url && <a className="secondary-button small" href={listing.url} target="_blank" rel="noreferrer">View original listing ↗</a>}<button className="primary-button small" type="button" disabled={!canSave || savingId === listing.providerId || !runId} title={!canSave ? "Listing reuse permission must be confirmed in writing before imports are enabled." : undefined} onClick={() => void saveListing(listing)}>{savingId === listing.providerId ? "Importing…" : "Import to saved opportunities"}</button></div>
      </div>
    </article>)}</div>}
    {hasMore && <div className="untera-pagination"><button className="secondary-button" type="button" disabled={searching || filters.page >= 20} onClick={() => void search(undefined, filters.page + 1)}>Next provider page</button><span>Page {filters.page}</span></div>}
    <div className="untera-diagnostics">
      <div className="panel-header"><div><h3>Provider health and recent runs</h3><p>Organization-scoped diagnostics; credentials and provider contact details are never returned here.</p></div><button className="secondary-button small" type="button" onClick={() => void loadRuns()}>Refresh</button></div>
      {sources.map((source) => <div className="untera-run-row" key={source.id}><b>{source.name}</b><span>{source.approved && source.active ? "Enabled" : "Disabled / awaiting approval"}</span><span>Last attempt {dateLabel(source.source_health?.last_sync_attempt_at ?? null)}</span><span>Last success {dateLabel(source.source_health?.last_success_at ?? null)}</span><span>{source.source_health?.message ?? source.source_health?.status ?? "No provider request yet"}</span></div>)}
      {!runs.length && <p className="form-hint">No Untera discovery runs recorded for this organization.</p>}
      {runs.map((run) => <div className="untera-run-row" key={run.id}><b>{run.status} · {new Date(run.started_at).toLocaleString()}</b><span>{run.discovered_count} returned · {run.imported_count} imported · {run.duplicate_count} duplicates</span><span>{run.contacts_found_count} with provider contacts</span><span>{run.known_poster_count} known / {run.unknown_poster_count} unknown posters</span>{run.error_message && <span role="alert">{run.error_message}</span>}</div>)}
    </div>
    <p className="untera-attribution"><a href="https://untera.io" target="_blank" rel="noreferrer">Powered by Untera</a>. Source portal listings and metadata remain subject to provider and source terms. Untera data does not establish property ownership or marketing consent.</p>
  </section>;
}
