export type ScoringInput = {
  explicitInterest?: boolean;
  propertyTypeMatch?: boolean;
  locationMatch?: boolean;
  budgetCompatible?: boolean;
  enquiryAgeDays?: number;
  informationCompleteness?: number;
  requestedContact?: boolean;
};

export type ScoreFactor = { id: string; label: string; contribution: number; evidence: string };

export const scoringRules = [
  { id: "interest", label: "Explicit property interest", weight: 25 },
  { id: "property-match", label: "Property type match", weight: 18 },
  { id: "location-match", label: "Location match", weight: 15 },
  { id: "budget", label: "Budget compatibility", weight: 15 },
  { id: "recency", label: "Recent enquiry", weight: 12 },
  { id: "completeness", label: "Information completeness", weight: 10 },
  { id: "contact", label: "Requested contact", weight: 5 },
] as const;

export function scoreLead(input: ScoringInput) {
  const factors: ScoreFactor[] = [
    { id: "interest", label: "Explicit property interest", contribution: input.explicitInterest ? 25 : 0, evidence: input.explicitInterest ? "Lead named a property need" : "No explicit property need recorded" },
    { id: "property-match", label: "Property type match", contribution: input.propertyTypeMatch ? 18 : 0, evidence: input.propertyTypeMatch ? "Matches the configured property type" : "Property type is not a match" },
    { id: "location-match", label: "Location match", contribution: input.locationMatch ? 15 : 0, evidence: input.locationMatch ? "Location matches the search brief" : "Location match not confirmed" },
    { id: "budget", label: "Budget compatibility", contribution: input.budgetCompatible ? 15 : 0, evidence: input.budgetCompatible ? "Budget is compatible" : "Budget compatibility needs review" },
    { id: "recency", label: "Recent enquiry", contribution: input.enquiryAgeDays === undefined ? 0 : Math.max(0, 12 - Math.min(input.enquiryAgeDays, 12)), evidence: input.enquiryAgeDays === undefined ? "Enquiry date unavailable" : `${input.enquiryAgeDays} day(s) since enquiry` },
    { id: "completeness", label: "Information completeness", contribution: Math.round(Math.max(0, Math.min(10, input.informationCompleteness ?? 0))), evidence: `${Math.round(Math.max(0, Math.min(100, input.informationCompleteness ?? 0)))}% of required fields present` },
    { id: "contact", label: "Requested contact", contribution: input.requestedContact ? 5 : 0, evidence: input.requestedContact ? "Lead asked to be contacted" : "No contact request recorded" },
  ];
  const score = Math.max(0, Math.min(100, factors.reduce((sum, factor) => sum + factor.contribution, 0)));
  const band = score >= 80 ? "Qualified" : score >= 60 ? "Review" : "Nurture";
  return { score, band, ruleVersion: "2.4", factors, explanation: score >= 80 ? "Strong fit with clear intent and enough evidence to prioritize a human-reviewed follow-up." : score >= 60 ? "Promising signal, but a reviewer should confirm the missing evidence before outreach." : "Keep this lead in nurture until more intent or profile information is available." };
}
