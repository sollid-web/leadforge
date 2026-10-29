"use client";

import { useCallback, useEffect, useState } from "react";

type Draft = {
  id: string;
  channel: string;
  message: string;
  created_at: string;
  listing: { title: string; city: string; region: string | null; country_code: string; property_type: string } | null;
  agent: { name: string; agency: string | null; city: string; country_code: string; preferred_channel: string; status: string } | null;
};

async function apiError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
}

export function TrialOutreachDrafts() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/trial-outreach-drafts", { cache: "no-store" });
      if (!response.ok) throw new Error(await apiError(response));
      const body = await response.json();
      setDrafts((body.data ?? []) as Draft[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load trial drafts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function copyDraft(draft: Draft) {
    try {
      await navigator.clipboard.writeText(draft.message);
      setNotice("Draft copied. Review and personalize it before sending through an authorized channel.");
    } catch {
      setError("Clipboard access is unavailable. Select and copy the draft text manually.");
    }
  }

  async function dismissDraft(draft: Draft) {
    setBusyId(draft.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/trial-outreach-drafts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.id, action: "dismiss" }),
      });
      if (!response.ok) throw new Error(await apiError(response));
      setDrafts((current) => current.filter((item) => item.id !== draft.id));
      setNotice("Trial outreach draft dismissed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to dismiss this draft.");
    } finally {
      setBusyId("");
    }
  }

  return <section className="panel" aria-labelledby="trial-outreach-heading">
    <div className="panel-header">
      <div><p className="eyebrow">Human-reviewed outreach preparation</p><h2 id="trial-outreach-heading">One-lead trial drafts</h2><p>Created after a manager verifies an owner. These drafts do not send messages, reveal seller contacts, grant access, or approve a business offer.</p></div>
      <button className="secondary-button small" onClick={() => void load()} disabled={loading}>Refresh</button>
    </div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}
    {notice && <div className="workspace-alert success" role="status">{notice}</div>}
    {loading ? <div className="workspace-state">Loading trial drafts…</div> : drafts.length === 0
      ? <div className="workspace-state compact"><h3>No pending trial drafts</h3><p>After an owner-seller lead is verified, LeadForge prepares drafts for reviewed, market-compatible agent prospects who have not opted out and have not used their linked one-lead trial.</p></div>
      : <div className="table-wrap"><table><thead><tr><th>Agent prospect</th><th>Verified lead</th><th>Channel</th><th>Draft message</th><th>Actions</th></tr></thead><tbody>{drafts.map((draft) => <tr key={draft.id}>
        <td>{draft.agent?.name ?? "Agent"}<small>{draft.agent?.agency ?? ""} · {draft.agent?.city}, {draft.agent?.country_code}</small></td>
        <td>{draft.listing?.title ?? "Verified owner lead"}<small>{draft.listing?.property_type} · {draft.listing?.city}, {draft.listing?.country_code}</small></td>
        <td>{draft.channel}</td>
        <td><pre style={{ whiteSpace: "pre-wrap", font: "inherit", minWidth: 280, margin: 0 }}>{draft.message}</pre></td>
        <td><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="primary-button small" onClick={() => void copyDraft(draft)}>Copy draft</button><button className="secondary-button small" onClick={() => void dismissDraft(draft)} disabled={busyId === draft.id}>{busyId === draft.id ? "Dismissing…" : "Dismiss"}</button></div></td>
      </tr>)}</tbody></table></div>}
  </section>;
}
