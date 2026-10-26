"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { StatusPill } from "@/components/dashboard-shell";

type ProspectStatus = "new" | "reviewed" | "contacted" | "qualified" | "archived";
type Prospect = {
  id: string;
  name: string;
  business_type: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  osm_url: string;
  search_area: string;
  status: ProspectStatus;
  notes: string | null;
  discovered_at: string;
  emailOptedOut?: boolean;
  lastEmailStatus?: string | null;
  lastEmailedAt?: string | null;
};
type ProspectReply = {
  id: string;
  prospect_id: string;
  sender_email: string;
  subject: string;
  message: string;
  status: "received" | "drafted" | "sending" | "sent" | "failed";
  ai_draft: string | null;
  reply_body: string | null;
  received_at: string;
  replied_at: string | null;
};

const stages: { value: ProspectStatus; label: string; tone: "green" | "amber" | "purple" | "blue" | "neutral" }[] = [
  { value: "new", label: "New", tone: "blue" },
  { value: "reviewed", label: "Reviewed", tone: "neutral" },
  { value: "contacted", label: "Contacted", tone: "amber" },
  { value: "qualified", label: "Qualified", tone: "green" },
  { value: "archived", label: "Archived", tone: "neutral" },
];

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return body.error ?? `Request failed (${response.status})`;
}

export function BusinessProspectWorkspace() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [replies, setReplies] = useState<ProspectReply[]>([]);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [reviewedReplies, setReviewedReplies] = useState<Record<string, boolean>>({});
  const [replyBusyId, setReplyBusyId] = useState<string | null>(null);
  const [replyError, setReplyError] = useState("");
  const [area, setArea] = useState("");
  const [category, setCategory] = useState("agents");
  const [radiusKm, setRadiusKm] = useState("10");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [emailProspect, setEmailProspect] = useState<Prospect | null>(null);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [emailReviewed, setEmailReviewed] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/business-prospects", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setProspects(body.data as Prospect[]);
      const repliesResponse = await fetch("/api/business-prospect-replies", { cache: "no-store" });
      if (repliesResponse.ok) {
        const repliesBody = await repliesResponse.json();
        const nextReplies = repliesBody.data as ProspectReply[];
        setReplies(nextReplies);
        setReplyDrafts((current) => Object.fromEntries(nextReplies.map((reply) => [
          reply.id,
          current[reply.id] ?? reply.reply_body ?? reply.ai_draft ?? "",
        ])));
        setReplyError("");
      } else {
        setReplyError(await responseError(repliesResponse));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load business prospects.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function discover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearching(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/business-prospects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, category, radiusKm: Number(radiusKm) }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setNotice(`Found ${body.search.found} businesses near ${body.search.area}. Results are saved in this workspace.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Business discovery failed.");
    } finally {
      setSearching(false);
    }
  }

  async function updateProspect(prospect: Prospect, update: { status?: ProspectStatus; notes?: string | null }) {
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/business-prospects/${prospect.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setProspects((current) => current.map((item) => item.id === prospect.id ? { ...item, ...body.data } : item));
      if (update.notes !== undefined) {
        setNotesDraft((current) => {
          const next = { ...current };
          delete next[prospect.id];
          return next;
        });
      }
      setNotice("Prospect updated.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update prospect.");
    }
  }

  function openEmailComposer(prospect: Prospect) {
    const businessType = prospect.business_type.toLocaleLowerCase("en");
    setEmailProspect(prospect);
    setEmailSubject(`A real-estate lead opportunity for ${prospect.name}`);
    setEmailMessage(
      `Hello ${prospect.name} team,\n\nI'm reaching out from EstatelQ. We help real-estate professionals discover and review property opportunities, including owner-seller leads when verified information is available.\n\nWould you be open to a brief conversation about whether this could be useful for your ${businessType}?\n\nIf this is not relevant, no reply is needed. You can also use the opt-out link below to stop future business emails from our workspace.\n\nBest,\nEstatelQ`,
    );
    setEmailReviewed(false);
    setError("");
    setNotice("");
  }

  async function sendProspectEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!emailProspect || !emailReviewed) return;
    if (!window.confirm(`Send this individual business introduction to ${emailProspect.email}?`)) return;
    setSendingEmail(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/business-prospects/${emailProspect.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: emailSubject, message: emailMessage, reviewed: true, confirmation: "send" }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setNotice(body.data.replyRouting
        ? `Business introduction sent to ${emailProspect.name}. Replies will appear in this pipeline.`
        : `Business introduction sent to ${emailProspect.name}. Configure RESEND_INBOUND_DOMAIN to collect replies in EstatelQ.`);
      setEmailProspect(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to send business introduction.");
    } finally {
      setSendingEmail(false);
    }
  }

  async function generateReplyDraft(reply: ProspectReply) {
    setReplyBusyId(reply.id);
    setError("");
    setReplyError("");
    try {
      const response = await fetch(`/api/business-prospect-replies/${reply.id}/draft`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setReplyDrafts((current) => ({ ...current, [reply.id]: body.data.draft }));
      setReplies((current) => current.map((item) => item.id === reply.id ? { ...item, ai_draft: body.data.draft, status: "drafted" } : item));
    } catch (reason) {
      setReplyError(reason instanceof Error ? reason.message : "Unable to generate a reply draft.");
    } finally {
      setReplyBusyId(null);
    }
  }

  async function sendProspectReply(reply: ProspectReply) {
    const message = (replyDrafts[reply.id] ?? reply.reply_body ?? reply.ai_draft ?? "").trim();
    if (!message || !reviewedReplies[reply.id]) return;
    if (!window.confirm(`Send this reviewed reply to ${reply.sender_email}?`)) return;
    setReplyBusyId(reply.id);
    setError("");
    setReplyError("");
    try {
      const response = await fetch(`/api/business-prospect-replies/${reply.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, reviewed: true, confirmation: "send" }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setReplies((current) => current.map((item) => item.id === reply.id ? { ...item, status: "sent", reply_body: message } : item));
      setNotice(`Reply sent to ${reply.sender_email}.`);
    } catch (reason) {
      setReplyError(reason instanceof Error ? reason.message : "Unable to send the reply.");
    } finally {
      setReplyBusyId(null);
    }
  }

  const visibleProspects = useMemo(() => prospects.filter((prospect) => filter === "all" || prospect.status === filter), [filter, prospects]);
  const counts = useMemo(() => stages.reduce((result, stage) => {
    result[stage.value] = prospects.filter((prospect) => prospect.status === stage.value).length;
    return result;
  }, {} as Record<ProspectStatus, number>), [prospects]);

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">Workspace / Business prospects</p><h1>Find agent & brokerage prospects</h1><p className="subheading">Search OpenStreetMap business records, then review and organize potential agent, brokerage, and property-management customers.</p></div>
      <button className="secondary-button" onClick={() => void load()} disabled={loading}>Refresh prospects</button>
    </div>
    {error && <div className="workspace-alert error" role="alert">{error}</div>}
    {notice && <div className="workspace-alert success" role="status">{notice}</div>}
    {replyError && <div className="workspace-alert error" role="alert">Reply inbox: {replyError}</div>}

    <section className="panel prospect-search-panel">
      <div className="panel-header"><div><h2>Discover real-estate businesses</h2><p>Search an area and save matching public business records to your organization.</p></div><StatusPill tone="green">OpenStreetMap source</StatusPill></div>
      <form className="prospect-search-form" onSubmit={discover}>
        <label>City, region, or country<input value={area} onChange={(event) => setArea(event.target.value)} required minLength={2} maxLength={120} placeholder="Austin, Texas, United States" /></label>
        <label>Business type<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="agents">Real estate agents</option><option value="brokerages">Brokerages / agencies</option><option value="property_management">Property management companies</option></select></label>
        <label>Search radius<select value={radiusKm} onChange={(event) => setRadiusKm(event.target.value)}><option value="5">5 km</option><option value="10">10 km</option><option value="25">25 km</option><option value="50">50 km</option></select></label>
        <button className="primary-button" disabled={searching}>{searching ? "Searching map data…" : "Discover businesses"}</button>
      </form>
      <p className="prospect-attribution">Map and business data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>. Coverage depends on what has been mapped; records may be incomplete or outdated. Searches are limited to one per workspace every 30 seconds.</p>
    </section>

    <div className="metric-grid prospect-metrics">
      <div className="metric-card"><span className="metric-label">Saved prospects</span><b className="metric-value">{prospects.length}</b><span className="metric-change">Across all searched areas</span></div>
      <div className="metric-card"><span className="metric-label">New</span><b className="metric-value">{counts.new ?? 0}</b><span className="metric-change">Awaiting review</span></div>
      <div className="metric-card"><span className="metric-label">Contacted</span><b className="metric-value">{counts.contacted ?? 0}</b><span className="metric-change">Your team marked contacted</span></div>
      <div className="metric-card"><span className="metric-label">Qualified</span><b className="metric-value">{counts.qualified ?? 0}</b><span className="metric-change">Potential customers</span></div>
    </div>

    <section className="panel prospects-panel">
      <div className="panel-header"><div><h2>Prospect pipeline</h2><p>Business contact details are sourced from OpenStreetMap tags when contributors have added them.</p></div>
        <select className="prospect-filter" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter prospects">
          <option value="all">All stages ({prospects.length})</option>{stages.map((stage) => <option key={stage.value} value={stage.value}>{stage.label} ({counts[stage.value] ?? 0})</option>)}
        </select>
      </div>
      {loading ? <div className="workspace-state">Loading saved business prospects…</div>
        : visibleProspects.length === 0 ? <div className="workspace-state">{prospects.length ? "No prospects in this stage." : "No prospects saved yet. Search an area above to discover real-estate businesses."}</div>
          : <div className="prospect-list">{visibleProspects.map((prospect) => {
            const stage = stages.find((item) => item.value === prospect.status) ?? stages[0];
            return <article className="prospect-card" key={prospect.id}>
              <div className="prospect-card-heading">
                <div><h3>{prospect.name}</h3><p>{prospect.business_type} · {prospect.search_area}</p></div>
                <StatusPill tone={stage.tone}>{stage.label}</StatusPill>
              </div>
              {prospect.address && <p className="prospect-address">{prospect.address}</p>}
              <div className="prospect-contact">
                {prospect.phone && <a href={`tel:${prospect.phone}`}>{prospect.phone}</a>}
                {prospect.email && (prospect.emailOptedOut
                  ? <span>{prospect.email} · opted out</span>
                  : <a href={`mailto:${prospect.email}`}>{prospect.email}</a>)}
                {prospect.website && <a href={prospect.website} target="_blank" rel="noreferrer">Website ↗</a>}
                {!prospect.phone && !prospect.email && !prospect.website && <span>No public contact details listed</span>}
              </div>
              {prospect.email && <div className="prospect-email-actions">
                {prospect.emailOptedOut
                  ? <StatusPill tone="amber">Email opted out</StatusPill>
                  : <button type="button" className="secondary-button small" disabled={prospect.status === "archived"} onClick={() => openEmailComposer(prospect)}>
                    {prospect.lastEmailStatus === "sent" ? "Send follow-up email" : "Compose business email"}
                  </button>}
                {prospect.lastEmailedAt && <small>Last sent {new Date(prospect.lastEmailedAt).toLocaleDateString()}</small>}
              </div>}
              {replies.filter((reply) => reply.prospect_id === prospect.id).map((reply) => (
                <section className="prospect-reply" key={reply.id}>
                  <div className="prospect-reply-heading">
                    <div><b>Reply from {reply.sender_email}</b><small>{new Date(reply.received_at).toLocaleString()} · {reply.subject}</small></div>
                    <StatusPill tone={reply.status === "sent" ? "green" : reply.status === "failed" ? "amber" : "blue"}>{reply.status}</StatusPill>
                  </div>
                  <p className="prospect-reply-message">{reply.message}</p>
                  {reply.status === "sent"
                    ? <p className="prospect-email-hint">Your reviewed reply was sent{reply.replied_at ? ` on ${new Date(reply.replied_at).toLocaleString()}` : ""}.</p>
                    : <div className="prospect-reply-composer">
                      <button type="button" className="secondary-button small" disabled={replyBusyId === reply.id} onClick={() => void generateReplyDraft(reply)}>
                        {replyBusyId === reply.id ? "Working…" : "Generate AI draft"}
                      </button>
                      <label>Reply draft<textarea value={replyDrafts[reply.id] ?? ""} maxLength={4000} rows={5} placeholder="Generate a draft or write a reply for manager review…" onChange={(event) => setReplyDrafts((current) => ({ ...current, [reply.id]: event.target.value }))} /></label>
                      <label className="checkbox-label"><input type="checkbox" checked={reviewedReplies[reply.id] ?? false} onChange={(event) => setReviewedReplies((current) => ({ ...current, [reply.id]: event.target.checked }))} />I reviewed and approve this reply to this sender.</label>
                      <button type="button" className="primary-button" disabled={replyBusyId === reply.id || !reviewedReplies[reply.id] || !(replyDrafts[reply.id] ?? reply.reply_body ?? reply.ai_draft ?? "").trim()} onClick={() => void sendProspectReply(reply)}>
                        {replyBusyId === reply.id ? "Sending…" : "Review & send reply"}
                      </button>
                      <small>Generating a draft sends this email text to OpenAI. Drafts are suggestions only; nothing is sent until a manager edits or approves the text and confirms the send.</small>
                    </div>}
                </section>
              ))}
              <label className="prospect-notes-label">Internal notes<textarea value={notesDraft[prospect.id] ?? prospect.notes ?? ""} maxLength={2000} rows={2} placeholder="Add context, next step, or owner for follow-up…" onChange={(event) => setNotesDraft((current) => ({ ...current, [prospect.id]: event.target.value }))} onBlur={() => {
                const value = (notesDraft[prospect.id] ?? prospect.notes ?? "").trim();
                if (value !== (prospect.notes ?? "")) void updateProspect(prospect, { notes: value || null });
              }} /></label>
              <div className="prospect-card-footer"><a className="text-button" href={prospect.osm_url} target="_blank" rel="noreferrer">View OpenStreetMap record ↗</a>
                <label className="prospect-stage-label">Pipeline stage<select value={prospect.status} onChange={(event) => void updateProspect(prospect, { status: event.target.value as ProspectStatus })}>{stages.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              </div>
            </article>;
          })}</div>}
    </section>
    {emailProspect && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !sendingEmail) setEmailProspect(null);
    }}>
      <section className="panel prospect-email-modal" role="dialog" aria-modal="true" aria-labelledby="prospect-email-title">
        <div className="panel-header"><div><h2 id="prospect-email-title">Email {emailProspect.name}</h2><p>To: {emailProspect.email}. Review and send one individual introduction. This is not a bulk send.</p></div>
          <button type="button" className="secondary-button small" disabled={sendingEmail} onClick={() => setEmailProspect(null)}>Close</button>
        </div>
        <form className="prospect-email-form" onSubmit={sendProspectEmail}>
          <label>Subject<input value={emailSubject} onChange={(event) => setEmailSubject(event.target.value)} required minLength={3} maxLength={180} /></label>
          <label>Message<textarea value={emailMessage} onChange={(event) => setEmailMessage(event.target.value)} required minLength={30} maxLength={4000} rows={12} /></label>
          <p className="prospect-email-hint">The email includes a one-click opt-out. Sending is limited to one message per prospect every 30 days and 20 messages per workspace per day.</p>
          <label className="checkbox-label prospect-review-confirm"><input type="checkbox" checked={emailReviewed} onChange={(event) => setEmailReviewed(event.target.checked)} required />I reviewed this recipient and message and confirm this is an appropriate individual business introduction.</label>
          <div className="prospect-email-buttons"><button type="button" className="secondary-button" disabled={sendingEmail} onClick={() => setEmailProspect(null)}>Cancel</button><button className="primary-button" disabled={sendingEmail || !emailReviewed}>{sendingEmail ? "Sending…" : "Review & send email"}</button></div>
        </form>
      </section>
    </div>}
  </>;
}
