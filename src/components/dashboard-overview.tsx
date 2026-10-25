"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "@/components/dashboard-shell";

type Summary = { id: string; title: string; summary: string; status: string; owner_led_claim: boolean; created_at: string };

export function DashboardOverview() {
  const [listings, setListings] = useState<Summary[]>([]);
  const [metrics, setMetrics] = useState<{ openOpportunities: number; ownerLedSignals: number; pendingInterest: number | null } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [listingResponse, metricsResponse] = await Promise.all([fetch("/api/listings"), fetch("/api/dashboard/metrics")]);
      if (!listingResponse.ok) throw new Error((await listingResponse.json()).error ?? "Unable to load opportunities");
      if (!metricsResponse.ok) throw new Error((await metricsResponse.json()).error ?? "Unable to load workspace metrics");
      const listingBody = await listingResponse.json();
      const metricsBody = await metricsResponse.json();
      setListings(listingBody.data as Summary[]);
      setMetrics(metricsBody.data);
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
    <div className="page-heading"><div><p className="eyebrow">Workspace / Overview</p><h1>Opportunity operations</h1><p className="subheading">A live view of your organization&apos;s property pipeline. Counts reflect stored records only.</p></div><Link className="primary-button" href="/dashboard/leads">Review opportunities</Link></div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}
    <div className="metric-grid">
      <div className="metric-card"><div className="metric-label"><span>Open opportunities</span><span className="metric-icon blue">◎</span></div><div className="metric-value">{loading ? "…" : metrics?.openOpportunities ?? 0}</div><div className="metric-change blue">Current workspace <span>live records</span></div></div>
      <div className="metric-card"><div className="metric-label"><span>Awaiting interest review</span><span className="metric-icon amber">⌁</span></div><div className="metric-value">{loading ? "…" : awaitingReview}</div><div className="metric-change amber">Human decision required <span>no auto-unlock</span></div></div>
      <div className="metric-card"><div className="metric-label"><span>Owner-listed signals</span><span className="metric-icon purple">◇</span></div><div className="metric-value">{loading ? "…" : metrics?.ownerLedSignals ?? 0}</div><div className="metric-change purple">Unverified source signal <span>requires human review</span></div></div>
      <div className="metric-card"><div className="metric-label"><span>Owner outreach</span><span className="metric-icon green">↗</span></div><div className="metric-value">Off</div><div className="metric-change green">Not sent by LeadForge <span>no automatic contact</span></div></div>
    </div>
    <div className="content-grid"><section className="panel activity-panel"><div className="panel-header"><div><h2>Latest opportunities</h2><p>Newest records stored in your workspace</p></div><Link className="text-button" href="/dashboard/leads">View queue →</Link></div>
      {loading ? <div className="workspace-state">Loading live workspace data…</div> : listings.length === 0 ? <div className="workspace-state compact"><h3>No opportunity records yet</h3><p>Records added by your team or ingested from a permitted source appear here.</p><Link className="primary-button" href="/dashboard/leads">Add an opportunity</Link></div> : <div className="overview-list">{listings.slice(0, 5).map((listing) => <div className="overview-row" key={listing.id}><div><b>{listing.title}</b><small>{listing.summary}</small></div><StatusPill tone={listing.status === "matched" ? "green" : "blue"}>{listing.status}</StatusPill></div>)}</div>}
    </section><section className="panel privacy-panel"><div className="panel-header"><div><h2>Privacy workflow</h2><p>Three gates protect owner information</p></div><span className="metric-icon green">✓</span></div><ol className="privacy-steps"><li><b>Summary only</b><span>Agents see an area-level opportunity summary.</span></li><li><b>Explicit interest</b><span>A matched agent requests details for a specific listing.</span></li><li><b>Human approval</b><span>A manager decision enables audited detail access.</span></li></ol><Link href="/dashboard/follow-ups" className="text-button">Review pending requests →</Link></section></div>
  </>;
}
