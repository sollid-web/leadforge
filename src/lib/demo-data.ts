export type LeadStatus = "New" | "Review" | "Qualified" | "Nurture";
export type LeadTemperature = "Hot" | "Warm" | "Cool";

export type Lead = {
  id: string;
  name: string;
  initials: string;
  email: string;
  phone: string;
  location: string;
  interest: string;
  budget: string;
  source: string;
  score: number;
  temperature: LeadTemperature;
  status: LeadStatus;
  lastActivity: string;
  consent: "Confirmed" | "Unknown";
};

export const leads: Lead[] = [
  { id: "lf-1024", name: "Amara Okafor", initials: "AO", email: "amara.okafor@example.com", phone: "+234 803 112 9044", location: "Ikoyi, Lagos", interest: "3-bed apartment", budget: "₦85m", source: "Website form", score: 94, temperature: "Hot", status: "Qualified", lastActivity: "12 min ago", consent: "Confirmed" },
  { id: "lf-1023", name: "Daniel Mwangi", initials: "DM", email: "daniel.mwangi@example.com", phone: "+254 721 440 219", location: "Westlands, Nairobi", interest: "Office space", budget: "$320k", source: "PropertyPro", score: 87, temperature: "Hot", status: "Review", lastActivity: "38 min ago", consent: "Confirmed" },
  { id: "lf-1022", name: "Chioma Nwosu", initials: "CN", email: "chioma.nwosu@example.com", phone: "+234 809 551 0821", location: "Lekki Phase 1", interest: "Family home", budget: "₦120m", source: "Instagram", score: 81, temperature: "Warm", status: "Review", lastActivity: "1 hr ago", consent: "Confirmed" },
  { id: "lf-1021", name: "Samuel Adeyemi", initials: "SA", email: "samuel.adeyemi@example.com", phone: "+234 706 229 3180", location: "Victoria Island", interest: "2-bed apartment", budget: "₦62m", source: "CSV import", score: 73, temperature: "Warm", status: "Nurture", lastActivity: "3 hrs ago", consent: "Unknown" },
  { id: "lf-1020", name: "Fatima Bello", initials: "FB", email: "fatima.bello@example.com", phone: "+234 815 087 4001", location: "Maitama, Abuja", interest: "Land parcel", budget: "₦45m", source: "Referral", score: 68, temperature: "Cool", status: "New", lastActivity: "Yesterday", consent: "Confirmed" },
  { id: "lf-1019", name: "Ibrahim Musa", initials: "IM", email: "ibrahim.musa@example.com", phone: "+234 802 441 2007", location: "Yaba, Lagos", interest: "Starter home", budget: "₦38m", source: "Website form", score: 61, temperature: "Cool", status: "Nurture", lastActivity: "Yesterday", consent: "Unknown" },
];

export const activities = [
  { text: "Amara Okafor was marked qualified", time: "12 min ago", tone: "green" },
  { text: "New lead imported from PropertyPro", time: "38 min ago", tone: "blue" },
  { text: "Follow-up draft approved by Tobi", time: "1 hr ago", tone: "purple" },
  { text: "Scoring rules v2.4 published", time: "Yesterday", tone: "amber" },
];

export const followUps = [
  { id: "fu-1", lead: "Amara Okafor", initials: "AO", subject: "A few homes in Ikoyi you may like", channel: "Email", status: "Awaiting approval", score: 94, created: "12 min ago" },
  { id: "fu-2", lead: "Daniel Mwangi", initials: "DM", subject: "Office options around Westlands", channel: "Email", status: "Draft", score: 87, created: "38 min ago" },
  { id: "fu-3", lead: "Chioma Nwosu", initials: "CN", subject: "Your Lekki Phase 1 shortlist", channel: "Email", status: "Approved", score: 81, created: "1 hr ago" },
];

export const workflows = [
  { name: "Lead discovery", description: "Pulls approved source records and stages new enquiries.", status: "Healthy", runs: "24 runs", updated: "12 min ago", icon: "inbox" },
  { name: "Qualification engine", description: "Normalizes, deduplicates, and scores every new lead.", status: "Healthy", runs: "24 runs", updated: "12 min ago", icon: "spark" },
  { name: "Follow-up drafts", description: "Creates reviewable, evidence-based email drafts.", status: "Paused", runs: "18 runs", updated: "Yesterday", icon: "pen" },
  { name: "Approved email dispatch", description: "Sends only human-approved messages through Gmail.", status: "Needs setup", runs: "—", updated: "Not connected", icon: "send" },
];

export const metrics = [
  { label: "Total leads", value: "1,284", change: "+12.8%", note: "vs. last 30 days", tone: "blue" },
  { label: "Qualified leads", value: "342", change: "+8.4%", note: "26.6% of total", tone: "green" },
  { label: "Awaiting review", value: "18", change: "Needs attention", note: "qualification queue", tone: "amber" },
  { label: "Follow-ups", value: "7", change: "3 urgent", note: "awaiting approval", tone: "purple" },
];
