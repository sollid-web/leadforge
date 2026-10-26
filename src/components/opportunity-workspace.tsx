"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ScoreBadge, StatusPill } from "@/components/dashboard-shell";
import { parseCsv } from "@/lib/listing-csv";

type Opportunity = {
  id: string;
  title: string;
  summary: string;
  property_type: string;
  listing_type: "sale" | "rental";
  area: string;
  city: string;
  region: string | null;
  country_code: string;
  price: number | null;
  bedrooms: number | null;
  currency: string;
  owner_led_claim: boolean;
  poster_type: string;
  poster_confidence: number | null;
  poster_evidence: string | null;
  has_public_contact: boolean;
  has_contact_information: boolean;
  published_at: string | null;
  listing_updated_at: string | null;
  last_seen_at: string;
  source_id: string;
  listing_sources: { name: string } | null;
  listing_source_links: { canonical_url: string | null; source_name: string; last_seen_at: string }[];
  owners: { verification_status: string } | null;
  status: string;
  created_at: string;
  score: { score: number; trust_score: number; factors: { label: string; evidence: string; score: number }[] } | null;
};
type DiscoveryMetrics = {
  totalDiscovered: number;
  ownerVerified: number;
  ownerUnverified: number;
  agentsExcludedByDefault: number;
  listingsWithPublicContacts: number;
  listingsMissingContact: number;
  newlyDiscoveredLast7Days: number;
  staleListings: number;
  duplicatesPrevented: number;
  failedSources: number;
  lastSuccessfulCollectionAt: string | null;
};

type Match = {
  id: string;
  listing_id: string;
  score: number;
  status: string;
  listing: Pick<Opportunity, "id" | "title" | "summary" | "property_type" | "area" | "city" | "price" | "currency" | "owner_led_claim"> | null;
  interest: {
    id: string;
    status: string;
    purchase: { purchase_type: "sample" | "paid"; status: "sample" | "payment_required" | "checkout_pending" | "paid"; amount_cents: number; currency: string } | null;
  } | null;
};

type MatchSuggestion = { id: string; agent_id: string; display_name: string; score: number; reasons: string[] };
type SourceOption = { id: string; name: string };
type ContactType = "listing_agent" | "listing_office" | "owner";
type ContactOption = {
  contactType: ContactType;
  available: boolean;
  status: "unknown" | "permitted" | "opted_out";
  lawfulBasis: string | null;
  evidenceReference: string | null;
  ownerVerified?: boolean;
  recentOutreachStatus: "processing" | "sent" | "failed" | null;
  lastSentAt: string | null;
};

async function getError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
}

export function OpportunityWorkspace() {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [suggestions, setSuggestions] = useState<Record<string, MatchSuggestion[]>>({});
  const [metrics, setMetrics] = useState<DiscoveryMetrics | null>(null);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("all");
  const [countryCode, setCountryCode] = useState("");
  const [cityFilter, setCityFilter] = useState("");
  const [propertyTypeFilter, setPropertyTypeFilter] = useState("");
  const [listingTypeFilter, setListingTypeFilter] = useState("");
  const [posterTypeFilter, setPosterTypeFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [areaFilter, setAreaFilter] = useState("");
  const [sourceIdFilter, setSourceIdFilter] = useState("");
  const [publishedAfterFilter, setPublishedAfterFilter] = useState("");
  const [updatedAfterFilter, setUpdatedAfterFilter] = useState("");
  const [minPriceFilter, setMinPriceFilter] = useState("");
  const [maxPriceFilter, setMaxPriceFilter] = useState("");
  const [bedroomsFilter, setBedroomsFilter] = useState("");
  const [contactFilter, setContactFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [details, setDetails] = useState<Record<string, string> | null>(null);
  const [outreachListing, setOutreachListing] = useState<Opportunity | null>(null);
  const [contactOptions, setContactOptions] = useState<ContactOption[]>([]);
  const [contactType, setContactType] = useState<ContactType>("listing_agent");
  const [savingContactPermission, setSavingContactPermission] = useState(false);
  const [sendingContactEmail, setSendingContactEmail] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (countryCode) params.set("countryCode", countryCode.toUpperCase());
      if (cityFilter.trim()) params.set("city", cityFilter.trim());
      if (regionFilter.trim()) params.set("region", regionFilter.trim());
      if (areaFilter.trim()) params.set("area", areaFilter.trim());
      if (sourceIdFilter) params.set("sourceId", sourceIdFilter);
      if (publishedAfterFilter) params.set("publishedAfter", publishedAfterFilter);
      if (updatedAfterFilter) params.set("updatedAfter", updatedAfterFilter);
      if (propertyTypeFilter) params.set("propertyType", propertyTypeFilter);
      if (listingTypeFilter) params.set("listingType", listingTypeFilter);
      if (posterTypeFilter) params.set("posterType", posterTypeFilter);
      if (minPriceFilter) params.set("minPrice", minPriceFilter);
      if (maxPriceFilter) params.set("maxPrice", maxPriceFilter);
      if (bedroomsFilter) params.set("bedrooms", bedroomsFilter);
      if (contactFilter) params.set("hasContact", contactFilter);
      const query = params.size ? `?${params.toString()}` : "";
      const [listingResponse, matchResponse, sourceResponse] = await Promise.all([
        fetch(`/api/listings${query}`, { cache: "no-store" }),
        fetch("/api/matches", { cache: "no-store" }),
        fetch("/api/sources", { cache: "no-store" }),
      ]);
      if (!listingResponse.ok) throw new Error(await getError(listingResponse));
      if (!matchResponse.ok) throw new Error(await getError(matchResponse));
      if (!sourceResponse.ok) throw new Error(await getError(sourceResponse));
      const [listingBody, matchBody, sourceBody] = await Promise.all([listingResponse.json(), matchResponse.json(), sourceResponse.json()]);
      setOpportunities(listingBody.data as Opportunity[]);
      setMetrics(listingBody.metrics as DiscoveryMetrics);
      setMatches(matchBody.data as Match[]);
      setSources(sourceBody.data as SourceOption[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load opportunities.");
    } finally {
      setLoading(false);
    }
  }, [areaFilter, bedroomsFilter, cityFilter, contactFilter, countryCode, listingTypeFilter, maxPriceFilter, minPriceFilter, posterTypeFilter, propertyTypeFilter, publishedAfterFilter, regionFilter, sourceIdFilter, updatedAfterFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("purchase") !== "success") return;
    const noticeTimer = window.setTimeout(() => {
      setNotice("Payment completed. Refreshing your lead access; this may take a few seconds.");
    }, 0);
    const refreshTimer = window.setTimeout(() => { void load(); }, 2500);
    window.history.replaceState({}, "", window.location.pathname);
    return () => {
      window.clearTimeout(noticeTimer);
      window.clearTimeout(refreshTimer);
    };
  }, [load]);

  const visibleOpportunities = useMemo(() => opportunities.filter((item) => {
    const query = search.trim().toLocaleLowerCase("en");
    const matchesSearch = !query || `${item.title} ${item.summary} ${item.city} ${item.area}`.toLocaleLowerCase("en").includes(query);
    return matchesSearch && (stage === "all" || item.status === stage);
  }), [opportunities, search, stage]);

  async function createOpportunity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setSaving(true);
    setError("");
    setNotice("");
    const values = new FormData(event.currentTarget);
    const numericPrice = String(values.get("price") ?? "").trim();
    const selectedPosterType = String(values.get("posterType") ?? "UNKNOWN");
    const ownerLedClaim = values.get("ownerLedClaim") === "on" || selectedPosterType === "OWNER_UNVERIFIED";
    if (ownerLedClaim && !values.get("sourceUrl")) {
      setError("Add the original listing or evidence URL for this owner-seller lead.");
      setSaving(false);
      return;
    }
    if (ownerLedClaim && !values.get("ownerEmail") && !values.get("ownerPhone")) {
      setError("Add at least one owner contact method (email or phone) before recording an owner-seller lead.");
      setSaving(false);
      return;
    }
    const payload = {
      sourceName: "Manual entry",
      sourceType: "manual",
      sourceUrl: values.get("sourceUrl") || undefined,
      title: values.get("title"),
      description: values.get("description"),
      propertyType: values.get("propertyType"),
      area: values.get("area"),
      city: values.get("city"),
      region: values.get("region") || undefined,
      countryCode: values.get("countryCode"),
      price: numericPrice ? Number(numericPrice) : undefined,
      currency: values.get("currency"),
      ownerLedClaim,
      listingType: values.get("listingType"),
      bedrooms: values.get("bedrooms") ? Number(values.get("bedrooms")) : undefined,
      bathrooms: values.get("bathrooms") ? Number(values.get("bathrooms")) : undefined,
      publishedAt: values.get("publishedAt") || undefined,
      listingUpdatedAt: values.get("listingUpdatedAt") || undefined,
      posterType: ownerLedClaim ? "OWNER_UNVERIFIED" : values.get("posterType"),
      posterEvidence: values.get("posterEvidence") || undefined,
      posterMethod: ownerLedClaim ? "owner_submission" : values.get("posterMethod"),
      publicContactContext: values.get("publicContactContext") || undefined,
      privateDetails: {
        address: values.get("address") || undefined,
        ownerName: values.get("ownerName") || undefined,
        ownerEmail: values.get("ownerEmail") || undefined,
        ownerPhone: values.get("ownerPhone") || undefined,
      },
    };
    try {
      const response = await fetch("/api/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await getError(response));
      const body = await response.json();
      setNotice(body.duplicate ? "This opportunity already exists in your workspace." : "Opportunity added and scored. No agent was contacted.");
      form.reset();
      setFormOpen(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to create opportunity.");
    } finally {
      setSaving(false);
    }
  }

  async function importListingsCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("CSV import is limited to 2 MB.");
      return;
    }
    setImporting(true);
    setImportProgress("");
    setError("");
    setNotice("");
    try {
      const rows = parseCsv(await file.text());
      if (rows.length > 100) throw new Error("CSV import is limited to 100 listings at a time.");
      let imported = 0;
      let duplicates = 0;
      const failures: string[] = [];
      for (const [index, row] of rows.entries()) {
        setImportProgress(`Importing ${index + 1} of ${rows.length}…`);
        const listingType = row.listing_type || "sale";
        const posterType = row.poster_type || "UNKNOWN";
        const payload = {
          sourceName: row.source_name || "Owner-submitted CSV",
          sourceType: "manual",
          externalId: row.external_id || undefined,
          sourceUrl: row.source_url || undefined,
          title: row.title,
          description: row.description || undefined,
          propertyType: row.property_type,
          listingType,
          area: row.area,
          city: row.city,
          region: row.region || undefined,
          countryCode: row.country_code || "NG",
          price: row.price ? Number(row.price) : undefined,
          currency: row.currency || ((row.country_code || "NG").toUpperCase() === "NG" ? "NGN" : "USD"),
          bedrooms: row.bedrooms ? Number(row.bedrooms) : undefined,
          bathrooms: row.bathrooms ? Number(row.bathrooms) : undefined,
          publishedAt: row.published_at || undefined,
          listingUpdatedAt: row.listing_updated_at || undefined,
          ownerLedClaim: posterType === "OWNER_UNVERIFIED",
          posterType,
          posterEvidence: row.poster_evidence || undefined,
          posterMethod: row.poster_method || "owner_submission",
          publicContactContext: row.public_contact_context || undefined,
          privateDetails: {
            address: row.address || undefined,
            ownerName: row.owner_name || undefined,
            ownerEmail: row.owner_email || undefined,
            ownerPhone: row.owner_phone || undefined,
            listingAgentName: row.listing_agent_name || undefined,
            listingAgentEmail: row.listing_agent_email || undefined,
            listingAgentPhone: row.listing_agent_phone || undefined,
          },
        };
        try {
          const response = await fetch("/api/listings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!response.ok) throw new Error(await getError(response));
          const result = await response.json();
          if (result.duplicate) duplicates += 1;
          else imported += 1;
        } catch (reason) {
          failures.push(`Row ${index + 2}: ${reason instanceof Error ? reason.message : "import failed"}`);
        }
      }
      await load();
      setNotice(`CSV import finished: ${imported} added, ${duplicates} duplicates, ${failures.length} rejected.`);
      if (failures.length) setError(failures.slice(0, 3).join(" · "));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to import the CSV.");
    } finally {
      setImportProgress("");
      setImporting(false);
    }
  }

  async function calculateMatches(listingId: string) {
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/listings/${listingId}/matches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 8 }),
      });
      if (!response.ok) throw new Error(await getError(response));
      const body = await response.json();
      setSuggestions((current) => ({ ...current, [listingId]: body.data as MatchSuggestion[] }));
      setNotice(`${body.data.length} relevant agent match${body.data.length === 1 ? "" : "es"} saved.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to calculate agent matches.");
    }
  }

  async function sendAgentEmail(match: MatchSuggestion) {
    if (!window.confirm(`Send a summary-only opportunity email to ${match.display_name}? This will not include private property or owner details.`)) return;
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/matches/${match.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "send" }),
      });
      if (!response.ok) throw new Error(await getError(response));
      setNotice(`Summary email sent to ${match.display_name}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to send the summary email.");
    }
  }

  async function requestInterest(matchId: string) {
    setError("");
    try {
      const response = await fetch(`/api/matches/${matchId}/interest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(await getError(response));
      setNotice("Interest submitted for human review. Private details remain locked.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to submit interest.");
    }
  }

  async function purchaseLead(match: Match) {
    if (!match.interest) return;
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/lead-purchases/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interestRequestId: match.interest.id }),
      });
      if (!response.ok) throw new Error(await getError(response));
      const body = await response.json();
      if (typeof body.data?.checkoutUrl !== "string") throw new Error("Checkout provider did not return a payment link.");
      window.location.assign(body.data.checkoutUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to start lead checkout.");
    }
  }

  async function revealDetails(listingId: string) {
    setError("");
    try {
      const response = await fetch(`/api/listings/${listingId}/details`);
      if (!response.ok) throw new Error(await getError(response));
      const body = await response.json();
      setDetails(body.data as Record<string, string>);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load approved details.");
    }
  }

  async function suppressOpportunity(listingId: string) {
    const reason = window.prompt("Why should this opportunity be suppressed?");
    if (!reason?.trim()) return;
    const ownerOptOut = window.confirm("Confirm OK only if this is a verified owner opt-out. Otherwise choose Cancel.");
    setError("");
    try {
      const response = await fetch(`/api/listings/${listingId}/suppression`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, ownerOptOut }),
      });
      if (!response.ok) throw new Error(await getError(response));
      setNotice("Opportunity suppressed. Pending access has been withdrawn and future detail access is blocked.");
      await load();
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError.message : "Unable to suppress opportunity.");
    }
  }

  async function verifyOwnerClaim(item: Opportunity) {
    const evidenceReference = window.prompt("Evidence reference (source URL, document ID, or review reference):")?.trim();
    if (!evidenceReference) return;
    const verificationMethod = window.prompt(
      "Verification method: direct_confirmation, ownership_document_review, registry_check, authorized_source_confirmation, or other",
      "direct_confirmation",
    )?.trim();
    if (!verificationMethod) return;
    const reason = window.prompt("Brief verification rationale:")?.trim();
    if (!reason) return;
    setError("");
    try {
      const response = await fetch(`/api/listings/${item.id}/verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "verified", verificationMethod, evidenceReference, reason }),
      });
      if (!response.ok) throw new Error(await getError(response));
      setNotice("Owner-listed claim marked verified with evidence and an audit record.");
      await load();
    } catch (reasonError) {
      setError(reasonError instanceof Error ? reasonError.message : "Unable to verify owner claim.");
    }
  }

  async function openContactOutreach(item: Opportunity) {
      setError("");
      setNotice("");
      try {
        const response = await fetch(`/api/listings/${item.id}/contact-outreach`, { cache: "no-store" });
        if (!response.ok) throw new Error(await getError(response));
        const body = await response.json();
        setContactOptions(body.data.contacts as ContactOption[]);
        setContactType("listing_agent");
        setOutreachListing(item);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Unable to load contact outreach options.");
      }
    }

  async function refreshContactOptions() {
      if (!outreachListing) return;
      const response = await fetch(`/api/listings/${outreachListing.id}/contact-outreach`, { cache: "no-store" });
      if (!response.ok) throw new Error(await getError(response));
      const body = await response.json();
      setContactOptions(body.data.contacts as ContactOption[]);
    }

  async function saveContactPermission(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!outreachListing) return;
      setSavingContactPermission(true);
      setError("");
      try {
        const values = new FormData(event.currentTarget);
        const response = await fetch(`/api/listings/${outreachListing.id}/contact-outreach`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contactType,
            status: "permitted",
            lawfulBasis: values.get("lawfulBasis"),
            evidenceReference: values.get("evidenceReference"),
            authorizationConfirmed: values.get("authorizationConfirmed") === "on",
          }),
        });
        if (!response.ok) throw new Error(await getError(response));
        setNotice("Contact permission basis recorded and audited.");
        await refreshContactOptions();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Unable to record contact permission.");
      } finally {
        setSavingContactPermission(false);
      }
    }

  async function recordContactOptOut() {
      if (!outreachListing || !window.confirm("Record this contact's opt-out? Future outreach to this contact will be blocked.")) return;
      setError("");
      try {
        const response = await fetch(`/api/listings/${outreachListing.id}/contact-outreach`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactType, status: "opted_out" }),
        });
        if (!response.ok) throw new Error(await getError(response));
        setNotice("Contact opt-out recorded. Further outreach is blocked.");
        await refreshContactOptions();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Unable to record contact opt-out.");
      }
    }

  async function sendContactEmail(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      if (!outreachListing) return;
      const form = event.currentTarget;
      const values = new FormData(form);
      const subject = String(values.get("subject") ?? "");
      const recipientLabel = contactType === "owner" ? "verified owner" : contactType === "listing_office" ? "listing office" : "listing agent";
      if (!window.confirm(`Send this email to the ${recipientLabel} for "${outreachListing.title}"? This will send one manually reviewed message.`)) return;
      setSendingContactEmail(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch(`/api/listings/${outreachListing.id}/contact-outreach`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contactType,
            subject,
            message: values.get("message"),
            confirmation: "send",
          }),
        });
        if (!response.ok) throw new Error(await getError(response));
        setNotice("Property inquiry email sent. The attempt was recorded in the audit log.");
        await refreshContactOptions();
        form.reset();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Unable to send property inquiry email.");
      } finally {
        setSendingContactEmail(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>        <p className="eyebrow">Workspace / Opportunities</p><h1>Owner-seller leads</h1><p className="subheading">Find actionable properties offered by owners. Seller contact is shared only with the matched agent after manager review and approval.</p></div>
        <div className="page-heading-actions">
          <label className="secondary-button">Import authorized CSV<input className="csv-file-input" type="file" accept=".csv,text/csv" onChange={(event) => void importListingsCsv(event)} disabled={importing} /></label>
          <button className="primary-button" onClick={() => setFormOpen((open) => !open)}>{formOpen ? "Close form" : "+ Add opportunity"}</button>
        </div>
      </div>
      {importProgress && <div className="workspace-alert" role="status">{importProgress}</div>}

      <div className="notice-banner"><span>◎</span><div><b>Prioritize genuine owner sellers.</b><p>RentCast provides listing records and may include listing-agent or office contacts; it does not establish an owner-posted listing or supply owner contact details. Add owner-seller leads from authorized sources with the original listing link and a seller phone or email. Agents see contact details only after interest and manager approval.</p></div></div>
      {error && <div className="workspace-alert error" role="alert">{error}</div>}
      {notice && <div className="workspace-alert success" role="status">{notice}</div>}

      {metrics && <section className="metric-grid listing-discovery-metrics" aria-label="Listing discovery metrics">
        <div className="metric-card"><span className="metric-label">Listings discovered</span><b className="metric-value">{metrics.totalDiscovered}</b><span className="metric-change">No demo records</span></div>
        <div className="metric-card"><span className="metric-label">Owner verified</span><b className="metric-value">{metrics.ownerVerified}</b><span className="metric-change">Documented review only</span></div>
        <div className="metric-card"><span className="metric-label">Owner unverified</span><b className="metric-value">{metrics.ownerUnverified}</b><span className="metric-change">Claims need review</span></div>
        <div className="metric-card"><span className="metric-label">Agents excluded</span><b className="metric-value">{metrics.agentsExcludedByDefault}</b><span className="metric-change">Unless explicitly included</span></div>
        <div className="metric-card"><span className="metric-label">Public source contacts</span><b className="metric-value">{metrics.listingsWithPublicContacts}</b><span className="metric-change">{metrics.listingsMissingContact} listings have no contact</span></div>
        <div className="metric-card"><span className="metric-label">Duplicates prevented</span><b className="metric-value">{metrics.duplicatesPrevented}</b><span className="metric-change">{metrics.newlyDiscoveredLast7Days} new in 7 days</span></div>
        <div className="metric-card"><span className="metric-label">Stale listings</span><b className="metric-value">{metrics.staleListings}</b><span className="metric-change">Not seen in 14 days</span></div>
        <div className="metric-card"><span className="metric-label">Failed sources</span><b className="metric-value">{metrics.failedSources}</b><span className="metric-change">{metrics.lastSuccessfulCollectionAt ? `Last success ${new Date(metrics.lastSuccessfulCollectionAt).toLocaleString()}` : "No successful collection yet"}</span></div>
      </section>}

      {formOpen && <section className="panel opportunity-form-panel">
        <div className="panel-header"><div><h2>Add an authorized listing</h2><p>Prioritize owner-submitted records. Keep the original listing/evidence link and document any poster or contact claims; uncertain ownership remains unverified.</p></div></div>
        <form className="opportunity-form" onSubmit={createOpportunity}>
          <label>Listing title<input name="title" required minLength={3} maxLength={200} placeholder="Detached home near the park" /></label>
          <label>Property type<select name="propertyType" required><option value="house">House</option><option value="apartment">Apartment</option><option value="land">Land</option><option value="commercial">Commercial</option><option value="other">Other</option></select></label>
          <label>Listing type<select name="listingType"><option value="sale">For sale</option><option value="rental">For rent</option></select></label>
          <label>Area / neighborhood<input name="area" required maxLength={120} /></label>
          <label>City<input name="city" required maxLength={120} /></label>
          <label>Region / state<input name="region" maxLength={120} /></label>
          <label>Country code<input name="countryCode" required minLength={2} maxLength={2} defaultValue="NG" /></label>
          <label>Asking price<input name="price" type="number" min="0.01" step="any" /></label>
          <label>Currency<input name="currency" minLength={3} maxLength={3} defaultValue="NGN" /></label>
          <label>Bedrooms<input name="bedrooms" type="number" min="0" max="100" step="1" /></label>
          <label>Bathrooms<input name="bathrooms" type="number" min="0" max="100" step="0.5" /></label>
          <label>Publication date<input name="publishedAt" type="date" /></label>
          <label>Last updated date<input name="listingUpdatedAt" type="date" /></label>
          <label className="form-span">Description<textarea name="description" rows={3} maxLength={4000} /></label>
          <label className="form-span">Original listing / evidence URL<input name="sourceUrl" type="url" maxLength={2048} placeholder="https://source.example/listing" /><small>Required when marking this as an owner-seller lead. Use a source your organization is authorized to process.</small></label>
          <label className="checkbox-label"><input type="checkbox" name="ownerLedClaim" defaultChecked />Owner/landlord claims this listing</label>
          <label>Poster classification<select name="posterType"><option value="UNKNOWN">Unknown</option><option value="OWNER_UNVERIFIED">Owner/landlord claimed · unverified</option><option value="AGENT">Agent</option><option value="DEVELOPER">Developer</option><option value="COMPANY">Company</option></select></label>
          <label>Classification method<select name="posterMethod"><option value="owner_submission">Owner-submitted record</option><option value="source_metadata">Source metadata</option><option value="manual_review">Manual review</option></select></label>
          <label className="form-span">Poster evidence<input name="posterEvidence" maxLength={1000} placeholder="What in the source supports this classification?" /><small>Owner-verified classification is only granted through documented manager review.</small></label>
          <label className="form-span">Public contact context<input name="publicContactContext" maxLength={500} placeholder="Where on the original listing is this contact published?" /><small>Fill only when a contact appears on the original listing and your source terms permit its collection.</small></label>
          <details className="private-fields form-span" open><summary>Private seller contact details (encrypted; revealed only after approval)</summary><div className="private-fields-grid">
            <label>Full address<input name="address" maxLength={500} autoComplete="off" /></label>
            <label>Owner name<input name="ownerName" maxLength={200} autoComplete="off" /></label>
            <label>Owner email<input name="ownerEmail" type="email" maxLength={254} autoComplete="off" /></label>
            <label>Owner phone<input name="ownerPhone" type="tel" maxLength={40} autoComplete="off" /></label>
          </div><small>Owner-seller leads require at least an email or phone number. Requires OWNER_DATA_ENCRYPTION_KEY. The contact is not shown to agents until their detail request is approved and any applicable lead payment is complete.</small></details>
          <div className="form-actions form-span"><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save opportunity"}</button></div>
        </form>
      </section>}

      <section className="panel table-panel opportunity-table-panel">
        <div className="table-toolbar">
          <div className="search-field"><span>⌕</span><input aria-label="Search opportunities" placeholder="Search by title, area, or city" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <select className="filter-button" aria-label="Filter by status" value={stage} onChange={(event) => setStage(event.target.value)}><option value="all">All statuses</option><option value="new">New</option><option value="review">Review</option><option value="matched">Matched</option><option value="closed">Closed</option></select>
          <button className="secondary-button small" onClick={() => void load()}>Refresh</button>
        </div>
        <div className="listing-filter-grid">
          <label>Country<input value={countryCode} onChange={(event) => setCountryCode(event.target.value)} placeholder="NG" maxLength={2} /></label>
          <label>Region / state<input value={regionFilter} onChange={(event) => setRegionFilter(event.target.value)} placeholder="Lagos State" /></label>
          <label>City / town<input value={cityFilter} onChange={(event) => setCityFilter(event.target.value)} placeholder="Lagos" /></label>
          <label>Neighborhood / area<input value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)} placeholder="Lekki" /></label>
          <label>Source<select value={sourceIdFilter} onChange={(event) => setSourceIdFilter(event.target.value)}><option value="">All sources</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
          <label>Property type<select value={propertyTypeFilter} onChange={(event) => setPropertyTypeFilter(event.target.value)}><option value="">All property types</option><option value="house">House</option><option value="apartment">Apartment</option><option value="land">Land</option><option value="commercial">Commercial</option><option value="other">Other</option></select></label>
          <label>Sale or rental<select value={listingTypeFilter} onChange={(event) => setListingTypeFilter(event.target.value)}><option value="">Sale or rental</option><option value="sale">Sale</option><option value="rental">Rental</option></select></label>
          <label>Poster type<select value={posterTypeFilter} onChange={(event) => setPosterTypeFilter(event.target.value)}><option value="">Owner claims only (default)</option><option value="OWNER_VERIFIED">Owner verified</option><option value="OWNER_UNVERIFIED">Owner unverified</option><option value="UNKNOWN">Include unknown poster</option><option value="AGENT">Include agent listings</option><option value="DEVELOPER">Include developers</option><option value="COMPANY">Include companies</option></select></label>
          <label>Minimum price<input type="number" min="0" value={minPriceFilter} onChange={(event) => setMinPriceFilter(event.target.value)} /></label>
          <label>Maximum price<input type="number" min="0" value={maxPriceFilter} onChange={(event) => setMaxPriceFilter(event.target.value)} /></label>
          <label>At least bedrooms<input type="number" min="0" max="100" value={bedroomsFilter} onChange={(event) => setBedroomsFilter(event.target.value)} /></label>
          <label>Contact availability<select value={contactFilter} onChange={(event) => setContactFilter(event.target.value)}><option value="">Any contact status</option><option value="true">Publicly listed contact</option><option value="false">Missing contact information</option></select></label>
          <label>Published on or after<input type="date" value={publishedAfterFilter} onChange={(event) => setPublishedAfterFilter(event.target.value)} /></label>
          <label>Updated on or after<input type="date" value={updatedAfterFilter} onChange={(event) => setUpdatedAfterFilter(event.target.value)} /></label>
        </div>
        <div className="table-meta"><span><b>{visibleOpportunities.length}</b> {visibleOpportunities.length === 1 ? "opportunity" : "opportunities"}</span><span>Workspace records · no sample data</span></div>
        {loading ? <div className="workspace-state"><span className="loading-indicator" />Loading organization opportunities…</div>
          : visibleOpportunities.length === 0 ? <div className="workspace-state"><h2>{opportunities.length ? "No opportunities match these filters" : "Your opportunity queue is empty"}</h2><p>{opportunities.length ? "Try a different search or status." : "Add a property record from a permitted source to start scoring and matching."}</p>{!opportunities.length && <button className="primary-button" onClick={() => setFormOpen(true)}>Add your first opportunity</button>}</div>
            : <div className="table-scroll"><table><thead><tr><th>Opportunity</th><th>Location</th><th>Poster / source</th><th>Score</th><th>Status</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>
              {visibleOpportunities.map((item) => <tr key={item.id}>
                <td><div className="opportunity-title"><b>{item.title}</b><small>{item.property_type.replace("_", " ")} · {item.listing_type}{item.bedrooms !== null ? ` · ${item.bedrooms} beds` : ""}{item.price !== null ? ` · ${new Intl.NumberFormat().format(item.price)} ${item.currency}` : ""}</small></div></td>
                <td><b>{item.area}</b><small>{item.city}{item.region ? `, ${item.region}` : ""} · {item.country_code}</small></td>
                <td><StatusPill tone={item.poster_type === "OWNER_VERIFIED" ? "green" : item.poster_type === "OWNER_UNVERIFIED" ? "amber" : item.poster_type === "AGENT" ? "neutral" : "blue"}>{item.poster_type.replaceAll("_", " ")}</StatusPill><small>{item.listing_sources?.name ?? "Unknown source"} · {item.poster_confidence === null ? "confidence unavailable" : `${item.poster_confidence}% confidence`}</small><small>{item.poster_evidence}</small></td>
                <td>{item.score ? <><ScoreBadge score={item.score.score} /><small className="score-label">Trust {item.score.trust_score}/100</small></> : <span className="muted-cell">Not scored</span>}</td>
                <td><StatusPill tone={item.status === "matched" ? "green" : item.status === "review" ? "purple" : "blue"}>{item.status}</StatusPill></td>
                <td className="muted-cell">{new Date(item.last_seen_at).toLocaleDateString()}</td>
                <td><div className="table-row-actions">{item.listing_source_links?.[0]?.canonical_url && <a className="secondary-button small" href={item.listing_source_links[0].canonical_url} target="_blank" rel="noreferrer">View original ↗</a>}{item.poster_type === "OWNER_UNVERIFIED" && <button className="secondary-button small" onClick={() => void verifyOwnerClaim(item)}>Review owner claim</button>}<button className="secondary-button small" onClick={() => void calculateMatches(item.id)}>Match</button><button className="secondary-button small" onClick={() => void openContactOutreach(item)}>Contact</button><button className="secondary-button small" onClick={() => void suppressOpportunity(item.id)} aria-label={`Suppress ${item.title}`}>Suppress</button></div></td>
              </tr>)}
            </tbody></table></div>}
      </section>

      {Object.entries(suggestions).map(([listingId, items]) => <section className="panel match-panel" key={listingId}><div className="panel-header"><div><h2>Agent match results</h2><p>Email only goes to agents who opted in. The message contains summary fields only and requires this manual send action.</p></div></div>
        {items.length ? <div className="match-suggestion-list">{items.map((item) => <div className="match-suggestion" key={item.agent_id}><div><b>{item.display_name}</b><small>{item.reasons.join(" · ")}</small></div><ScoreBadge score={item.score} /><button className="secondary-button small" disabled={!item.id} onClick={() => void sendAgentEmail(item)}>Send summary email</button></div>)}</div> : <p className="workspace-state">No active agent profile matches this opportunity yet.</p>}
      </section>)}

      {matches.length > 0 && <section className="panel match-panel"><div className="panel-header"><div><h2>Recommended for you</h2><p>One verified owner-seller sample is free per organization; subsequent verified owner-seller leads cost $25 USD after manager approval.</p></div></div><div className="match-suggestion-list">
        {matches.map((match) => {
          const purchase = match.interest?.purchase;
          const unlockGranted = purchase?.status === "sample" || purchase?.status === "paid";
          const needsPayment = purchase?.status === "payment_required" || purchase?.status === "checkout_pending";
          return <div className="agent-match-row" key={match.id}>
            <div className="agent-match-main"><b>{match.listing?.title ?? "Opportunity"}</b><small>{match.listing?.summary} · Match {match.score}/100{match.listing?.owner_led_claim ? " · Owner-seller lead" : ""}</small></div>
            {match.interest?.status === "approved"
              ? match.listing?.owner_led_claim
                ? unlockGranted
                  ? <button className="primary-button small" onClick={() => void revealDetails(match.listing_id)}>{purchase?.purchase_type === "sample" ? "View free sample" : "View purchased lead"}</button>
                  : needsPayment
                    ? <button className="primary-button small" onClick={() => void purchaseLead(match)}>{purchase?.status === "checkout_pending" ? "Continue checkout" : `Unlock for $${(purchase?.amount_cents ?? 2500) / 100}`}</button>
                    : <StatusPill tone="amber">Lead access being prepared</StatusPill>
                : <button className="primary-button small" onClick={() => void revealDetails(match.listing_id)}>View approved details</button>
              : match.interest
                ? <StatusPill tone={match.interest.status === "rejected" ? "neutral" : "amber"}>{match.interest.status === "pending" ? "Awaiting review" : match.interest.status}</StatusPill>
                : <button className="secondary-button small" onClick={() => void requestInterest(match.id)}>Request verified lead</button>}
          </div>;
        })}
      </div></section>}

      {details && <div className="details-overlay" role="presentation" onClick={() => setDetails(null)}><section className="details-dialog" role="dialog" aria-modal="true" aria-labelledby="details-heading" onClick={(event) => event.stopPropagation()}><div className="panel-header"><div><p className="eyebrow">Approved access</p><h2 id="details-heading">Private property details</h2></div><button className="secondary-button small" onClick={() => setDetails(null)}>Close</button></div><dl>{Object.entries(details).filter(([, value]) => Boolean(value)).map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase())}</dt><dd>{value}</dd></div>)}</dl><small>Access to these details was recorded in the workspace audit log.</small></section></div>}

      {outreachListing && <div className="details-overlay" role="presentation" onClick={() => setOutreachListing(null)}><section className="details-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-outreach-heading" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header"><div><p className="eyebrow">Manual property inquiry</p><h2 id="contact-outreach-heading">Contact about this listing</h2><p>{outreachListing.title} · {outreachListing.area}, {outreachListing.city}</p></div><button className="secondary-button small" onClick={() => setOutreachListing(null)}>Close</button></div>
        <p>Messages are sent only after a manager records permission or an applicable lawful basis, composes the email, and confirms sending. Owner outreach requires a verified owner. Maximum 20 contact emails per workspace per 24 hours and one per contact/listing in seven days.</p>
        <label>Contact<select value={contactType} onChange={(event) => setContactType(event.target.value as ContactType)}><option value="listing_agent">Listing agent</option><option value="listing_office">Listing office</option><option value="owner">Verified owner</option></select></label>
        {(() => {
          const contact = contactOptions.find((item) => item.contactType === contactType);
          if (!contact?.available) return <div className="workspace-state compact">{contactType === "owner" && !contact?.ownerVerified ? "Owner must be verified before owner outreach." : "No email contact is available for this recipient."}</div>;
          if (contact.status === "opted_out") return <div className="workspace-alert error" role="status">This contact opted out. Outreach is blocked.</div>;
          return <>
            {contact.status !== "permitted" ? <form className="settings-form" onSubmit={saveContactPermission}>
              <p>Before sending, record the permission or lawful basis for this specific inquiry. Follow your organization’s policy and the applicable source terms and local law.</p>
              <label>Permission / lawful basis<textarea name="lawfulBasis" minLength={5} maxLength={300} required placeholder="Describe the documented consent or applicable lawful basis" /></label>
              <label>Evidence reference<input name="evidenceReference" minLength={3} maxLength={500} required placeholder="Consent record, case note, or source reference" /></label>
              <label className="checkbox-label"><input type="checkbox" name="authorizationConfirmed" required />I reviewed the evidence and confirm outreach is permitted for this contact</label>
              <button className="primary-button" disabled={savingContactPermission}>{savingContactPermission ? "Recording…" : "Record permission"} </button>
            </form> : <>
              <div className="workspace-alert success" role="status">Permission recorded: {contact.lawfulBasis}. Evidence: {contact.evidenceReference}</div>
              <form className="settings-form" onSubmit={sendContactEmail}>
                <label>Subject<input name="subject" required minLength={3} maxLength={180} defaultValue={`Question about ${outreachListing.title}`} /></label>
                <label>Message<textarea name="message" required minLength={20} maxLength={4000} rows={6} placeholder="Write a concise, property-specific inquiry. Do not include sensitive owner or agent details." /></label>
                <button className="primary-button" disabled={sendingContactEmail}>{sendingContactEmail ? "Sending…" : "Review and send email"}</button>
              </form>
              <button className="text-button" onClick={() => void recordContactOptOut()}>Record contact opt-out</button>
              {contact.lastSentAt && <small>Last email sent {new Date(contact.lastSentAt).toLocaleString()} ({contact.recentOutreachStatus}).</small>}
            </>}
          </>;
        })()}
      </section></div>}
    </>
  );
}
