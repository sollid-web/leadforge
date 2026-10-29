"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "@/components/dashboard-shell";

type Source = { id: string; name: string; source_key: string; source_type: string; source_url: string | null; approved: boolean; active: boolean };
type Run = { id: string; source_id: string; provider: string; status: string; discovered_count: number; imported_count: number; duplicate_count: number; rejected_count: number; held_count: number; contacts_found_count: number; error_message: string | null; started_at: string; completed_at: string | null; worker_configuration: Record<string, unknown>; worker_progress: Record<string, unknown>; worker_artifact_name: string | null; worker_heartbeat_at: string | null; authorization_reference: string | null };
type Hold = { id: string; source_id: string; run_id: string; external_id: string; title: string; listing_url: string; city: string; country_code: string; reason_code: string; evidence_codes: string[]; created_at: string };
const workerCities = ["Miami", "Fort Lauderdale", "West Palm Beach", "Broward", "Boca Raton", "Hialeah", "Palm Beach"];

export function ScraperWorkerWorkspace() {
  const [sources, setSources] = useState<Source[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [city, setCity] = useState("");
  const propertyType = "all";
  const listingIntent = "sale";
  const [resultLimit, setResultLimit] = useState(25);
  const [authorizationReference, setAuthorizationReference] = useState("");
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const [workerConfigured, setWorkerConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [holdError, setHoldError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [sourceResponse, runResponse, holdResponse] = await Promise.all([fetch("/api/sources"), fetch("/api/scraper-runs"), fetch("/api/scraper-holds")]);
      const sourceBody = await sourceResponse.json();
      const runBody = await runResponse.json();
      const holdBody = await holdResponse.json();
      if (!sourceResponse.ok) throw new Error(sourceBody.error ?? "Unable to load approved sources");
      if (!runResponse.ok) throw new Error(runBody.error ?? "Unable to load collection runs");
      setSources((sourceBody.data ?? []) as Source[]);
      setRuns((runBody.data ?? []) as Run[]);
      if (holdResponse.ok) {
        setHolds((holdBody.data ?? []) as Hold[]);
        setHoldError("");
      } else {
        setHolds([]);
        setHoldError(holdBody.error ?? "The ambiguous-candidate queue is unavailable until its database migration is applied.");
      }
      setWorkerConfigured(Boolean(runBody.workerConfigured));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load scraper status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function startRun(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/scraper-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: selectedSource, countryCode: "US", city, propertyType, listingIntent, resultLimit, authorizationReference, authorizationConfirmed }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to start worker run");
      setMessage(`Worker run ${body.data.id} was started. The authenticated completion callback ingests eligible candidates automatically; ambiguous records are held for manager review. No agent outreach is sent by this test-run form.`);
      setAuthorizationReference("");
      setAuthorizationConfirmed(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to start worker run");
    } finally { setBusy(false); }
  }

  async function dismissHold(hold: Hold) {
    setError("");
    try {
      const response = await fetch("/api/scraper-holds", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hold.id, action: "dismiss" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to dismiss candidate hold");
      setHolds((current) => current.filter((item) => item.id !== hold.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to dismiss candidate hold");
    }
  }

  const approvedSources = sources.filter((source) => source.approved && source.active);
  return <>
    <div className="page-heading"><div><p className="eyebrow">Workspace / Collection runs</p><h1>Python scraper worker</h1><p className="subheading">The existing Python adapters run in an isolated worker. Recurring discovery is configured separately in Owner-seller scraper schedule; this page is for diagnostics and one-off test runs.</p></div><button className="secondary-button" onClick={() => void load()} disabled={loading}>Refresh runs</button></div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}{message && <div className="workspace-alert success" role="status">{message}</div>}
    {holdError && <div className="workspace-alert" role="status">Ambiguous-candidate exception queue unavailable: {holdError}</div>}
    {!workerConfigured && <div className="workspace-alert"><b>Worker configuration incomplete.</b> Configure the separate worker URL, shared token, trusted HTTPS app callback URL, and apply the new database migration before starting collection. No run was created by opening this page.</div>}
    <div className="content-grid"><section className="panel"><div className="panel-header"><div><h2>Configure a run</h2><p>Only approved, active LeadForge sources are selectable.</p></div></div>
      <form className="form-grid" onSubmit={startRun}>
        <label className="field full"><span>Approved source</span><select value={selectedSource} onChange={(event) => setSelectedSource(event.target.value)} required><option value="">Select source</option>{approvedSources.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.source_key}</option>)}</select></label>
        <label className="field"><span>Country</span><input value="United States (US)" readOnly /></label>
        <label className="field"><span>City / market</span><select value={city} onChange={(event) => setCity(event.target.value)} required><option value="">Select exact configured label</option>{workerCities.map((label) => <option key={label} value={label}>{label}</option>)}</select></label>
        <label className="field"><span>Property type</span><input value="Unclassified / all (adapter cannot filter reliably)" readOnly /></label>
        <label className="field"><span>Listing intent</span><input value="Sale only (adapter capability)" readOnly /></label>
        <label className="field"><span>Maximum result count</span><input type="number" min={1} max={50} value={resultLimit} onChange={(event) => setResultLimit(Number(event.target.value))} /></label>
        <label className="field full"><span>Authorization / terms review reference</span><input value={authorizationReference} onChange={(event) => setAuthorizationReference(event.target.value)} minLength={6} maxLength={500} placeholder="Internal approval or license reference" required /></label>
        <label className="field full check-field"><input type="checkbox" checked={authorizationConfirmed} onChange={(event) => setAuthorizationConfirmed(event.target.checked)} required /><span>I confirm the selected source is approved for this collection and resale/processing use, and that its terms, applicable law, permitted fields, and retention/opt-out obligations have been reviewed.</span></label>
        <div className="field full"><button className="primary-button" disabled={busy || loading || !workerConfigured || !approvedSources.length}>{busy ? "Dispatching…" : "Start collection run"}</button></div>
      </form>
      <p className="muted small">This attestation does not replace legal/source review. The worker must enforce source-specific caps and stop on access blocks. Eligible candidates are ingested through the authenticated callback; contacts remain encrypted, and contact availability is not consent to market.</p>
    </section>
    <section className="panel"><div className="panel-header"><div><h2>Worker boundaries</h2><p>Collection remains isolated from lead delivery.</p></div></div><ul className="check-list"><li>Run ID and progress are written to the existing collection-run history.</li><li>Only the configured worker URL receives a job when an authorized manager starts one.</li><li>No enrichment or skip-tracing is dispatched.</li><li>CSV artifacts are private; completed manifests download through this manager-only page and must pass LeadForge preview/import.</li><li>Run eligibility and source approval must be rechecked before any repeat execution.</li></ul></section></div>
    {holds.length > 0 && <section className="panel"><div className="panel-header"><div><h2>Ambiguous candidates · {holds.length}</h2><p>Held out of agent batches because the owner-posted signal was insufficient or unclear. No seller contact details are stored here.</p></div></div><div className="table-wrap"><table><thead><tr><th>Candidate</th><th>Market</th><th>Reason / evidence</th><th>Source</th><th>Action</th></tr></thead><tbody>{holds.map((hold) => <tr key={hold.id}><td>{hold.title}<small>Run {hold.run_id.slice(0, 8)}</small></td><td>{hold.city}, {hold.country_code}</td><td>{hold.reason_code}<small>{hold.evidence_codes.join(", ")}</small></td><td><a href={hold.listing_url} target="_blank" rel="noreferrer">Open original listing</a></td><td><button className="secondary-button small" onClick={() => void dismissHold(hold)}>Dismiss</button></td></tr>)}</tbody></table></div></section>}
    <section className="panel"><div className="panel-header"><div><h2>Recent collection runs</h2><p>Stored run records and callback results, not proof of current website availability.</p></div></div>
      {loading ? <div className="workspace-state">Loading run history…</div> : runs.length === 0 ? <div className="workspace-state compact"><h3>No scraper runs recorded</h3><p>Run records appear only after an authorized scheduler or manager dispatches a worker.</p></div> : <div className="table-wrap"><table><thead><tr><th>Run ID</th><th>Status</th><th>Source / market</th><th>Progress</th><th>Counts</th><th>Started</th><th>Result</th></tr></thead><tbody>{runs.map((run) => { const cfg = run.worker_configuration ?? {}; const progress = run.worker_progress ?? {}; const artifactAvailable = Boolean(run.worker_artifact_name && ["completed", "degraded"].includes(run.status)); return <tr key={run.id}><td><code>{run.id.slice(0, 8)}</code></td><td><StatusPill tone={run.status === "completed" ? "green" : ["failed", "degraded"].includes(run.status) ? "amber" : "blue"}>{run.status}</StatusPill></td><td>{String(cfg.sourceName ?? run.source_id)}<small>{String(cfg.city ?? "")}, {String(cfg.countryCode ?? "")}</small></td><td>{String(progress.stage ?? "—")}<small>{String(progress.message ?? "")}</small></td><td>{run.discovered_count} found · {run.imported_count} imported · {run.duplicate_count} duplicates · {run.rejected_count} rejected · {run.held_count} held</td><td>{new Date(run.started_at).toLocaleString()}</td><td>{run.error_message && <small>{run.error_message}</small>}{artifactAvailable ? <><a className="secondary-button small" href={`/api/scraper-runs/${run.id}/artifact`}>{run.status === "degraded" ? "Download partial manifest" : "Download manifest"}</a><small>Manager-only run artifact for diagnostics; accepted leads are automatically ingested.</small></> : !run.error_message && run.completed_at ? new Date(run.completed_at).toLocaleString() : !run.error_message ? "Running" : null}</td></tr>; })}</tbody></table></div>}
    </section>
  </>;
}
