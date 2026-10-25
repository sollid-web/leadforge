"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { StatusPill } from "@/components/dashboard-shell";

type Source = {
  id: string;
  name: string;
  source_type: string;
  source_url: string | null;
  approved: boolean;
  active: boolean;
  source_health: { status: "healthy" | "degraded" | "failed" | "unknown"; last_checked_at: string | null; last_success_at: string | null; consecutive_failures: number; message: string | null } | null;
};

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return body.error ?? `Request failed (${response.status})`;
}

export function WorkspaceSettings() {
  const [organizations, setOrganizations] = useState<{ organization_id: string; role: string; organizations: { name: string } | null }[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [userId, setUserId] = useState("");
  const [integrations, setIntegrations] = useState<Record<string, boolean>>({});
  const [hasAgentProfile, setHasAgentProfile] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [savingEmailPreference, setSavingEmailPreference] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const statusResponse = await fetch("/api/setup-status");
      const status = await statusResponse.json();
      setIntegrations(status.integrations ?? {});
      const organizationResponse = await fetch("/api/organizations");
      if (!organizationResponse.ok) throw new Error(await responseError(organizationResponse));
      const organizationBody = await organizationResponse.json();
      const memberRows = organizationBody.data as typeof organizations;
      setOrganizations(memberRows);
      const sourceResponse = await fetch("/api/sources");
      if (sourceResponse.ok) {
        const sourceBody = await sourceResponse.json();
        setSources(sourceBody.data as Source[]);
      } else if (sourceResponse.status !== 403) {
        throw new Error(await responseError(sourceResponse));
      }
      const supabase = getSupabaseBrowserClient();
      let currentUserId = "";
      if (supabase) {
        const { data: { user } } = await supabase.auth.getUser();
        currentUserId = user?.id ?? "";
        setUserId(currentUserId);
      }
      if (!memberRows.length || !currentUserId) {
        setHasAgentProfile(false);
        setNotifyEmail(false);
      } else {
        const preferenceResponse = await fetch("/api/agents/preferences");
        if (preferenceResponse.status === 404) {
          setHasAgentProfile(false);
          setNotifyEmail(false);
        } else {
          if (!preferenceResponse.ok) throw new Error(await responseError(preferenceResponse));
          const preferenceBody = await preferenceResponse.json();
          setHasAgentProfile(true);
          setNotifyEmail(Boolean(preferenceBody.data.notifyEmail));
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load workspace settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submitJson(url: string, payload: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(await responseError(response));
    return response.json();
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setError("");
    try {
      await submitJson("/api/organizations", { name: values.get("organizationName") });
      setNotice("Organization created. Add your agent profile and approved sources to begin.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create organization."); }
  }

  async function createSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setError("");
    try {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
        name: values.get("name"),
        sourceType: values.get("sourceType"),
        sourceUrl: values.get("sourceUrl") || undefined,
        optOutInstructions: values.get("optOutInstructions") || undefined,
        }),
      });
      const result = await response.json();
      setNewToken(typeof result.ingestionToken === "string" ? result.ingestionToken : "");
      if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
      setNotice("Source recorded. Non-manual sources remain inactive until an owner or admin approves them.");
      form.reset();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create source."); }
  }

  async function decideSource(source: Source, approved: boolean) {
    const reason = window.prompt(approved ? "Approval reason (source permission checked):" : "Reason for disabling this source:");
    if (!reason?.trim()) return;
    try {
      await submitJson(`/api/sources/${source.id}/approval`, { approved, active: approved, reason });
      setNotice(approved ? "Source approved and enabled." : "Source disabled.");
      await load();
    } catch (reasonError) { setError(reasonError instanceof Error ? reasonError.message : "Unable to update source."); }
  }

  async function copySourceToken() {
    try {
      await navigator.clipboard.writeText(newToken);
      setNotice("Source token copied. Store it securely; it cannot be retrieved again.");
    } catch {
      setError("Clipboard access was unavailable. Select and copy the token manually.");
    }
  }

  async function createAgentProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await submitJson("/api/agents", {
        userId,
        displayName: values.get("displayName"),
        serviceAreas: String(values.get("serviceAreas") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
        specialties: values.getAll("specialties"),
      });
      setNotice("Agent profile saved. New opportunities can now be matched against your service area and specialties.");
      form.reset();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create agent profile."); }
  }

  async function updateEmailPreference(enabled: boolean) {
    setSavingEmailPreference(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/agents/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifyEmail: enabled }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setNotifyEmail(Boolean(body.data.notifyEmail));
      setNotice(enabled ? "Opportunity summary emails are enabled." : "Opportunity summary emails are disabled.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update email preference.");
    } finally {
      setSavingEmailPreference(false);
    }
  }

  const currentRole = organizations[0]?.role;
  const canApproveSources = currentRole === "owner" || currentRole === "admin";

  return <>
    <div className="page-heading"><div><p className="eyebrow">Workspace / Settings</p><h1>Workspace setup</h1><p className="subheading">Configure your organization, matching profile, and source permissions.</p></div><button className="secondary-button" onClick={() => void load()}>Refresh setup</button></div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}{notice && <div className="workspace-alert success" role="status">{notice}</div>}
    <div className="settings-layout">
      <aside className="settings-nav"><a className="settings-active" href="#organization">Organization</a><a href="#agent-profile">Agent profile</a><a href="#notifications">Email notifications</a><a href="#sources">Approved sources</a><a href="#integrations">Integrations</a></aside>
      <div className="settings-content">
        <section className="panel settings-card" id="organization"><div className="panel-header"><div><h2>Organization</h2><p>A tenant boundary for listings, agents, and approval records.</p></div></div>
          {loading ? <p>Loading organization state…</p> : organizations.length ? organizations.map((item) => <div className="connection-row" key={item.organization_id}><span className="workspace-avatar">LF</span><div><b>{item.organizations?.name ?? "Organization"}</b><small>Role: {item.role}</small></div><StatusPill tone="green">Active membership</StatusPill></div>) : <><p>No organization membership is linked to this account yet.</p><form className="inline-form" onSubmit={createOrganization}><label>Organization name<input name="organizationName" required minLength={2} maxLength={120} placeholder="Your agency or team" /></label><button className="primary-button">Create organization</button></form></>}
        </section>
        <section className="panel settings-card" id="agent-profile"><div className="panel-header"><div><h2>Agent matching profile</h2><p>Only service areas and property specialties are used for matching.</p></div></div>
          {organizations.length ? userId ? <form className="settings-form" onSubmit={createAgentProfile}><label>Display name<input name="displayName" required minLength={2} maxLength={120} placeholder="Your name" /></label><label>Service areas<input name="serviceAreas" required placeholder="Westlands, Nairobi, Kiambu" /><small>Separate locations with commas; match is exact city or region.</small></label><fieldset><legend>Property specialties</legend>{["house", "apartment", "land", "commercial", "other", "all"].map((specialty) => <label className="checkbox-label" key={specialty}><input type="checkbox" name="specialties" value={specialty} />{specialty}</label>)}</fieldset><button className="primary-button">Save my agent profile</button></form> : <p>Sign in to configure your agent profile.</p> : <p>Create or join an organization before setting up an agent profile.</p>}
        </section>
        <section className="panel settings-card" id="notifications"><div className="panel-header"><div><h2>Opportunity email notifications</h2><p>Optional summary emails for matches, sent only after a manager manually confirms each message.</p></div></div>
          {hasAgentProfile ? <label className="checkbox-label"><input type="checkbox" checked={notifyEmail} disabled={savingEmailPreference} onChange={(event) => void updateEmailPreference(event.target.checked)} />Allow managers to email me summary-only opportunity matches</label> : <p>Create an agent profile to manage this preference. Email is off by default.</p>}
          <small>Messages never include owner contact information or full property details. You can turn off notifications here at any time.</small>
        </section>
        <section className="panel settings-card" id="sources"><div className="panel-header"><div><h2>Approved listing sources</h2><p>Only manually entered records or explicitly approved feeds can be ingested. LeadForge does not scrape arbitrary sites.</p></div></div>
          {organizations.length > 0 && <form className="settings-form" onSubmit={createSource}><label>Source name<input name="name" required minLength={2} maxLength={120} placeholder="Partner feed / Manual entry" /></label><label>Source type<select name="sourceType"><option value="manual">Manual entry</option><option value="approved_feed">Approved public feed</option><option value="partner_feed">Partner feed</option><option value="public_api">Public API</option></select></label><label>Source URL (HTTPS)<input name="sourceUrl" type="url" placeholder="https://source.example" /></label><label>Opt-out / compliance instructions<input name="optOutInstructions" maxLength={1000} placeholder="How to honor source-specific restrictions" /></label><button className="primary-button">Register source</button></form>}
          {newToken && <div className="token-reveal"><b>Copy this source token now. It cannot be viewed again.</b><code>{newToken}</code><div className="token-actions"><button className="secondary-button small" onClick={() => void copySourceToken()}>Copy token</button><button className="text-button" onClick={() => setNewToken("")}>Hide token</button></div><small>Store it in your secrets manager and configure it as an Authorization: Bearer token for the ingestion endpoint.</small></div>}
          {sources.length === 0 ? <div className="workspace-state compact">No registered sources yet.</div> : <div className="source-list">{sources.map((source) => <div className="connection-row" key={source.id}><span className="connection-logo supabase">↗</span><div><b>{source.name}</b><small>{source.source_type.replace("_", " ")}{source.source_url ? ` · ${new URL(source.source_url).hostname}` : ""} · {source.source_health?.last_success_at ? `last ingest ${new Date(source.source_health.last_success_at).toLocaleString()}` : "no successful ingestion yet"}{source.source_health?.message ? ` · ${source.source_health.message}` : ""}</small></div><StatusPill tone={source.approved && source.active ? "green" : "amber"}>{source.approved && source.active ? "Approved & active" : "Pending approval"}</StatusPill>{source.approved && source.active && source.source_type !== "manual" && source.source_health && <StatusPill tone={source.source_health.status === "healthy" ? "green" : source.source_health.status === "unknown" ? "neutral" : "amber"}>{source.source_health.status}</StatusPill>}{canApproveSources && source.source_type !== "manual" && <button className="secondary-button small" onClick={() => void decideSource(source, !(source.approved && source.active))}>{source.approved && source.active ? "Disable" : "Approve"}</button>}</div>)}</div>}
        </section>
        <section className="panel settings-card" id="integrations"><div className="panel-header"><div><h2>Runtime configuration</h2><p>Configured environment values do not imply a live provider connection or successful health check.</p></div></div>
          <div className="connection-row"><span className="connection-logo supabase">S</span><div><b>Supabase Auth + Postgres</b><small>Primary data store and authentication provider</small></div><StatusPill tone={integrations.supabase ? "green" : "amber"}>{integrations.supabase ? "Configured" : "Missing"}</StatusPill></div>
          <div className="connection-row"><span className="connection-logo">🔐</span><div><b>Owner-detail encryption key</b><small>A 32-byte base64 key is required before private property or contact details can be stored.</small></div><StatusPill tone={integrations.ownerDataEncryption ? "green" : "amber"}>{integrations.ownerDataEncryption ? "Configured" : "Missing"}</StatusPill></div>
          <div className="connection-row"><span className="connection-logo supabase">↗</span><div><b>Source webhook ingestion</b><small>Source-scoped bearer tokens are validated server-side. Webhook payloads cannot submit private owner details.</small></div><StatusPill tone={integrations.ingestionServiceRole ? "green" : "amber"}>{integrations.ingestionServiceRole ? "Configured" : "Missing service role key"}</StatusPill></div>
          <div className="connection-row"><span className="connection-logo n8n">⌁</span><div><b>n8n workflow template</b><small>Inactive by default. Configure the template with the one-time source token and enable it only for an approved source.</small></div><StatusPill tone="neutral">Template only</StatusPill></div>
        </section>
      </div>
    </div>
  </>;
}
