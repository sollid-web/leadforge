"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusPill } from "@/components/dashboard-shell";

type Approval = {
  id: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  message: string | null;
  matches: {
    score: number;
    listings: { title: string; summary: string; city: string; area: string; property_type: string } | null;
  } | null;
};

async function readError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return body.error ?? `Request failed (${response.status})`;
}

export function ApprovalQueue() {
  const [requests, setRequests] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/interest-requests");
      if (!response.ok) throw new Error(await readError(response));
      const body = await response.json();
      setRequests(body.data as Approval[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function decide(item: Approval, decision: "approved" | "rejected") {
    const reason = window.prompt(`Required review reason for ${decision}:`)?.trim();
    if (!reason) return;
    setError("");
    setNotice("");
    const response = await fetch(`/api/interest-requests/${item.id}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason }),
    });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    setNotice(decision === "approved" ? "Interest approved. The matched agent can now request the details." : "Interest declined. Private details remain locked.");
    await load();
  }

  return <><div className="page-heading"><div><p className="eyebrow">Workspace / Approvals</p><h1>Interest review</h1><p className="subheading">Review an agent&apos;s explicit request before allowing the matched agent to retrieve private listing details.</p></div><button className="secondary-button" onClick={() => void load()}>Refresh queue</button></div>
    <div className="notice-banner"><span>✓</span><div><b>Approval is an access gate, not an outreach send.</b><p>Approving enables the requesting agent to retrieve encrypted property details. No owner message is automatically sent.</p></div></div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}{notice && <div className="workspace-alert success" role="status">{notice}</div>}
    <section className="panel approval-queue">{loading ? <div className="workspace-state">Loading interest requests…</div> : requests.length === 0 ? <div className="workspace-state"><h2>No requests to review</h2><p>Agent requests appear here after opportunities are matched and an agent asks for details.</p></div> : requests.map((item) => {
      const listing = item.matches?.listings;
      return <article className="approval-item" key={item.id}><div className="approval-item-main"><div className="approval-item-heading"><h2>{listing?.title ?? "Property opportunity"}</h2><StatusPill tone={item.status === "pending" ? "amber" : item.status === "approved" ? "green" : "neutral"}>{item.status}</StatusPill></div><p>{listing?.summary ?? "Summary unavailable"} · {listing?.property_type ?? "Property"} · Match fit {item.matches?.score ?? 0}/100</p><small>Requested {new Date(item.requested_at).toLocaleString()}</small>{item.message && <blockquote>{item.message}</blockquote>}</div>{item.status === "pending" && <div className="approval-item-actions"><button className="secondary-button small" onClick={() => void decide(item, "rejected")}>Decline</button><button className="primary-button small" onClick={() => void decide(item, "approved")}>Approve details access</button></div>}</article>;
    })}</section>
  </>;
}
