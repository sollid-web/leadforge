"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { composeOfferTemplate, formatCurrencyAmount, toMinorUnits, type OfferTemplateKey } from "@/lib/agent-sales-pipeline";

type Listing = {
  id: string; title: string; city: string | null; region?: string | null; country_code?: string | null;
  currency?: string | null; price?: number | null; property_type?: string | null; listing_type?: string | null;
  owner_led_claim?: boolean; poster_type?: string; last_seen_at?: string | null; listing_updated_at?: string | null;
  published_at?: string | null; status?: string;
};
type Rejection = { id?: string; title?: string; reasons?: string[] };
type Batch = {
  id: string; name: string; city: string; country_code: string; currency: string; exclusive: boolean;
  status: string; minimum_freshness_days: number; summary?: Record<string, unknown> | null;
  listing_count?: number; listingCount?: number; offers?: Offer[]; rejected?: Rejection[];
};
type Match = { agentId: string; agentName: string; score: number; factors: Array<{ factor: string; points: number; explanation: string }> };
type Excluded = { agentId?: string; agentName: string; reason: string };
type Offer = {
  id: string; batch_id: string; agent_directory_id: string; status: string; pricing_mode: "batch" | "per_lead";
  unit_price_minor_units: number; price_minor_units: number; currency: string; channel?: string;
  template_key?: string; message?: string; shared_disclosure_confirmed?: boolean; response_summary?: string | null;
  payment_reference?: string | null; payment_evidence_note?: string | null; paid_at?: string | null; delivered_at?: string | null;
  batch?: { name?: string; city?: string; country_code?: string; exclusive?: boolean; summary?: Record<string, unknown> } | null;
  agent?: { name?: string; agency?: string | null } | null;
};

const DISCLOSURE = "Shared disclosure: this offer is for a batch of owner-indicated listing records. Owner status and listing information may be unverified or change over time; the batch contains summary-level information only. Contact availability is not marketing consent. No private seller contact details are shared in this offer.";
const inputStyle: React.CSSProperties = { display: "grid", gap: 5, color: "#52635a", fontSize: 11, fontWeight: 600 };
const controlStyle: React.CSSProperties = { width: "100%", minHeight: 36, border: "1px solid #dce5df", borderRadius: 7, background: "white", padding: "7px 9px", fontSize: 12, fontWeight: 400 };
const cardStyle: React.CSSProperties = { border: "1px solid #e3eae5", borderRadius: 9, padding: 14, background: "#fff" };

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}));
  const reasons = Array.isArray(body.rejected) ? body.rejected as Rejection[] : [];
  const rejectedText = reasons.map((item) => `${item.title ?? item.id ?? "Record"}: ${(item.reasons ?? []).join(", ")}`).join("; ");
  return [body.error ?? `Request failed (${response.status})`, rejectedText].filter(Boolean).join(" — ");
}
function readable(value: string) { return value.replaceAll("_", " "); }
function dateLabel(value?: string | null) { return value ? new Date(value).toLocaleDateString() : "Not recorded"; }
function intFact(summary: Record<string, unknown> | null | undefined, key: string) { const value = Number(summary?.[key] ?? 0); return Number.isFinite(value) ? value : 0; }
function minorUnitDigits(currency: string) { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; }
function formatMinorAmount(minor: number, currency: string) { return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / (10 ** minorUnitDigits(currency))); }
const templateOptions: Array<{ value: OfferTemplateKey; label: string }> = [
  { value: "initial_offer", label: "Initial offer" }, { value: "follow_up", label: "Follow-up" },
  { value: "sample_request", label: "Sample request" }, { value: "negotiation", label: "Negotiation" },
  { value: "purchase_confirmation", label: "Purchase confirmation" }, { value: "delivery_notification", label: "Delivery notification" },
];
function makeMessage(batch: { name: string; city: string; country_code: string; exclusive?: boolean; summary?: Record<string, unknown> | null; listing_count?: number; listingCount?: number }, agentName: string, template: OfferTemplateKey = "initial_offer", priceLabel = "Price to be set by operator") {
  const summary = batch.summary ?? {};
  const count = intFact(summary, "lead_count") || batch.listing_count || batch.listingCount || 0;
  const verified = intFact(summary, "owner_verified");
  const unverified = intFact(summary, "owner_unverified");
  const contacts = intFact(summary, "contacts_available");
  return composeOfferTemplate(template, agentName, { batchName: batch.name, city: batch.city, countryCode: batch.country_code, leadCount: count, contactCount: contacts, ownerVerified: verified, ownerUnverified: unverified, propertyTypes: (summary.property_types ?? {}) as Record<string, number>, listingTypes: (summary.listing_types ?? {}) as Record<string, number>, exclusive: batch.exclusive ?? false, priceLabel });
}
function toMessageFacts(batch: Batch | NonNullable<Offer["batch"]> | undefined): Parameters<typeof makeMessage>[0] | null {
  if (!batch || typeof batch.name !== "string" || typeof batch.city !== "string" || typeof batch.country_code !== "string") return null;
  return { name: batch.name, city: batch.city, country_code: batch.country_code, exclusive: batch.exclusive, summary: batch.summary };
}

export function LeadOffersWorkspace() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [city, setCity] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchName, setBatchName] = useState("");
  const [freshness, setFreshness] = useState("14");
  const [exclusive, setExclusive] = useState(true);
  const [latestRejected, setLatestRejected] = useState<Rejection[]>([]);
  const [rejectedByBatch, setRejectedByBatch] = useState<Record<string, Rejection[]>>({});
  const [matchResults, setMatchResults] = useState<Record<string, { matches: Match[]; excluded: Excluded[] }>>({});
  const [activeBatch, setActiveBatch] = useState("");
  const [offerAgent, setOfferAgent] = useState("");
  const [priceAmount, setPriceAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [pricingMode, setPricingMode] = useState<"batch" | "per_lead">("batch");
  const [offerMessage, setOfferMessage] = useState("");
  const [offerTemplate, setOfferTemplate] = useState<OfferTemplateKey>("initial_offer");
  const [offerAgentName, setOfferAgentName] = useState("");
  const [channel, setChannel] = useState("manual");
  const [reviewedDisclosure, setReviewedDisclosure] = useState(false);
  const [responseNotes, setResponseNotes] = useState<Record<string, string>>({});
  const [paymentForms, setPaymentForms] = useState<Record<string, { reference: string; evidence: string; amount: string }>>({});
  const [editingOffer, setEditingOffer] = useState<string | null>(null);
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [templateDrafts, setTemplateDrafts] = useState<Record<string, OfferTemplateKey>>({});

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [listingResponse, batchResponse, offerResponse] = await Promise.all([
        fetch("/api/listings", { cache: "no-store" }),
        fetch("/api/lead-batches", { cache: "no-store" }),
        fetch("/api/lead-offers", { cache: "no-store" }),
      ]);
      if (!listingResponse.ok) throw new Error(await responseError(listingResponse));
      if (!batchResponse.ok) throw new Error(await responseError(batchResponse));
      if (!offerResponse.ok) throw new Error(await responseError(offerResponse));
      const [listingBody, batchBody, offerBody] = await Promise.all([listingResponse.json(), batchResponse.json(), offerResponse.json()]);
      const ownerListings = (listingBody.data ?? []).filter((item: Listing) => item.poster_type === "OWNER_VERIFIED" || item.poster_type === "OWNER_UNVERIFIED" || item.owner_led_claim);
      const nextBatches = (batchBody.data ?? []) as Batch[];
      const nextOffers = (offerBody.data ?? []) as Offer[];
      setListings(ownerListings); setBatches(nextBatches); setOffers(nextOffers);
      setSelectedIds((current) => current.filter((id) => ownerListings.some((listing: Listing) => listing.id === id)));
      setMessageDrafts((current) => Object.fromEntries(nextOffers.map((offer) => [offer.id, current[offer.id] ?? offer.message ?? ""])));
      setPaymentForms((current) => Object.fromEntries(nextOffers.map((offer) => [offer.id, current[offer.id] ?? {
        reference: offer.payment_reference ?? "", evidence: offer.payment_evidence_note ?? "",
        amount: (offer.price_minor_units / (10 ** minorUnitDigits(offer.currency))).toString(),
      }])));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load lead-offer workspace."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  const cityOptions = useMemo(() => [...new Set(listings.map((item) => item.city?.trim()).filter((item): item is string => Boolean(item)))].sort((a, b) => a.localeCompare(b)), [listings]);
  const cityListings = useMemo(() => city.trim() ? listings.filter((item) => item.city?.trim().toLocaleLowerCase() === city.trim().toLocaleLowerCase()) : [], [city, listings]);
  const selectedCount = selectedIds.length;
  const batchMap = useMemo(() => new Map(batches.map((item) => [item.id, item])), [batches]);

  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selectedIds.length || selectedIds.length > 50) return;
    setBusy("batch"); setError(""); setNotice(""); setLatestRejected([]);
    try {
      const response = await fetch("/api/lead-batches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: batchName.trim() || undefined, listingIds: selectedIds, exclusive, minimumFreshnessDays: Number(freshness) }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setLatestRejected(body.rejected ?? []); throw new Error([body.error ?? `Request failed (${response.status})`, ...(body.rejected ?? []).map((item: Rejection) => `${item.title ?? item.id}: ${(item.reasons ?? []).join(", ")}`)].filter(Boolean).join(" — ")); }
      setLatestRejected(body.rejected ?? []);
      if (body.data?.id && body.rejected?.length) setRejectedByBatch((current) => ({ ...current, [body.data.id]: body.rejected }));
      setSelectedIds([]); setBatchName("");
      setNotice(`Batch created with ${body.data?.listingCount ?? body.data?.listing_count ?? 0} qualified records (${body.data?.status ?? "draft"}). ${body.rejected?.length ?? 0} selected record(s) were rejected.`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create batch."); }
    finally { setBusy(""); }
  }

  async function batchAction(batch: Batch, action: "approve" | "archive") {
    if (action === "approve" && !window.confirm(`Approve “${batch.name}” for agent offers? Confirm the current 20+ records still qualify.`)) return;
    if (action === "archive" && !window.confirm(`Archive “${batch.name}”?`)) return;
    setBusy(batch.id); setError("");
    try {
      const response = await fetch(`/api/lead-batches/${batch.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      if (!response.ok) throw new Error(await responseError(response));
      setNotice(action === "approve" ? "Batch approved. You can now find matched agents and prepare offers." : "Batch archived."); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Batch action failed."); }
    finally { setBusy(""); }
  }

  async function findMatches(batch: Batch) {
    setBusy(`match:${batch.id}`); setError("");
    try {
      const response = await fetch(`/api/lead-batches/${batch.id}/matches`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json(); const result = body.data ?? body;
      setMatchResults((current) => ({ ...current, [batch.id]: result })); setActiveBatch(batch.id); setNotice(`Found ${result.matches?.length ?? 0} compatible agent(s); ${result.excluded?.length ?? 0} excluded.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to match agents."); }
    finally { setBusy(""); }
  }

  function prepareOffer(batch: Batch, match: Match) {
    setActiveBatch(batch.id); setOfferAgent(match.agentId); setOfferAgentName(match.agentName); setCurrency(batch.currency || ""); setPriceAmount(""); setPricingMode("batch"); setOfferTemplate("initial_offer"); setOfferMessage(makeMessage(batch, match.agentName)); setReviewedDisclosure(false); setError("");
  }

  async function createOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const batch = batchMap.get(activeBatch); if (!batch || !offerAgent) return;
    const amount = Number(priceAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setError("Enter a positive operator-approved price."); return; }
    setBusy("offer"); setError("");
    try {
      const response = await fetch("/api/lead-offers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: activeBatch, agentDirectoryId: offerAgent, pricingMode, priceAmount: amount, currency: currency.toUpperCase(), channel, templateKey: offerTemplate, message: offerMessage }) });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json(); setNotice("Draft offer created. Review its wording, terms, and shared disclosure before approval."); setOfferAgent(""); setOfferMessage(""); await load();
      if (body.data?.id) setEditingOffer(body.data.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create offer."); }
    finally { setBusy(""); }
  }

  function currentPriceLabel() {
    const amount = Number(priceAmount);
    if (!priceAmount || !Number.isFinite(amount) || amount <= 0 || !currency) return "Price to be confirmed by operator";
    try {
      const unit = toMinorUnits(amount, currency);
      if (pricingMode === "per_lead") {
        const count = intFact(batchMap.get(activeBatch)?.summary, "lead_count");
        return `${formatCurrencyAmount(unit, currency)} per lead (${formatCurrencyAmount(unit * count, currency)} total)`;
      }
      return formatCurrencyAmount(unit, currency);
    } catch { return "Price to be confirmed by operator"; }
  }

  async function offerAction(offer: Offer, payload: Record<string, unknown>, success: string) {
    setBusy(offer.id); setError("");
    try {
      const response = await fetch(`/api/lead-offers/${offer.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(await responseError(response));
      setNotice(success); setReviewedDisclosure(false); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Offer action failed."); }
    finally { setBusy(""); }
  }

  async function saveMessage(offer: Offer) {
    const message = (messageDrafts[offer.id] ?? "").trim();
    if (message.length < 1) { setError("Offer message cannot be empty."); return; }
    await offerAction(offer, { action: "save_message", message, templateKey: templateDrafts[offer.id] ?? offer.template_key ?? "initial_offer" }, "Offer message saved; previous review approval has been reset.");
    setEditingOffer(null);
  }

  async function recordTransition(offer: Offer, nextState: string) {
    if (nextState === "ready_for_review" && !window.confirm("Submit this draft for an operator review?")) return;
    if (nextState === "approved" && !window.confirm("Approve this reviewed offer? No message will be sent automatically.")) return;
    if (nextState === "sent") {
      if (!reviewedDisclosure) { setError("Review and confirm the shared disclosure before recording a sent offer."); return; }
      if (!window.confirm(`Confirm that you manually sent this exact reviewed offer to ${offer.agent?.name ?? "the matched agent"} using ${channel}. This action does not send email or contact the agent.`)) return;
    }
    const summary = ["responded", "interested", "accepted"].includes(nextState) ? (responseNotes[offer.id] ?? "").trim() : undefined;
    if (["responded", "interested", "accepted"].includes(nextState) && !summary) { setError("Record a brief factual response summary first."); return; }
    await offerAction(offer, { action: "transition", nextState, ...(summary ? { summary } : {}), ...(nextState === "sent" ? { message: offer.message, channel, sharedDisclosureConfirmed: true } : {}) }, nextState === "sent" ? "Manual-sent status recorded. No message was sent by this workspace." : `Offer moved to ${readable(nextState)}.`);
    if (summary) setResponseNotes((current) => ({ ...current, [offer.id]: "" }));
  }

  async function recordPayment(offer: Offer) {
    const form = paymentForms[offer.id] ?? { reference: "", evidence: "", amount: "" };
    if (!window.confirm("Record the entered payment reference and evidence as manually reconciled? This is not provider-verified.")) return;
    await offerAction(offer, { action: "payment", paymentReference: form.reference.trim(), evidenceNote: form.evidence.trim(), amount: Number(form.amount), currency: offer.currency }, "Manual payment evidence recorded. It was not verified by a payment provider.");
  }

  const updatePayment = (id: string, key: "reference" | "evidence" | "amount", value: string) => setPaymentForms((current) => ({ ...current, [id]: { ...{ reference: "", evidence: "", amount: "" }, ...current[id], [key]: value } }));

  return <>
    <div className="page-heading"><div><p className="eyebrow">Workspace / Lead offers</p><h1>Lead-batch offers</h1><p className="subheading">Select owner-indicated records, snapshot qualification, match agents, and manage reviewed offers. Communication and payment evidence are recorded manually; nothing is sent or provider-verified here.</p></div><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading}>Refresh workspace</button></div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}{notice && <div className="workspace-alert success" role="status">{notice}</div>}
    <div className="notice-banner" role="note"><span aria-hidden="true">i</span><div><b>Shared disclosure for agents</b><p>{DISCLOSURE} Confirm the disclosure before recording an offer as manually sent. Offer content is never emailed by this workspace.</p></div></div>

    <section className="panel" style={{ padding: 18, marginBottom: 18 }} aria-labelledby="batch-builder-title">
      <div className="panel-header"><div><h2 id="batch-builder-title">Build a batch from existing owner-indicated listings</h2><p>Choose 1–50 records. City matching is exact (case-insensitive); the batch endpoint will re-check all qualification rules.</p></div></div>
      {loading ? <div className="workspace-state">Loading listings and current batch data…</div> : <form onSubmit={createBatch} style={{ display: "grid", gap: 14, marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
          <label style={inputStyle}>Exact city<select style={controlStyle} value={city} onChange={(event) => { setCity(event.target.value); setSelectedIds([]); }}><option value="">Choose a city…</option>{cityOptions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label style={inputStyle}>Batch name (optional)<input style={controlStyle} value={batchName} onChange={(event) => setBatchName(event.target.value)} maxLength={160} placeholder="e.g. Central district owner leads" /></label>
          <label style={inputStyle}>Maximum record age<select style={controlStyle} value={freshness} onChange={(event) => setFreshness(event.target.value)}><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select></label>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={exclusive} onChange={(event) => setExclusive(event.target.checked)} />Offer this batch as exclusive</label>
        {city && <fieldset style={{ border: "1px solid #e3eae5", borderRadius: 8, padding: 12, margin: 0 }}><legend style={{ padding: "0 5px", color: "#52635a", fontSize: 11, fontWeight: 650 }}>Records in {city} — {selectedCount} selected of {cityListings.length}</legend>
          {cityListings.length === 0 ? <p className="workspace-state compact">No owner-indicated listings match this exact city.</p> : <div style={{ display: "grid", gap: 8, maxHeight: 290, overflowY: "auto" }}>{cityListings.map((listing) => <label key={listing.id} style={{ display: "flex", alignItems: "flex-start", gap: 9, borderBottom: "1px solid #f0f3f1", padding: "7px 2px", fontSize: 11, color: "#52635a" }}><input type="checkbox" checked={selectedIds.includes(listing.id)} disabled={!selectedIds.includes(listing.id) && selectedIds.length >= 50} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, listing.id] : current.filter((id) => id !== listing.id))} /><span><b>{listing.title || "Untitled listing"}</b><br /><span>{listing.property_type ?? "Property type not recorded"} · {listing.poster_type ?? "Owner-indicated"}{listing.region ? ` · ${listing.region}` : ""} · last seen {dateLabel(listing.last_seen_at)}</span></span></label>)}</div>}
        </fieldset>}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}><button className="primary-button" disabled={busy === "batch" || selectedCount < 1 || selectedCount > 50}>{busy === "batch" ? "Checking qualification…" : `Create batch from ${selectedCount} selected`}</button><span style={{ color: "#839087", fontSize: 10 }}>Fewer than 20 current qualified records remain a draft and cannot be approved.</span></div>
      </form>}
      {latestRejected.length > 0 && <div style={{ marginTop: 14 }}><h3 style={{ fontSize: 12 }}>Rejected selection reasons</h3><ul>{latestRejected.map((item, index) => <li key={`${item.id ?? index}`}>{item.title ?? item.id ?? "Listing"}: {(item.reasons ?? []).join(", ") || "Not qualified"}</li>)}</ul></div>}
    </section>

    <section className="panel" style={{ padding: 18, marginBottom: 18 }} aria-labelledby="batches-title"><div className="panel-header"><div><h2 id="batches-title">Batch qualification and review</h2><p>Snapshots reflect qualified records at creation. Approval is available only when the current batch is review-ready with at least 20 qualifying records.</p></div></div>
      {loading ? <div className="workspace-state">Loading batches…</div> : batches.length === 0 ? <div className="workspace-state">No lead batches yet. Select existing owner-indicated records above to create one.</div> : <div style={{ display: "grid", gap: 12, marginTop: 14 }}>{batches.map((batch) => {
        const summary = batch.summary ?? {}; const count = batch.listing_count ?? batch.listingCount ?? intFact(summary, "lead_count");
        const matches = matchResults[batch.id]; const rejected = batch.rejected ?? rejectedByBatch[batch.id] ?? [];
        return <article key={batch.id} style={cardStyle}><div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10 }}><div><h3 style={{ margin: "0 0 5px", fontSize: 14 }}>{batch.name}</h3><div style={{ color: "#75847b", fontSize: 11 }}>{batch.city}, {batch.country_code} · {count} qualified · freshness ≤ {batch.minimum_freshness_days} days · {batch.exclusive ? "Exclusive" : "Non-exclusive"}</div></div><span className="status-pill">{readable(batch.status)}</span></div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", margin: "12px 0", color: "#52635a", fontSize: 11 }}><span>Owner verified: <b>{intFact(summary, "owner_verified")}</b></span><span>Owner unverified: <b>{intFact(summary, "owner_unverified")}</b></span><span>Contact-marked: <b>{intFact(summary, "contacts_available")}</b></span><span>Currency: <b>{batch.currency}</b></span><span>Price range: <b>{typeof summary.asking_price_min === "number" ? summary.asking_price_min : "not recorded"} – {typeof summary.asking_price_max === "number" ? summary.asking_price_max : "not recorded"}</b></span></div>
          {count < 20 && <p style={{ color: "#946a2b", fontSize: 11, margin: "8px 0" }}>Below the minimum: {count}/20 records. This batch remains a draft and is not eligible for approval or matching.</p>}
          {rejected.length ? <details><summary>Qualification rejections ({rejected.length})</summary><ul>{rejected.map((item, index) => <li key={item.id ?? index}>{item.title ?? item.id}: {(item.reasons ?? []).join(", ")}</li>)}</ul></details> : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {batch.status === "ready_for_review" && count >= 20 && <button className="primary-button small" disabled={busy === batch.id} onClick={() => void batchAction(batch, "approve")}>Approve batch</button>}
            {batch.status === "approved" && <button className="secondary-button small" disabled={busy === `match:${batch.id}`} onClick={() => void findMatches(batch)}>{busy === `match:${batch.id}` ? "Matching…" : "Find matched agents"}</button>}
            {["draft", "ready_for_review"].includes(batch.status) && <button className="secondary-button small" disabled={busy === batch.id} onClick={() => void batchAction(batch, "archive")}>Archive batch</button>}
          </div>
          {matches && <div style={{ marginTop: 14, display: "grid", gap: 9 }}><h4 style={{ margin: 0, fontSize: 12 }}>Compatible agents ({matches.matches.length})</h4>{matches.matches.length === 0 && <p style={{ fontSize: 11 }}>No eligible matches were returned.</p>}{matches.matches.map((match) => <div key={match.agentId} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, background: "#f8faf8", padding: 9, borderRadius: 7 }}><span style={{ fontSize: 11 }}><b>{match.agentName}</b> · score {match.score}/100{match.factors?.length ? <span style={{ color: "#7b8981" }}> · {match.factors.map((factor) => `${factor.factor} (+${factor.points}): ${factor.explanation}`).join("; ")}</span> : null}</span><button className="secondary-button small" onClick={() => prepareOffer(batch, match)}>Create offer draft</button></div>)}
            {matches.excluded.length > 0 && <details><summary>Excluded agents ({matches.excluded.length})</summary><ul>{matches.excluded.map((item, index) => <li key={`${item.agentId ?? index}`}>{item.agentName}: {item.reason}</li>)}</ul></details>}</div>}
        </article>;
      })}</div>}
    </section>

    {offerAgent && <section className="panel" style={{ padding: 18, marginBottom: 18 }} aria-labelledby="new-offer-title"><div className="panel-header"><div><h2 id="new-offer-title">Prepare offer draft</h2><p>Enter the price yourself. Currency must match the batch; no default or suggested price is applied.</p></div><button type="button" className="secondary-button small" onClick={() => setOfferAgent("")}>Cancel</button></div>
      <form onSubmit={createOffer} style={{ display: "grid", gap: 12, marginTop: 14 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <label style={inputStyle}>Pricing method<select style={controlStyle} value={pricingMode} onChange={(event) => setPricingMode(event.target.value as "batch" | "per_lead")}><option value="batch">One price for the batch</option><option value="per_lead">Price per lead</option></select></label>
        <label style={inputStyle}>Operator-entered price<input style={controlStyle} type="number" min="0.01" step="any" value={priceAmount} onChange={(event) => setPriceAmount(event.target.value)} required /></label>
        <label style={inputStyle}>Currency<input style={controlStyle} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase().slice(0, 3))} required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" aria-describedby="currency-help" /><small id="currency-help">Batch currency: {batchMap.get(activeBatch)?.currency}</small></label>
        <label style={inputStyle}>Manual contact channel<select style={controlStyle} value={channel} onChange={(event) => setChannel(event.target.value)}><option value="manual">Manual / offline</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option><option value="email">Email (record only; not sent here)</option></select></label>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 8 }}><label style={{ ...inputStyle, minWidth: 210 }}>Message template<select style={controlStyle} value={offerTemplate} onChange={(event) => { const next = event.target.value as OfferTemplateKey; setOfferTemplate(next); const batch = batchMap.get(activeBatch); if (batch) setOfferMessage(makeMessage(batch, offerAgentName, next, currentPriceLabel())); }} aria-label="Choose offer message template">{templateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button type="button" className="secondary-button small" onClick={() => { const batch = batchMap.get(activeBatch); if (batch) setOfferMessage(makeMessage(batch, offerAgentName, offerTemplate, currentPriceLabel())); }}>Refresh template with current facts</button></div>
      <label style={inputStyle}>Factual, editable offer message<textarea style={{ ...controlStyle, minHeight: 190, resize: "vertical" }} value={offerMessage} onChange={(event) => setOfferMessage(event.target.value)} required maxLength={4000} /></label>
      <p style={{ margin: 0, color: "#65766c", fontSize: 11 }}>{DISCLOSURE}</p><button className="primary-button" disabled={busy === "offer"}>{busy === "offer" ? "Creating draft…" : "Create offer draft"}</button></form>
    </section>}

    <section className="panel" style={{ padding: 18 }} aria-labelledby="offers-title"><div className="panel-header"><div><h2 id="offers-title">Offer review, responses, payment, and delivery</h2><p>Every contact is operator-mediated. “Sent” means you confirm that you sent it manually; this app does not send messages.</p></div></div>
      {loading ? <div className="workspace-state">Loading offers…</div> : offers.length === 0 ? <div className="workspace-state">No offers yet. Approve an eligible batch, match agents, and prepare an offer draft.</div> : <div style={{ display: "grid", gap: 12, marginTop: 14 }}>{offers.map((offer) => {
        const batch = offer.batch ?? batchMap.get(offer.batch_id); const editable = ["draft", "ready_for_review"].includes(offer.status);
        const offerPriceLabel = offer.pricing_mode === "per_lead" ? `${formatMinorAmount(offer.unit_price_minor_units, offer.currency)} per lead (${formatMinorAmount(offer.price_minor_units, offer.currency)} total)` : formatMinorAmount(offer.price_minor_units, offer.currency);
        const nextStates: Record<string, string[]> = { draft: ["ready_for_review"], ready_for_review: ["approved"], approved: ["sent"], sent: ["responded"], responded: ["interested"], interested: ["accepted"] };
        const states = nextStates[offer.status] ?? [];
        return <article key={offer.id} style={cardStyle}><div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}><div><h3 style={{ margin: "0 0 5px", fontSize: 13 }}>{offer.agent?.name ?? "Matched agent"} · {batch?.name ?? "Lead batch"}</h3><p style={{ margin: 0, color: "#78867f", fontSize: 11 }}>{batch?.city ?? ""} · {offer.pricing_mode === "per_lead" ? `${formatMinorAmount(offer.unit_price_minor_units, offer.currency)} per lead (${formatMinorAmount(offer.price_minor_units, offer.currency)} total)` : formatMinorAmount(offer.price_minor_units, offer.currency)} · status: {readable(offer.status)}</p></div><span className="status-pill">{readable(offer.status)}</span></div>
          <p style={{ margin: "10px 0", color: "#52635a", fontSize: 11, whiteSpace: "pre-wrap" }}>{offer.message}</p>
          {editingOffer === offer.id && editable && <div style={{ display: "grid", gap: 8, margin: "10px 0" }}><label style={inputStyle}>Message template<select style={controlStyle} value={templateDrafts[offer.id] ?? (offer.template_key as OfferTemplateKey) ?? "initial_offer"} onChange={(event) => { const next = event.target.value as OfferTemplateKey; setTemplateDrafts((current) => ({ ...current, [offer.id]: next })); const facts = toMessageFacts(batch); if (facts) setMessageDrafts((current) => ({ ...current, [offer.id]: makeMessage(facts, offer.agent?.name ?? "agent", next, offerPriceLabel) })); }}>{templateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label style={inputStyle}>Edit offer message<textarea style={{ ...controlStyle, minHeight: 150 }} maxLength={4000} value={messageDrafts[offer.id] ?? ""} onChange={(event) => setMessageDrafts((current) => ({ ...current, [offer.id]: event.target.value }))} /></label><div style={{ display: "flex", gap: 8 }}><button className="primary-button small" onClick={() => void saveMessage(offer)}>Save message</button><button className="secondary-button small" onClick={() => setEditingOffer(null)}>Cancel</button></div></div>}
          {offer.shared_disclosure_confirmed && <p style={{ color: "#447552", fontSize: 10 }}>Shared disclosure confirmation recorded.</p>}
          {offer.response_summary && <div style={{ borderLeft: "3px solid #d8e7dd", margin: "8px 0", padding: "5px 9px", color: "#66776e", fontSize: 11 }}><b>Recorded response:</b> {offer.response_summary}</div>}
          {editable && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" }}><button className="secondary-button small" onClick={() => { setMessageDrafts((current) => ({ ...current, [offer.id]: offer.message ?? "" })); setEditingOffer(offer.id); }}>Edit factual message</button>{states.map((state) => <button key={state} className="primary-button small" disabled={busy === offer.id} onClick={() => void recordTransition(offer, state)}>{state === "ready_for_review" ? "Submit for review" : "Approve offer"}</button>)}</div>}
          {offer.status === "approved" && <div style={{ display: "grid", gap: 9, borderTop: "1px solid #edf1ee", paddingTop: 11 }}><label style={inputStyle}>Channel for manual send record<select style={controlStyle} value={channel} onChange={(event) => setChannel(event.target.value)}><option value="manual">Manual / offline</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select></label><label className="checkbox-label"><input type="checkbox" checked={reviewedDisclosure} onChange={(event) => setReviewedDisclosure(event.target.checked)} />I reviewed the offer text and shared disclosure above; I confirm the disclosure will be shared with the agent.</label><button className="primary-button small" disabled={busy === offer.id || !reviewedDisclosure} onClick={() => void recordTransition(offer, "sent")}>Confirm manually sent (no message sent here)</button></div>}
          {["sent", "responded", "interested"].includes(offer.status) && <div style={{ display: "grid", gap: 9, borderTop: "1px solid #edf1ee", paddingTop: 11, marginTop: 9 }}><label style={inputStyle}>Factual agent response note<textarea style={{ ...controlStyle, minHeight: 70 }} maxLength={2000} value={responseNotes[offer.id] ?? ""} onChange={(event) => setResponseNotes((current) => ({ ...current, [offer.id]: event.target.value }))} placeholder="Record what the agent actually said or requested." /></label><div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{states.map((state) => <button key={state} className="secondary-button small" disabled={busy === offer.id} onClick={() => void recordTransition(offer, state)}>{state === "responded" ? "Record response" : state === "interested" ? "Mark interested" : "Mark accepted"}</button>)}</div></div>}
          {offer.status === "accepted" && <div style={{ display: "grid", gap: 9, borderTop: "1px solid #edf1ee", paddingTop: 11, marginTop: 9 }}><div className="workspace-alert" role="note" style={{ margin: 0, borderColor: "#f0dfbf", background: "#fffaf0", color: "#806535" }}>Manual payment evidence is an operator-entered record only. It is not verified by a payment provider. Verify payment independently before proceeding.</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 9 }}><label style={inputStyle}>Payment reference<input style={controlStyle} minLength={4} maxLength={160} value={paymentForms[offer.id]?.reference ?? ""} onChange={(event) => updatePayment(offer.id, "reference", event.target.value)} /></label><label style={inputStyle}>Evidence amount ({offer.currency})<input style={controlStyle} type="number" min="0" step="any" value={paymentForms[offer.id]?.amount ?? ""} onChange={(event) => updatePayment(offer.id, "amount", event.target.value)} /></label></div><label style={inputStyle}>Evidence note<textarea style={{ ...controlStyle, minHeight: 65 }} minLength={8} maxLength={2000} value={paymentForms[offer.id]?.evidence ?? ""} onChange={(event) => updatePayment(offer.id, "evidence", event.target.value)} /></label><button className="primary-button small" disabled={busy === offer.id || !paymentForms[offer.id]?.reference || !paymentForms[offer.id]?.evidence} onClick={() => void recordPayment(offer)}>Record manual payment evidence</button></div>}
          {offer.status === "paid" && <div style={{ display: "grid", gap: 9, borderTop: "1px solid #edf1ee", paddingTop: 11, marginTop: 9 }}><p style={{ margin: 0, color: "#806535", fontSize: 11 }}>Payment was marked paid from manually submitted evidence, not payment-provider verification. Confirm the batch is appropriate to deliver.</p><button className="primary-button small" disabled={busy === offer.id} onClick={() => { if (window.confirm("Confirm delivery of the purchased batch in the app? This does not send email.")) void offerAction(offer, { action: "deliver" }, "Batch delivery recorded."); }}>Confirm batch delivered</button></div>}
          {offer.status === "delivered" && <p style={{ color: "#447552", fontSize: 11 }}>Batch delivery was recorded in this workspace.</p>}
        </article>;
      })}</div>}
    </section>
  </>;
}
