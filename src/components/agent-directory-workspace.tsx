"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { StatusPill } from "@/components/dashboard-shell";
import { parseCsvRecords, type CsvRecord } from "@/lib/listing-csv";

type AgentStatus = "discovered" | "reviewed" | "contacted" | "interested" | "customer" | "inactive" | "opted_out";
type Interaction = { id: string; interaction_type: string; channel: string; summary: string; occurred_at: string; follow_up_at: string | null };
type Agent = {
  id: string;
  name: string;
  agency: string | null;
  country_code: string;
  city: string;
  service_areas: string[];
  preferred_property_types: string[];
  preferred_listing_types: string[];
  preferred_currency: string | null;
  min_lead_volume: number | null;
  max_lead_volume: number | null;
  min_budget: number | null;
  max_budget: number | null;
  preferred_channel: string;
  contact: { name: string; email: string; phone: string } | null;
  source_name: string;
  source_url: string | null;
  linked_user_id: string | null;
  status: AgentStatus;
  notes: string | null;
  follow_up_at: string | null;
  created_at: string;
  updated_at: string;
  interactions: Interaction[];
};
type DeliveryContact = {
  type: string;
  name?: string;
  email?: string;
  phone?: string;
  sourceUrl?: string | null;
  publicationContext?: string | null;
  verificationStatus?: string | null;
  permissionStatus?: string | null;
  collectedAt?: string | null;
  lastVerifiedAt?: string | null;
};
type DeliveredListing = {
  id: string;
  title: string;
  summary: string | null;
  description?: string | null;
  propertyType: string;
  listingType: string;
  area: string;
  city: string;
  region: string | null;
  countryCode: string;
  price: number | null;
  currency: string;
  posterType: string;
  posterConfidence: number | null;
  posterEvidence: string | null;
  sourceUrl: string | null;
  sourceName: string;
  publishedAt: string | null;
  updatedAt: string | null;
  lastSeenAt: string;
  contacts: DeliveryContact[];
};
type Delivery = {
  offerId: string;
  batch: { id: string; name: string; city: string; countryCode: string; currency: string; exclusive: boolean; summary: string | null };
  status: string;
  paidAt: string | null;
  deliveredAt: string | null;
  listings: DeliveredListing[];
};
type AgentDraft = { status: AgentStatus; notes: string; followUpAt: string };
type CsvOutcome = { row: number; name: string; message: string; ok: boolean };

const statuses: { value: AgentStatus; label: string; tone: "green" | "amber" | "purple" | "blue" | "neutral" }[] = [
  { value: "discovered", label: "Discovered", tone: "blue" },
  { value: "reviewed", label: "Reviewed", tone: "neutral" },
  { value: "contacted", label: "Contacted", tone: "amber" },
  { value: "interested", label: "Interested", tone: "purple" },
  { value: "customer", label: "Customer", tone: "green" },
  { value: "inactive", label: "Inactive", tone: "neutral" },
  { value: "opted_out", label: "Opted out", tone: "neutral" },
];
const csvHeaders = ["name", "agency", "country_code", "city", "service_areas", "preferred_property_types", "preferred_listing_types", "preferred_currency", "min_lead_volume", "max_lead_volume", "min_budget", "max_budget", "preferred_channel", "contact_name", "email", "phone", "source_name", "source_url", "linked_user_id", "status", "notes"];
const inputStyle = { width: "100%", minWidth: 0, border: "1px solid #dfe7e2", borderRadius: 7, background: "#fff", padding: "9px 10px", fontSize: 12 } as const;
const labelStyle = { display: "grid", alignContent: "start", gap: 5, color: "#59675f", fontSize: 11, fontWeight: 600 } as const;
const fieldGridStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 } as const;
const panelStyle = { padding: 16, marginBottom: 16 } as const;

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
}
function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}
function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not set";
}
function splitList(value: string | undefined) {
  return (value ?? "").split(/[;,]/).map((part) => part.trim()).filter(Boolean);
}
function optionalNumber(value: string | undefined, field: string) {
  const text = value?.trim() ?? "";
  if (!text) return undefined;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be a non-negative number.`);
  return number;
}
function csvPayload(row: CsvRecord) {
  const name = row.name?.trim() ?? "";
  const city = row.city?.trim() ?? "";
  const countryCode = row.country_code?.trim().toUpperCase() ?? "";
  if (name.length < 2) throw new Error("Name is required (at least 2 characters).");
  if (!city) throw new Error("City is required.");
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error("Country code must be a two-letter ISO code.");
  const status = (row.status?.trim() || "discovered") as AgentStatus;
  if (!statuses.some((option) => option.value === status)) throw new Error("Status is not supported.");
  const minLeadVolume = optionalNumber(row.min_lead_volume, "Minimum lead volume");
  const maxLeadVolume = optionalNumber(row.max_lead_volume, "Maximum lead volume");
  const minBudget = optionalNumber(row.min_budget, "Minimum budget");
  const maxBudget = optionalNumber(row.max_budget, "Maximum budget");
  if (minLeadVolume !== undefined && maxLeadVolume !== undefined && minLeadVolume > maxLeadVolume) throw new Error("Maximum lead volume must be at least the minimum.");
  if (minBudget !== undefined && maxBudget !== undefined && minBudget > maxBudget) throw new Error("Maximum budget must be at least the minimum.");
  const channel = row.preferred_channel?.trim() || "manual";
  if (!["email", "phone", "whatsapp", "manual"].includes(channel)) throw new Error("Preferred channel must be email, phone, whatsapp, or manual.");
  const contact = { name: row.contact_name?.trim() ?? "", email: row.email?.trim() ?? "", phone: row.phone?.trim() ?? "" };
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new Error("Contact email is not valid.");
  const sourceUrl = row.source_url?.trim() ?? "";
  if (sourceUrl) {
    let parsed: URL;
    try { parsed = new URL(sourceUrl); } catch { throw new Error("Source URL must be a valid HTTPS URL."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Source URL must be a valid HTTPS URL without embedded credentials.");
  }
  const currency = row.preferred_currency?.trim() ?? "";
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) throw new Error("Preferred currency must be a three-letter currency code.");
  return {
    name,
    agency: row.agency?.trim() || undefined,
    countryCode,
    city,
    serviceAreas: splitList(row.service_areas),
    preferredPropertyTypes: splitList(row.preferred_property_types),
    preferredListingTypes: splitList(row.preferred_listing_types),
    preferredCurrency: currency || undefined,
    minLeadVolume,
    maxLeadVolume,
    minBudget,
    maxBudget,
    preferredChannel: channel,
    contact: Object.values(contact).some(Boolean) ? contact : undefined,
    sourceName: row.source_name?.trim() || "CSV import",
    sourceUrl: sourceUrl || undefined,
    linkedUserId: row.linked_user_id?.trim() || undefined,
    status,
    notes: row.notes?.trim() || undefined,
  };
}

export function AgentDirectoryWorkspace() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [buyerName, setBuyerName] = useState("");
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingDeliveries, setLoadingDeliveries] = useState(true);
  const [agentsError, setAgentsError] = useState("");
  const [deliveryError, setDeliveryError] = useState("");
  const [buyerUnavailable, setBuyerUnavailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({});
  const [csvOutcomes, setCsvOutcomes] = useState<CsvOutcome[]>([]);
  const [csvFileName, setCsvFileName] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const loadAgents = useCallback(async () => {
    setLoadingAgents(true);
    setAgentsError("");
    try {
      const response = await fetch("/api/agent-directory", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      const data = body.data as Agent[];
      setAgents(data);
      setDrafts(Object.fromEntries(data.map((agent) => [agent.id, {
        status: agent.status,
        notes: agent.notes ?? "",
        followUpAt: localDateTime(agent.follow_up_at),
      }])));
    } catch (reason) {
      setAgentsError(reason instanceof Error ? reason.message : "Unable to load agent directory.");
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  const loadDeliveries = useCallback(async () => {
    setLoadingDeliveries(true);
    setDeliveryError("");
    setBuyerUnavailable(false);
    try {
      const response = await fetch("/api/agent-deliveries", { cache: "no-store" });
      if (response.status === 403) {
        setBuyerUnavailable(true);
        setDeliveries([]);
        setBuyerName("");
        return;
      }
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json();
      setBuyerName(body.buyer?.name ?? "");
      setDeliveries(body.data as Delivery[]);
    } catch (reason) {
      setDeliveryError(reason instanceof Error ? reason.message : "Unable to load purchased deliveries.");
    } finally {
      setLoadingDeliveries(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadAgents(); void loadDeliveries(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAgents, loadDeliveries]);

  async function createAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setAgentsError("");
    setNotice("");
    const values = new FormData(event.currentTarget);
    const read = (key: string) => String(values.get(key) ?? "").trim();
    try {
      const payload = {
        name: read("name"),
        agency: read("agency") || undefined,
        countryCode: read("countryCode").toUpperCase(),
        city: read("city"),
        serviceAreas: splitList(read("serviceAreas")),
        preferredPropertyTypes: splitList(read("preferredPropertyTypes")),
        preferredListingTypes: splitList(read("preferredListingTypes")),
        preferredCurrency: read("preferredCurrency").toUpperCase() || undefined,
        minLeadVolume: optionalNumber(read("minLeadVolume"), "Minimum lead volume"),
        maxLeadVolume: optionalNumber(read("maxLeadVolume"), "Maximum lead volume"),
        minBudget: optionalNumber(read("minBudget"), "Minimum budget"),
        maxBudget: optionalNumber(read("maxBudget"), "Maximum budget"),
        preferredChannel: read("preferredChannel"),
        contact: { name: read("contactName"), email: read("email"), phone: read("phone") },
        sourceName: read("sourceName") || "Manual entry",
        sourceUrl: read("sourceUrl") || undefined,
        linkedUserId: read("linkedUserId") || undefined,
        status: read("status") || "discovered",
        notes: read("notes") || undefined,
      };
      if (payload.minLeadVolume !== undefined && payload.maxLeadVolume !== undefined && payload.minLeadVolume > payload.maxLeadVolume) throw new Error("Maximum lead volume must be at least the minimum.");
      if (payload.minBudget !== undefined && payload.maxBudget !== undefined && payload.minBudget > payload.maxBudget) throw new Error("Maximum budget must be at least the minimum.");
      const response = await fetch("/api/agent-directory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(await responseError(response));
      const form = event.currentTarget;
      form.reset();
      setFormOpen(false);
      setNotice("Agent record saved. No message was sent.");
      await loadAgents();
    } catch (reason) {
      setAgentsError(reason instanceof Error ? reason.message : "Unable to save this agent record.");
    } finally {
      setSaving(false);
    }
  }

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setAgentsError("");
    setNotice("");
    setCsvOutcomes([]);
    if (file.size > 2 * 1024 * 1024) {
      setAgentsError("CSV import is limited to 2 MB.");
      return;
    }
    setImporting(true);
    setCsvFileName(file.name);
    try {
      const records = parseCsvRecords(await file.text());
      if (records.length > 100) throw new Error("CSV import is limited to 100 agent records at a time.");
      const headers = Object.keys(records[0] ?? {});
      const requiredHeaders = ["name", "city", "country_code"];
      const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
      if (missingHeaders.length) throw new Error(`CSV is missing required columns: ${missingHeaders.join(", ")}. Use the provided template.`);
      const outcomes: CsvOutcome[] = [];
      for (let index = 0; index < records.length; index += 1) {
        const row = records[index];
        try {
          const payload = csvPayload(row);
          const response = await fetch("/api/agent-directory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
          if (!response.ok) throw new Error(await responseError(response));
          outcomes.push({ row: index + 2, name: row.name || `Row ${index + 2}`, message: "Imported", ok: true });
        } catch (reason) {
          outcomes.push({ row: index + 2, name: row.name || `Row ${index + 2}`, message: reason instanceof Error ? reason.message : "Unable to import this row.", ok: false });
        }
        setCsvOutcomes([...outcomes]);
      }
      const succeeded = outcomes.filter((outcome) => outcome.ok).length;
      setNotice(`CSV processed: ${succeeded} of ${outcomes.length} agent record${outcomes.length === 1 ? "" : "s"} imported. No messages were sent.`);
      await loadAgents();
    } catch (reason) {
      setAgentsError(reason instanceof Error ? reason.message : "Unable to process this CSV file.");
    } finally {
      setImporting(false);
    }
  }

  async function updateAgent(agent: Agent) {
    const draft = drafts[agent.id];
    if (!draft) return;
    setAgentsError("");
    setNotice("");
    setSaving(true);
    try {
      const followUpAt = draft.followUpAt ? new Date(draft.followUpAt).toISOString() : null;
      const response = await fetch(`/api/agent-directory/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: draft.status, notes: draft.notes, followUpAt, summary: `Operator updated directory record: status ${draft.status}; notes and follow-up reviewed.` }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setNotice(`${agent.name} updated. The change was added to interaction history; no message was sent.`);
      await loadAgents();
    } catch (reason) {
      setAgentsError(reason instanceof Error ? reason.message : "Unable to update this agent record.");
    } finally {
      setSaving(false);
    }
  }

  async function downloadDeliveries() {
    setDownloading(true);
    setDeliveryError("");
    try {
      const response = await fetch("/api/agent-deliveries?format=csv", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "leadforge-purchased-batches.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setDeliveryError(reason instanceof Error ? reason.message : "Unable to download purchased deliveries.");
    } finally {
      setDownloading(false);
    }
  }

  const visibleAgents = useMemo(() => agents.filter((agent) => {
    const query = search.trim().toLocaleLowerCase("en");
    const textMatch = !query || `${agent.name} ${agent.agency ?? ""} ${agent.city} ${agent.country_code} ${agent.contact?.email ?? ""}`.toLocaleLowerCase("en").includes(query);
    return textMatch && (statusFilter === "all" || agent.status === statusFilter);
  }), [agents, search, statusFilter]);
  const totalListings = deliveries.reduce((sum, delivery) => sum + delivery.listings.length, 0);

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">Workspace / Agent directory</p><h1>Agent directory</h1><p className="subheading">Maintain your manually sourced agent relationships and review only the lead batches your signed-in buyer account is authorized to access.</p></div>
      <button className="secondary-button" type="button" onClick={() => { void loadAgents(); void loadDeliveries(); }} disabled={loadingAgents || loadingDeliveries}>Refresh workspace</button>
    </div>

    <div className="workspace-alert" role="note"><strong>Scope and contact safeguards.</strong> No directory discovery integration is connected; records are added manually or from your CSV. A stored contact does not imply permission to contact that person. This workspace never sends messages.</div>
    {agentsError && <div className="workspace-alert error" role="alert">Directory: {agentsError}</div>}
    {deliveryError && <div className="workspace-alert error" role="alert">Purchased deliveries: {deliveryError}</div>}
    {notice && <div className="workspace-alert success" role="status">{notice}</div>}

    <section className="panel" style={panelStyle} aria-labelledby="directory-heading">
      <div className="panel-header" style={{ marginBottom: 14 }}><div><h2 id="directory-heading">Operator directory</h2><p>Manually manage agent and brokerage records, status, notes, follow-up dates, and the change history.</p></div><button className="primary-button" type="button" onClick={() => setFormOpen((open) => !open)} aria-expanded={formOpen}>{formOpen ? "Close entry form" : "Add agent"}</button></div>
      <p style={{ margin: "0 0 14px", color: "#76847c", fontSize: 11 }}>Directory discovery is not connected. Use manual entry or the supplied CSV template. Any interaction recorded here is an operator note, not an outreach action.</p>
      {formOpen && <form onSubmit={createAgent} style={{ display: "grid", gap: 12, border: "1px solid #e7ede9", borderRadius: 9, background: "#fcfdfc", padding: 14, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>New agent record</h3>
        <div style={fieldGridStyle}>
          <label style={labelStyle}>Agent or business name<input style={inputStyle} name="name" required minLength={2} maxLength={160} autoComplete="organization" /></label>
          <label style={labelStyle}>Agency<input style={inputStyle} name="agency" maxLength={160} /></label>
          <label style={labelStyle}>Country code<input style={inputStyle} name="countryCode" required minLength={2} maxLength={2} pattern="[A-Za-z]{2}" aria-describedby="agent-country-help" /><small id="agent-country-help">Two-letter ISO code, such as PT.</small></label>
          <label style={labelStyle}>City<input style={inputStyle} name="city" required maxLength={120} autoComplete="address-level2" /></label>
          <label style={labelStyle}>Service areas<input style={inputStyle} name="serviceAreas" placeholder="Lisbon; Cascais" /><small>Separate multiple values with commas or semicolons.</small></label>
          <label style={labelStyle}>Property types<input style={inputStyle} name="preferredPropertyTypes" placeholder="apartment; house; all" /><small>Allowed: house, apartment, land, commercial, other, all.</small></label>
          <label style={labelStyle}>Listing types<input style={inputStyle} name="preferredListingTypes" placeholder="sale; rental" /></label>
          <label style={labelStyle}>Preferred currency<input style={inputStyle} name="preferredCurrency" maxLength={3} placeholder="EUR" /></label>
          <label style={labelStyle}>Minimum lead volume<input style={inputStyle} name="minLeadVolume" type="number" min="1" max="500" /></label>
          <label style={labelStyle}>Maximum lead volume<input style={inputStyle} name="maxLeadVolume" type="number" min="1" max="500" /></label>
          <label style={labelStyle}>Minimum budget<input style={inputStyle} name="minBudget" type="number" min="0" step="any" /></label>
          <label style={labelStyle}>Maximum budget<input style={inputStyle} name="maxBudget" type="number" min="0" step="any" /></label>
          <label style={labelStyle}>Preferred channel<select style={inputStyle} name="preferredChannel"><option value="manual">Manual</option><option value="email">Email</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option></select></label>
          <label style={labelStyle}>Initial status<select style={inputStyle} name="status">{statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
          <label style={labelStyle}>Contact name<input style={inputStyle} name="contactName" maxLength={160} autoComplete="name" /></label>
          <label style={labelStyle}>Contact email<input style={inputStyle} name="email" type="email" maxLength={254} autoComplete="email" /></label>
          <label style={labelStyle}>Contact phone<input style={inputStyle} name="phone" type="tel" maxLength={40} autoComplete="tel" /></label>
          <label style={labelStyle}>Source name<input style={inputStyle} name="sourceName" maxLength={160} defaultValue="Manual entry" /></label>
          <label style={labelStyle}>Source URL<input style={inputStyle} name="sourceUrl" type="url" placeholder="https://…" /></label>
          <label style={labelStyle}>Linked buyer account ID<input style={inputStyle} name="linkedUserId" type="text" aria-describedby="linked-user-help" /><small id="linked-user-help">Optional organization agent UUID; its verified account email must match the contact email above.</small></label>
        </div>
        <label style={labelStyle}>Notes<textarea style={inputStyle} name="notes" maxLength={4000} rows={3} /></label>
        <p style={{ margin: 0, color: "#89968f", fontSize: 10 }}>Contact details are stored as directory data; adding them grants no outreach permission and does not send a message.</p>
        <div><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save agent record"}</button></div>
      </form>}

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 10, marginBottom: 12 }}>
        <label style={{ ...labelStyle, flex: "1 1 220px" }}>Search directory<input style={inputStyle} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, agency, city, country, or email" /></label>
        <label style={{ ...labelStyle, minWidth: 170 }}>Filter by status<select style={inputStyle} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option>{statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
        <label className="secondary-button" style={{ minHeight: 36, cursor: importing ? "wait" : "pointer" }}> {importing ? "Importing CSV…" : "Import agent CSV"}<input type="file" accept=".csv,text/csv" onChange={(event) => void importCsv(event)} disabled={importing} aria-label="Import agent directory CSV" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap" }} /></label>
        <a className="secondary-button" href="/agent-directory-template.csv" download>Download CSV template</a>
      </div>
      <p style={{ margin: "0 0 14px", color: "#89968f", fontSize: 10 }}>CSV uses the template headers. Separate list values with semicolons; imports are limited to 100 rows and 2 MB. Each row is saved through the directory API and reports its own result.</p>
      {csvOutcomes.length > 0 && <section aria-label={`Import results for ${csvFileName}`} style={{ border: "1px solid #e7ede9", borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 12 }}>Import results · {csvFileName}</h3>
        <ul style={{ display: "grid", gap: 5, margin: 0, paddingLeft: 20, fontSize: 11 }}>{csvOutcomes.map((outcome) => <li key={outcome.row} style={{ color: outcome.ok ? "#347555" : "#883a3b" }}>Row {outcome.row} — {outcome.name}: {outcome.message}</li>)}</ul>
      </section>}
      {loadingAgents ? <div className="workspace-state" role="status">Loading organization agent records…</div>
        : agentsError && agents.length === 0 ? <div className="workspace-state"><h3>Directory unavailable</h3><p>Check your signed-in account&apos;s operator permissions and try again.</p></div>
          : visibleAgents.length === 0 ? <div className="workspace-state"><h3>{agents.length ? "No records match these filters" : "No agent records yet"}</h3><p>{agents.length ? "Change the search or status filter to see more records." : "Add an authorized record manually or import your CSV."}</p></div>
            : <div style={{ display: "grid", gap: 12 }}>{visibleAgents.map((agent) => {
              const draft = drafts[agent.id] ?? { status: agent.status, notes: agent.notes ?? "", followUpAt: localDateTime(agent.follow_up_at) };
              const status = statuses.find((item) => item.value === agent.status) ?? statuses[0];
              return <article key={agent.id} style={{ border: "1px solid #e7ede9", borderRadius: 9, background: "#fcfdfc", padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", flexWrap: "wrap", gap: 12 }}>
                  <div><h3 style={{ margin: 0, fontSize: 13, color: "#2b3e33" }}>{agent.name}</h3><p style={{ margin: "5px 0 0", color: "#829087", fontSize: 11 }}>{[agent.agency, [agent.city, agent.country_code].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</p></div>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", margin: "10px 0", color: "#69786f", fontSize: 11 }}>
                  {agent.contact?.name && <span>Contact: {agent.contact.name}</span>}{agent.contact?.email && <span>Email: {agent.contact.email}</span>}{agent.contact?.phone && <span>Phone: {agent.contact.phone}</span>}
                  {agent.service_areas?.length > 0 && <span>Service areas: {agent.service_areas.join(", ")}</span>}
                  {agent.preferred_property_types?.length > 0 && <span>Property types: {agent.preferred_property_types.join(", ")}</span>}
                  <span>Source: {agent.source_name}{agent.source_url ? <> · <a href={agent.source_url} target="_blank" rel="noreferrer" style={{ color: "#23785c", textDecoration: "underline" }}>source record ↗</a></> : ""}</span>
                  {agent.linked_user_id && <span>Linked buyer account: {agent.linked_user_id}</span>}
                  <span>Current follow-up: {dateLabel(agent.follow_up_at)}</span>
                </div>
                <div style={{ display: "grid", gap: 10, borderTop: "1px solid #edf0ee", paddingTop: 11 }}>
                  <div style={fieldGridStyle}>
                    <label style={labelStyle}>Status<select style={inputStyle} value={draft.status} onChange={(event) => setDrafts((current) => ({ ...current, [agent.id]: { ...draft, status: event.target.value as AgentStatus } }))} disabled={agent.status === "opted_out"}><option value="opted_out" disabled={agent.status !== "opted_out"}>Opted out</option>{statuses.filter((item) => item.value !== "opted_out").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                    <label style={labelStyle}>Follow-up date and time<input style={inputStyle} type="datetime-local" value={draft.followUpAt} onChange={(event) => setDrafts((current) => ({ ...current, [agent.id]: { ...draft, followUpAt: event.target.value } }))} /></label>
                  </div>
                  <label style={labelStyle}>Operator notes<textarea style={inputStyle} rows={2} maxLength={4000} value={draft.notes} onChange={(event) => setDrafts((current) => ({ ...current, [agent.id]: { ...draft, notes: event.target.value } }))} /></label>
                  <div><button className="secondary-button small" type="button" onClick={() => void updateAgent(agent)} disabled={saving}>Save status, notes & follow-up</button><span style={{ marginLeft: 9, color: "#89968f", fontSize: 10 }}>Saves an interaction-history entry. Does not contact this agent.</span></div>
                </div>
                <details style={{ marginTop: 12, borderTop: "1px solid #edf0ee", paddingTop: 10 }}>
                  <summary style={{ cursor: "pointer", color: "#52635a", fontSize: 11, fontWeight: 650 }}>Interaction history ({agent.interactions?.length ?? 0})</summary>
                  {agent.interactions?.length ? <ol style={{ display: "grid", gap: 9, margin: "10px 0 0", paddingLeft: 20 }}>{agent.interactions.map((interaction) => <li key={interaction.id} style={{ color: "#59675f", fontSize: 11 }}><b>{interaction.summary}</b><small style={{ display: "block", marginTop: 3, color: "#87948d" }}>{dateLabel(interaction.occurred_at)} · {interaction.interaction_type} · {interaction.channel}{interaction.follow_up_at ? ` · follow-up ${dateLabel(interaction.follow_up_at)}` : ""}</small></li>)}</ol> : <p style={{ margin: "9px 0 0", color: "#89968f", fontSize: 11 }}>No interactions recorded yet.</p>}
                </details>
              </article>;
            })}</div>}
    </section>

    <section className="panel" style={panelStyle} aria-labelledby="deliveries-heading">
      <div className="panel-header" style={{ marginBottom: 12 }}><div><h2 id="deliveries-heading">Your purchased lead deliveries</h2><p>Private records returned only when this signed-in account is linked to a buyer profile in the current organization.</p></div><button className="secondary-button" type="button" onClick={() => void downloadDeliveries()} disabled={downloading || buyerUnavailable}>{downloading ? "Preparing CSV…" : "Download authorized deliveries CSV"}</button></div>
      <p style={{ margin: "0 0 14px", color: "#76847c", fontSize: 11 }}>{buyerName ? `Authorized buyer: ${buyerName}.` : "No directory discovery or public buyer search is used here."} Showing {totalListings} delivered listing{totalListings === 1 ? "" : "s"} across {deliveries.length} paid or delivered batch{deliveries.length === 1 ? "" : "es"}. Contact permission is not implied by purchase, access, or a displayed contact record; check applicable consent and policy before any independent outreach.</p>
      {loadingDeliveries ? <div className="workspace-state" role="status">Checking signed-in buyer access and purchased deliveries…</div>
        : buyerUnavailable ? <div className="workspace-state compact"><h3>No linked buyer profile</h3><p>This account is not currently authorized through a linked agent-directory buyer profile. Ask your organization manager to verify the intended account link; no delivery records are exposed here.</p></div>
          : deliveries.length === 0 ? <div className="workspace-state compact"><h3>No paid or delivered batches</h3><p>There are no purchased deliveries available to this linked buyer account.</p></div>
            : <div style={{ display: "grid", gap: 14 }}>{deliveries.map((delivery) => <article key={delivery.offerId} style={{ border: "1px solid #e7ede9", borderRadius: 9, background: "#fcfdfc", padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, alignItems: "start" }}><div><h3 style={{ margin: 0, fontSize: 13 }}>{delivery.batch.name}</h3><p style={{ margin: "5px 0 0", color: "#829087", fontSize: 11 }}>{delivery.batch.city}, {delivery.batch.countryCode} · {delivery.batch.exclusive ? "Exclusive" : "Shared"} · {delivery.status}</p></div><StatusPill tone={delivery.status === "delivered" ? "green" : "blue"}>{delivery.status}</StatusPill></div>
              <p style={{ color: "#76847c", fontSize: 10 }}>Paid {dateLabel(delivery.paidAt)} · Delivered {dateLabel(delivery.deliveredAt)} · {delivery.listings.length} listing{delivery.listings.length === 1 ? "" : "s"}{delivery.batch.summary ? ` · ${delivery.batch.summary}` : ""}</p>
              <div style={{ display: "grid", gap: 10 }}>{delivery.listings.map((listing) => <section key={listing.id} style={{ borderTop: "1px solid #edf0ee", paddingTop: 11 }}>
                <h4 style={{ margin: 0, fontSize: 12, color: "#2b3e33" }}>{listing.title}</h4>
                <p style={{ margin: "5px 0", color: "#66766d", fontSize: 11 }}>{[listing.propertyType, listing.listingType, listing.area, listing.city, listing.region, listing.countryCode].filter(Boolean).join(" · ")}{listing.price !== null ? ` · ${listing.price.toLocaleString()} ${listing.currency}` : ""}</p>
                {listing.summary && <p style={{ margin: "5px 0", color: "#66766d", fontSize: 11 }}>{listing.summary}</p>}
                <p style={{ margin: "5px 0", color: "#748279", fontSize: 10 }}>Poster: {listing.posterType.replaceAll("_", " ")} · {listing.posterConfidence === null ? "confidence unavailable" : `${listing.posterConfidence}% confidence`}{listing.posterEvidence ? ` · ${listing.posterEvidence}` : ""}</p>
                <p style={{ margin: "4px 0", color: "#748279", fontSize: 10 }}>Listing provenance: {listing.sourceName}{listing.sourceUrl ? <> · <a href={listing.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "#23785c", textDecoration: "underline" }}>source listing ↗</a></> : ""} · last seen {dateLabel(listing.lastSeenAt)}</p>
                {listing.contacts.length ? <div style={{ display: "grid", gap: 7, marginTop: 8 }}>{listing.contacts.map((contact, index) => <div key={`${listing.id}-${contact.type}-${index}`} style={{ borderRadius: 7, background: "#f3f7f4", padding: 9, color: "#59675f", fontSize: 10 }}>
                  <b>{contact.type.replaceAll("_", " ")} contact</b><div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 4 }}>{contact.name && <span>Name: {contact.name}</span>}{contact.email && <span>Email: {contact.email}</span>}{contact.phone && <span>Phone: {contact.phone}</span>}</div>
                  <div style={{ marginTop: 4 }}>Verification: {contact.verificationStatus ?? "not provided"} · Permission record: {contact.permissionStatus ?? "not provided"}</div>
                  {contact.publicationContext && <div style={{ marginTop: 4 }}>Publication context: {contact.publicationContext}</div>}
                  <div style={{ marginTop: 4 }}>Contact provenance: {contact.sourceUrl ? <a href={contact.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "#23785c", textDecoration: "underline" }}>source URL ↗</a> : "source URL not provided"} · collected {dateLabel(contact.collectedAt ?? null)} · last verified {dateLabel(contact.lastVerifiedAt ?? null)}</div>
                </div>)}</div> : <p style={{ margin: "7px 0 0", color: "#89968f", fontSize: 10 }}>No contact details are included for this listing.</p>}
              </section>)}</div>
            </article>)}</div>}
    </section>
  </>;
}
