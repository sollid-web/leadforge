"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { canonicalOwnerScraperSourceKey, ownerScraperCitiesForSource } from "@/lib/owner-scraper-sources";

type Source = {
  id: string;
  name: string;
  source_key: string;
  source_type: string;
  source_url: string | null;
  approved: boolean;
  active: boolean;
};

type Policy = {
  id: string;
  city: string;
  country_code: string;
  result_limit: number;
  cadence_hours: number;
  authorization_scope: string;
  authorization_expires_at: string;
  authorization_reference_present: boolean;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
};

const cities = ["Miami", "Fort Lauderdale", "West Palm Beach", "Broward", "Boca Raton", "Hialeah", "Palm Beach"];
async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
}

function defaultExpiry() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function OwnerDiscoveryControls() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [city, setCity] = useState(cities[0]);
  const [resultLimit, setResultLimit] = useState(20);
  const [cadenceHours, setCadenceHours] = useState(24);
  const [authorizationReference, setAuthorizationReference] = useState("");
  const [authorizationScope, setAuthorizationScope] = useState("");
  const [authorizationExpiresAt, setAuthorizationExpiresAt] = useState(defaultExpiry);
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadPolicies = useCallback(async (id: string) => {
    if (!id) {
      setPolicies([]);
      return;
    }
    const response = await fetch(`/api/sources/${id}/owner-discovery`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const body = await response.json();
    setPolicies(body.data as Policy[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/sources", { cache: "no-store" });
        if (!response.ok) throw new Error(await responseError(response));
        const body = await response.json();
        if (body.canManage !== true) {
          if (!cancelled) setAccessDenied(true);
          return;
        }
        const eligible = (body.data as Source[]).filter((source) => source.approved && source.active && ["craigslist", "forsalebyowner", "byowner"].includes(canonicalOwnerScraperSourceKey(source.source_key)));
        if (cancelled) return;
        setSources(eligible);
        const firstId = eligible[0]?.id ?? "";
        setSourceId(firstId);
        if (firstId) await loadPolicies(firstId);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load authorized sources.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadPolicies]);

  async function changeSource(value: string) {
    setSourceId(value);
    const supported = ownerScraperCitiesForSource(canonicalOwnerScraperSourceKey(sources.find((source) => source.id === value)?.source_key ?? ""));
    setCity(supported[0] ?? cities[0]);
    setError("");
    try {
      await loadPolicies(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load this source's policy.");
    }
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceId) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/sources/${sourceId}/owner-discovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          authorizationConfirmed,
          city,
          countryCode: "US",
          resultLimit,
          cadenceHours,
          authorizationReference,
          authorizationScope,
          authorizationExpiresAt: new Date(authorizationExpiresAt).toISOString(),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setNotice(body.note ?? "Owner-discovery schedule saved.");
      setAuthorizationConfirmed(false);
      await loadPolicies(sourceId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save owner-discovery policy.");
    } finally {
      setSaving(false);
    }
  }

  async function disablePolicies() {
    if (!sourceId) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/sources/${sourceId}/owner-discovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setNotice(body.note ?? "Scheduled discovery disabled.");
      await loadPolicies(sourceId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to disable owner-discovery policy.");
    } finally {
      setSaving(false);
    }
  }

  const hasEnabled = policies.some((policy) => policy.enabled);
  const availableCities = ownerScraperCitiesForSource(canonicalOwnerScraperSourceKey(sources.find((source) => source.id === sourceId)?.source_key ?? ""));
  if (accessDenied) return null;
  return <section className="panel owner-discovery-panel">
    <div className="panel-header"><div><p className="eyebrow">Automated discovery</p><h2>Owner-seller scraper schedule</h2><p>Authorized schedules discover owner-listed sale leads, encrypt candidate contacts, and queue them for human ownership verification. This does not send agent messages or expose unverified leads to agents.</p></div></div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}
    {notice && <div className="workspace-alert success" role="status">{notice}</div>}
    {loading ? <div className="workspace-state"><span className="loading-indicator" />Loading built-in scraper sources…</div> : sources.length === 0
      ? <p className="form-hint">No built-in owner-scraper sources are available yet. Apply migration 202610290001_builtin_owner_scraper_sources.sql to this Supabase project, then refresh. After that, a manager only needs to record the authorized source/city scope, evidence reference, and expiry here before scheduled collection.</p>
      : <>
        <div className="listing-filter-grid">
          <label>Built-in source<select value={sourceId} onChange={(event) => void changeSource(event.target.value)}>{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
          <label>City / service area<select value={availableCities.includes(city) ? city : availableCities[0]} onChange={(event) => setCity(event.target.value)}>{availableCities.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        </div>
        <form className="opportunity-form" onSubmit={(event) => void savePolicy(event)}>
          <label>Maximum results per run<input type="number" min={1} max={50} value={resultLimit} onChange={(event) => setResultLimit(Number(event.target.value))} required /></label>
          <label>Run cadence (hours)<input type="number" min={24} max={168} value={cadenceHours} onChange={(event) => setCadenceHours(Number(event.target.value))} required /><small>Minimum 24 hours per source/city policy.</small></label>
          <label>Authorization evidence reference<input value={authorizationReference} onChange={(event) => setAuthorizationReference(event.target.value)} minLength={3} maxLength={500} required placeholder="Agreement, permission ticket, or terms record ID" /></label>
          <label>Authorization expiry<input type="datetime-local" value={authorizationExpiresAt} onChange={(event) => setAuthorizationExpiresAt(event.target.value)} required /></label>
          <label className="form-span">Exact authorized collection scope<textarea value={authorizationScope} onChange={(event) => setAuthorizationScope(event.target.value)} minLength={10} maxLength={2000} required rows={3} placeholder="Describe the permitted site, owner-posted sale data, contact fields, city, purpose, retention, and any conditions." /></label>
          <label className="checkbox-label form-span"><input type="checkbox" checked={authorizationConfirmed} onChange={(event) => setAuthorizationConfirmed(event.target.checked)} required />I confirm this organization is authorized to collect and retain the described public owner-sale listing and seller-contact data on this source and schedule. This does not authorize bypassing access controls, login restrictions, CAPTCHAs, or robots rules.</label>
          <div className="form-actions form-span"><button className="primary-button" disabled={saving || !authorizationConfirmed}>{saving ? "Saving schedule…" : "Enable authorized schedule"}</button>{hasEnabled && <button className="secondary-button" type="button" onClick={() => void disablePolicies()} disabled={saving}>Pause all schedules for this source</button>}</div>
        </form>
        {policies.length > 0 && <div className="table-scroll"><table><thead><tr><th>City</th><th>Status</th><th>Next run</th><th>Last result</th><th>Expiry</th></tr></thead><tbody>{policies.map((policy) => <tr key={policy.id}><td>{policy.city}</td><td>{policy.enabled ? "Enabled" : "Paused"}</td><td>{policy.enabled && policy.next_run_at ? new Date(policy.next_run_at).toLocaleString() : "—"}</td><td>{policy.last_run_status ?? "Not run"}{policy.last_run_error ? <small>{policy.last_run_error}</small> : null}</td><td>{new Date(policy.authorization_expires_at).toLocaleDateString()}</td></tr>)}</tbody></table></div>}
      </>}
  </section>;
}
