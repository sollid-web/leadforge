"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ScoreBadge, StatusPill } from "@/components/dashboard-shell";

type Opportunity = {
  id: string;
  title: string;
  summary: string;
  property_type: string;
  area: string;
  city: string;
  region: string | null;
  country_code: string;
  price: number | null;
  currency: string;
  owner_led_claim: boolean;
  owners: { verification_status: string } | null;
  status: string;
  created_at: string;
  score: { score: number; trust_score: number; factors: { label: string; evidence: string; score: number }[] } | null;
};

type Match = {
  id: string;
  listing_id: string;
  score: number;
  status: string;
  listing: Pick<Opportunity, "id" | "title" | "summary" | "property_type" | "area" | "city" | "price" | "currency"> | null;
  interest: { id: string; status: string } | null;
};

type MatchSuggestion = { id: string; agent_id: string; display_name: string; score: number; reasons: string[] };
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
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      const [listingResponse, matchResponse] = await Promise.all([fetch("/api/listings"), fetch("/api/matches")]);
      if (!listingResponse.ok) throw new Error(await getError(listingResponse));
      if (!matchResponse.ok) throw new Error(await getError(matchResponse));
      const [listingBody, matchBody] = await Promise.all([listingResponse.json(), matchResponse.json()]);
      setOpportunities(listingBody.data as Opportunity[]);
      setMatches(matchBody.data as Match[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load opportunities.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
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
    const payload = {
      sourceName: "Manual entry",
      sourceType: "manual",
      title: values.get("title"),
      description: values.get("description"),
      propertyType: values.get("propertyType"),
      area: values.get("area"),
      city: values.get("city"),
      region: values.get("region") || undefined,
      countryCode: values.get("countryCode"),
      price: numericPrice ? Number(numericPrice) : undefined,
      currency: values.get("currency"),
      ownerLedClaim: values.get("ownerLedClaim") === "on",
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
    const reason = window.prompt("Brief verification rationale:")?.trim();
    if (!reason) return;
    setError("");
    try {
      const response = await fetch(`/api/listings/${item.id}/verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "verified", evidenceReference, reason }),
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
        <div>        <p className="eyebrow">Workspace / Opportunities</p><h1>Property opportunities</h1><p className="subheading">Review normalized source records and unverified owner-listed claims, then route a privacy-safe summary to a suitable agent.</p></div>
        <button className="primary-button" onClick={() => setFormOpen((open) => !open)}>{formOpen ? "Close form" : "+ Add opportunity"}</button>
      </div>

      <div className="notice-banner"><span>◎</span><div><b>Private details stay locked.</b><p>Agents first receive a location-level summary. Property or owner details are revealed only after agent interest and an explicit workspace approval.</p></div></div>
      {error && <div className="workspace-alert error" role="alert">{error}</div>}
      {notice && <div className="workspace-alert success" role="status">{notice}</div>}

      {formOpen && <section className="panel opportunity-form-panel">
        <div className="panel-header"><div><h2>Record a property opportunity</h2><p>Use only sources your organization is permitted to process.</p></div></div>
        <form className="opportunity-form" onSubmit={createOpportunity}>
          <label>Listing title<input name="title" required minLength={3} maxLength={200} placeholder="Detached home near the park" /></label>
          <label>Property type<select name="propertyType" required><option value="house">House</option><option value="apartment">Apartment</option><option value="land">Land</option><option value="commercial">Commercial</option><option value="other">Other</option></select></label>
          <label>Area / neighborhood<input name="area" required maxLength={120} /></label>
          <label>City<input name="city" required maxLength={120} /></label>
          <label>Region / state<input name="region" maxLength={120} /></label>
          <label>Country code<input name="countryCode" required minLength={2} maxLength={2} defaultValue="US" /></label>
          <label>Asking price<input name="price" type="number" min="0.01" step="any" /></label>
          <label>Currency<input name="currency" minLength={3} maxLength={3} defaultValue="USD" /></label>
          <label className="form-span">Description<textarea name="description" rows={3} maxLength={4000} /></label>
          <label className="checkbox-label form-span"><input type="checkbox" name="ownerLedClaim" /> Source indicates owner-listed (unverified until review)</label>
          <details className="private-fields form-span"><summary>Optional private details (encrypted at rest, not included in summaries)</summary><div className="private-fields-grid">
            <label>Full address<input name="address" maxLength={500} autoComplete="off" /></label>
            <label>Owner name<input name="ownerName" maxLength={200} autoComplete="off" /></label>
            <label>Owner email<input name="ownerEmail" type="email" maxLength={254} autoComplete="off" /></label>
            <label>Owner phone<input name="ownerPhone" type="tel" maxLength={40} autoComplete="off" /></label>
          </div><small>Requires OWNER_DATA_ENCRYPTION_KEY. Contact permission starts unknown. Private contacts are not used for automated messages.</small></details>
          <div className="form-actions form-span"><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save opportunity"}</button></div>
        </form>
      </section>}

      <section className="panel table-panel opportunity-table-panel">
        <div className="table-toolbar">
          <div className="search-field"><span>⌕</span><input aria-label="Search opportunities" placeholder="Search by title, area, or city" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <select className="filter-button" aria-label="Filter by status" value={stage} onChange={(event) => setStage(event.target.value)}><option value="all">All statuses</option><option value="new">New</option><option value="review">Review</option><option value="matched">Matched</option><option value="closed">Closed</option></select>
          <button className="secondary-button small" onClick={() => void load()}>Refresh</button>
        </div>
        <div className="table-meta"><span><b>{visibleOpportunities.length}</b> {visibleOpportunities.length === 1 ? "opportunity" : "opportunities"}</span><span>Workspace records · no sample data</span></div>
        {loading ? <div className="workspace-state"><span className="loading-indicator" />Loading organization opportunities…</div>
          : visibleOpportunities.length === 0 ? <div className="workspace-state"><h2>{opportunities.length ? "No opportunities match these filters" : "Your opportunity queue is empty"}</h2><p>{opportunities.length ? "Try a different search or status." : "Add a property record from a permitted source to start scoring and matching."}</p>{!opportunities.length && <button className="primary-button" onClick={() => setFormOpen(true)}>Add your first opportunity</button>}</div>
            : <div className="table-scroll"><table><thead><tr><th>Opportunity</th><th>Location</th><th>Signal</th><th>Score</th><th>Status</th><th>Added</th><th>Actions</th></tr></thead><tbody>
              {visibleOpportunities.map((item) => <tr key={item.id}>
                <td><div className="opportunity-title"><b>{item.title}</b><small>{item.property_type.replace("_", " ")}</small></div></td>
                <td><b>{item.area}</b><small>{item.city}{item.region ? `, ${item.region}` : ""} · {item.country_code}</small></td>
                <td>{item.owner_led_claim ? <StatusPill tone={item.owners?.verification_status === "verified" ? "green" : "amber"}>{item.owners?.verification_status === "verified" ? "Owner claim verified" : "Owner claim · unverified"}</StatusPill> : <span className="muted-cell">No owner claim</span>}</td>
                <td>{item.score ? <><ScoreBadge score={item.score.score} /><small className="score-label">Trust {item.score.trust_score}/100</small></> : <span className="muted-cell">Not scored</span>}</td>
                <td><StatusPill tone={item.status === "matched" ? "green" : item.status === "review" ? "purple" : "blue"}>{item.status}</StatusPill></td>
                <td className="muted-cell">{new Date(item.created_at).toLocaleDateString()}</td>
                <td><div className="table-row-actions">{item.owner_led_claim && item.owners?.verification_status !== "verified" && <button className="secondary-button small" onClick={() => void verifyOwnerClaim(item)}>Verify</button>}<button className="secondary-button small" onClick={() => void calculateMatches(item.id)}>Match</button><button className="secondary-button small" onClick={() => void openContactOutreach(item)}>Contact</button><button className="secondary-button small" onClick={() => void suppressOpportunity(item.id)} aria-label={`Suppress ${item.title}`}>Suppress</button></div></td>
              </tr>)}
            </tbody></table></div>}
      </section>

      {Object.entries(suggestions).map(([listingId, items]) => <section className="panel match-panel" key={listingId}><div className="panel-header"><div><h2>Agent match results</h2><p>Email only goes to agents who opted in. The message contains summary fields only and requires this manual send action.</p></div></div>
        {items.length ? <div className="match-suggestion-list">{items.map((item) => <div className="match-suggestion" key={item.agent_id}><div><b>{item.display_name}</b><small>{item.reasons.join(" · ")}</small></div><ScoreBadge score={item.score} /><button className="secondary-button small" disabled={!item.id} onClick={() => void sendAgentEmail(item)}>Send summary email</button></div>)}</div> : <p className="workspace-state">No active agent profile matches this opportunity yet.</p>}
      </section>)}

      {matches.length > 0 && <section className="panel match-panel"><div className="panel-header"><div><h2>Recommended for you</h2><p>Matched summaries only. Request details to enter human review.</p></div></div><div className="match-suggestion-list">
        {matches.map((match) => <div className="agent-match-row" key={match.id}><div className="agent-match-main"><b>{match.listing?.title ?? "Opportunity"}</b><small>{match.listing?.summary} · Match {match.score}/100</small></div>{match.interest?.status === "approved" ? <button className="primary-button small" onClick={() => void revealDetails(match.listing_id)}>View approved details</button> : match.interest ? <StatusPill tone={match.interest.status === "rejected" ? "neutral" : "amber"}>{match.interest.status === "pending" ? "Awaiting review" : match.interest.status}</StatusPill> : <button className="secondary-button small" onClick={() => void requestInterest(match.id)}>Request details</button>}</div>)}
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
