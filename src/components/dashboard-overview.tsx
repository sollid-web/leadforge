"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "@/components/dashboard-shell";

type Summary = { id: string; title: string; summary: string; status: string; owner_led_claim: boolean; created_at: string };
type ConversionBucket = { offers: number; sent: number; responses: number; interested: number; paid: number; delivered: number; responseRate: number | null; interestRate: number | null };
type SalesMetrics = {
  freshnessWindowDays: number;
  listingsDiscovered: number;
  ownerClaimedLeads: number;
  ownerVerifiedLeads: number;
  qualifiedOwnerClaimedLeads: number;
  qualifiedOwnerVerifiedLeads: number;
  contactsAvailable: number;
  freshLeads: number;
  staleLeads: number;
  agentsDiscovered: number;
  agentsReviewed: number;
  offersPrepared: number;
  offersSent: number;
  responses: number;
  interested: number;
  responseRate: number | null;
  interestRate: number | null;
  batchesCreated: number;
  batchesSold: number;
  deliveredOffers: number;
  revenueByCurrency: Record<string, { grossMinor: number; refundedMinor: number; netMinor: number }>;
  conversions: { city: Record<string, ConversionBucket>; sourceCoverage: Record<string, ConversionBucket>; offerType: Record<string, ConversionBucket> };
  conversionAttributionNote: string;
};

function formatMinorAmount(minor: number, currency: string) {
  try {
    const fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / (10 ** fractionDigits));
  } catch { return `${currency} ${minor} minor units`; }
}

function ConversionBreakdown({ title, rows, note }: { title: string; rows: Record<string, ConversionBucket>; note?: string }) {
  const entries = Object.entries(rows);
  return <section className="panel" style={{ minWidth: 0 }}>
    <div className="panel-header"><div><h2>{title}</h2><p>{note ?? "Persisted offer activity only"}</p></div></div>
    {entries.length === 0 ? <p className="muted small">No offer activity recorded.</p> : <div className="table-wrap"><table><thead><tr><th>Group</th><th>Sent</th><th>Responses</th><th>Interested</th><th>Paid</th><th>Response / interest</th></tr></thead><tbody>
      {entries.map(([name, row]) => <tr key={name}><td>{name}</td><td>{row.sent}</td><td>{row.responses}</td><td>{row.interested}</td><td>{row.paid}</td><td>{row.responseRate === null ? "—" : `${row.responseRate}%`} / {row.interestRate === null ? "—" : `${row.interestRate}%`}</td></tr>)}
    </tbody></table></div>}
  </section>;
}

export function DashboardOverview() {
  const [listings, setListings] = useState<Summary[]>([]);
  const [metrics, setMetrics] = useState<{ openOpportunities: number; ownerLedSignals: number; pendingInterest: number | null } | null>(null);
  const [salesMetrics, setSalesMetrics] = useState<SalesMetrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [listingResponse, metricsResponse, salesResponse] = await Promise.all([fetch("/api/listings"), fetch("/api/dashboard/metrics"), fetch("/api/agent-sales-metrics")]);
      if (!listingResponse.ok) throw new Error((await listingResponse.json()).error ?? "Unable to load opportunities");
      if (!metricsResponse.ok) throw new Error((await metricsResponse.json()).error ?? "Unable to load workspace metrics");
      const listingBody = await listingResponse.json();
      const metricsBody = await metricsResponse.json();
      setListings(listingBody.data as Summary[]);
      setMetrics(metricsBody.data);
      if (salesResponse.ok) setSalesMetrics((await salesResponse.json()).data as SalesMetrics);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load workspace activity");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const awaitingReview = metrics?.pendingInterest === null || !metrics ? "—" : String(metrics.pendingInterest);
  return <>
    <div className="page-heading"><div><p className="eyebrow">Workspace / Overview</p><h1>Opportunity operations</h1><p className="subheading">A live view of persisted property, agent, offer, and delivery records. Missing activity is shown as zero or unavailable.</p></div><Link className="primary-button" href="/dashboard/leads">Review opportunities</Link></div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}
    <div className="metric-grid">
      <div className="metric-card"><div className="metric-label"><span>Open opportunities</span><span className="metric-icon blue">◎</span></div><div className="metric-value">{loading ? "…" : metrics?.openOpportunities ?? 0}</div><div className="metric-change blue">Current workspace <span>live records</span></div></div>
      <div className="metric-card"><div className="metric-label"><span>Awaiting interest review</span><span className="metric-icon amber">⌁</span></div><div className="metric-value">{loading ? "…" : awaitingReview}</div><div className="metric-change amber">Human decision required <span>no auto-unlock</span></div></div>
      <div className="metric-card"><div className="metric-label"><span>Owner-listed signals</span><span className="metric-icon purple">◇</span></div><div className="metric-value">{loading ? "…" : metrics?.ownerLedSignals ?? 0}</div><div className="metric-change purple">Unverified source signal <span>requires human review</span></div></div>
      <div className="metric-card"><div className="metric-label"><span>Owner outreach</span><span className="metric-icon green">↗</span></div><div className="metric-value">Off</div><div className="metric-change green">Not sent by EstatelQ <span>no automatic contact</span></div></div>
    </div>

    {salesMetrics && <>
      <div className="section-heading"><div><h2>Listing health and qualification</h2><p>Suppressed records are excluded; freshness uses the {salesMetrics.freshnessWindowDays}-day operating window.</p></div><Link href="/dashboard/leads" className="text-button">Review opportunities →</Link></div>
      <div className="metric-grid">
        <div className="metric-card"><div className="metric-label"><span>Listings discovered</span></div><div className="metric-value">{loading ? "…" : salesMetrics.listingsDiscovered}</div><div className="metric-change blue">Persisted records <span>not run estimates</span></div></div>
        <div className="metric-card"><div className="metric-label"><span>Qualified owner-claimed</span></div><div className="metric-value">{loading ? "…" : salesMetrics.qualifiedOwnerClaimedLeads}</div><div className="metric-change purple">Fresh · active · approved source <span>not owner verified</span></div></div>
        <div className="metric-card"><div className="metric-label"><span>Qualified owner-verified</span></div><div className="metric-value">{loading ? "…" : salesMetrics.qualifiedOwnerVerifiedLeads}</div><div className="metric-change green">Human-reviewed, current records <span>zero if none</span></div></div>
        <div className="metric-card"><div className="metric-label"><span>Contact available</span></div><div className="metric-value">{loading ? "…" : salesMetrics.contactsAvailable}</div><div className="metric-change amber">Availability only <span>not contact consent</span></div></div>
        <div className="metric-card"><div className="metric-label"><span>Fresh / stale</span></div><div className="metric-value">{loading ? "…" : `${salesMetrics.freshLeads} / ${salesMetrics.staleLeads}`}</div><div className="metric-change blue">Fresh within {salesMetrics.freshnessWindowDays} days <span>based on last seen</span></div></div>
      </div>

      <div className="section-heading"><div><h2>Agent sales operations</h2><p>Live persisted counts; payments are manually reconciled and revenue remains separated by currency.</p></div><Link href="/dashboard/offers" className="text-button">Open offers →</Link></div>
      <div className="metric-grid">
        <div className="metric-card"><div className="metric-label"><span>Agents discovered / reviewed</span><span className="metric-icon blue">◉</span></div><div className="metric-value">{loading ? "…" : `${salesMetrics.agentsDiscovered} / ${salesMetrics.agentsReviewed}`}</div><div className="metric-change blue">Operator-managed <span>no live directory feed</span></div></div>
        <div className="metric-card"><div className="metric-label"><span>Offer response / interest</span><span className="metric-icon amber">↗</span></div><div className="metric-value">{loading ? "…" : `${salesMetrics.responseRate === null ? "—" : `${salesMetrics.responseRate}%`} / ${salesMetrics.interestRate === null ? "—" : `${salesMetrics.interestRate}%`}`}</div><div className="metric-change amber">{salesMetrics.responses} responses · {salesMetrics.interested} interested <span>{salesMetrics.offersSent} sent</span></div></div>
        <div className="metric-card"><div className="metric-label"><span>Batches sold / offers delivered</span><span className="metric-icon purple">◇</span></div><div className="metric-value">{loading ? "…" : `${salesMetrics.batchesSold} / ${salesMetrics.deliveredOffers}`}</div><div className="metric-change purple">Paid batches and releases <span>authorized buyers only</span></div></div>
        <div className="metric-card"><div className="metric-label"><span>Gross / refunds / net</span><span className="metric-icon green">$</span></div><div className="metric-value" style={{ fontSize: "0.95rem" }}>{loading ? "…" : Object.entries(salesMetrics.revenueByCurrency).length ? Object.entries(salesMetrics.revenueByCurrency).map(([currency, value]) => `${currency}: ${formatMinorAmount(value.grossMinor, currency)} / ${formatMinorAmount(value.refundedMinor, currency)} / ${formatMinorAmount(value.netMinor, currency)}`).join(" · ") : "—"}</div><div className="metric-change green">Manual reconciliation only <span>not payment-provider verified</span></div></div>
      </div>

      <div className="section-heading"><div><h2>Offer conversion breakdown</h2><p>{salesMetrics.conversionAttributionNote}</p></div></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 16 }}>
        <ConversionBreakdown title="By city" rows={salesMetrics.conversions.city} />
        <ConversionBreakdown title="By batch source coverage" rows={salesMetrics.conversions.sourceCoverage} note="A source may appear in multiple batches; this is not causal attribution." />
        <ConversionBreakdown title="By offer type" rows={salesMetrics.conversions.offerType} note="Batch-price versus per-lead-price offers." />
      </div>
    </>}

    <div className="content-grid"><section className="panel activity-panel"><div className="panel-header"><div><h2>Latest opportunities</h2><p>Newest records stored in your workspace</p></div><Link className="text-button" href="/dashboard/leads">View queue →</Link></div>
      {loading ? <div className="workspace-state">Loading live workspace data…</div> : listings.length === 0 ? <div className="workspace-state compact"><h3>No opportunity records yet</h3><p>Records added by your team or ingested from a permitted source appear here.</p><Link className="primary-button" href="/dashboard/leads">Add an opportunity</Link></div> : <div className="overview-list">{listings.slice(0, 5).map((listing) => <div className="overview-row" key={listing.id}><div><b>{listing.title}</b><small>{listing.summary}</small></div><StatusPill tone={listing.status === "matched" ? "green" : "blue"}>{listing.status}</StatusPill></div>)}</div>}
    </section><section className="panel privacy-panel"><div className="panel-header"><div><h2>Privacy workflow</h2><p>Three gates protect owner information</p></div><span className="metric-icon green">✓</span></div><ol className="privacy-steps"><li><b>Summary only</b><span>Agents see an area-level opportunity summary.</span></li><li><b>Explicit interest</b><span>A matched agent requests details for a specific listing.</span></li><li><b>Human approval</b><span>A manager decision enables audited detail access.</span></li></ol><Link href="/dashboard/follow-ups" className="text-button">Review pending requests →</Link></section></div>
  </>;
}
