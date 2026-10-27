import assert from "node:assert/strict";
import test from "node:test";
import {
  canTransitionOffer,
  composeOfferTemplate,
  matchAgentsToBatch,
  qualifyBatchListings,
  toMinorUnits,
} from "../src/lib/agent-sales-pipeline.ts";
import { summarizeOfferConversions } from "../src/lib/sales-metrics.ts";

const today = "2026-10-27T00:00:00.000Z";
function listing(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    title: "Owner indicated two bedroom home",
    city: "Lagos",
    region: "Lagos",
    country_code: "NG",
    currency: "NGN",
    property_type: "house",
    listing_type: "sale",
    price: 125000000,
    owner_led_claim: true,
    poster_type: "OWNER_UNVERIFIED",
    source_url: "https://permitted.example/listing/1",
    status: "new",
    has_contact_information: true,
    last_seen_at: today,
    source_name: "Permitted Feed",
    ...overrides,
  };
}

const batch = {
  city: "Lagos",
  region: "Lagos",
  countryCode: "NG",
  currency: "NGN",
  leadCount: 20,
  propertyTypes: { house: 18, apartment: 2 },
  listingTypes: { sale: 20 },
  priceMin: 50_000_000,
  priceMax: 200_000_000,
  freshnessDays: 14,
};

function agent(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: "Local Realty",
    country_code: "NG",
    city: "Lagos",
    service_areas: [],
    preferred_property_types: ["house", "apartment"],
    preferred_listing_types: ["sale"],
    preferred_currency: "NGN",
    min_lead_volume: 10,
    max_lead_volume: 30,
    min_budget: 20_000_000,
    max_budget: 500_000_000,
    status: "reviewed",
    ...overrides,
  };
}

test("batch qualification retains only fresh owner-indicated, source-backed, exact-city/currency records", () => {
  const records = [
    listing(),
    listing({ city: "Abuja" }),
    listing({ country_code: "US" }),
    listing({ currency: "USD" }),
    listing({ owner_led_claim: false }),
    listing({ poster_type: "AGENT" }),
    listing({ status: "closed" }),
    listing({ suppressed_at: today }),
    listing({ source_url: "http://unsafe.example/listing" }),
    listing({ last_seen_at: "2026-10-01T00:00:00.000Z" }),
    listing({ id: "already-sold" }),
  ];
  const result = qualifyBatchListings(records, { now: Date.parse(today), maxFreshnessDays: 14, soldListingIds: new Set(["already-sold"]) });
  assert.equal(result.qualified.length, 1);
  assert.equal(result.rejected.length, 10);
  assert.equal(result.summary.leadCount, 1);
  assert.equal(result.summary.contactsAvailable, 1);
  assert.equal(result.summary.region, "Lagos");
  assert.ok(result.rejected.some((row) => row.id === "already-sold" && row.reasons.some((reason) => reason.includes("already sold"))));
});

test("twenty eligible records have truthful batch contact, owner, category, source and price summaries", () => {
  const records = Array.from({ length: 20 }, (_, index) => listing({
    id: `listing-${index}`,
    poster_type: index < 4 ? "OWNER_VERIFIED" : "OWNER_UNVERIFIED",
    has_contact_information: index < 11,
    property_type: index < 15 ? "house" : "apartment",
  }));
  const result = qualifyBatchListings(records, { now: Date.parse(today) });
  assert.equal(result.qualified.length, 20);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.summary.contactPercent, 55);
  assert.equal(result.summary.ownerVerified, 4);
  assert.equal(result.summary.ownerUnverified, 16);
  assert.deepEqual(result.summary.propertyTypes, { house: 15, apartment: 5 });
});

test("agent matching requires exact country plus exact city or configured service area and honors preferences", () => {
  const good = agent();
  const area = agent({ id: "area-agent", name: "Ikeja Group", city: "Ikeja", service_areas: ["Lagos, Lagos"] });
  const wrongCountry = agent({ id: "wrong-country", country_code: "US", city: "Lagos" });
  const wrongCity = agent({ id: "wrong-city", city: "Kano", service_areas: [] });
  const wrongCurrency = agent({ id: "wrong-currency", preferred_currency: "USD" });
  const noType = agent({ id: "no-type", preferred_property_types: ["land"] });
  const optedOut = agent({ id: "opt-out", status: "opted_out" });
  const result = matchAgentsToBatch(batch, [good, area, wrongCountry, wrongCity, wrongCurrency, noType, optedOut]);
  assert.deepEqual(result.matches.map((item) => item.agentId), [good.id, area.id]);
  assert.equal(result.matches[0].score, 100);
  assert.ok(result.matches[0].factors.some((factor) => factor.factor === "Country"));
  assert.equal(result.excluded.length, 5);
});

test("agent budget and batch-volume mismatch are excluded, not scored as compatible", () => {
  const result = matchAgentsToBatch(batch, [
    agent({ id: "small", max_lead_volume: 10 }),
    agent({ id: "low-budget", max_budget: 10_000_000 }),
  ]);
  assert.equal(result.matches.length, 0);
  assert.equal(result.excluded.length, 2);
});

test("offer copy uses actual batch facts and discloses shared distribution and non-consent", () => {
  const message = composeOfferTemplate("initial_offer", "Amina", {
    batchName: "Lagos Oct batch",
    city: "Lagos",
    countryCode: "NG",
    leadCount: 20,
    contactCount: 11,
    ownerVerified: 4,
    ownerUnverified: 16,
    propertyTypes: { house: 15, apartment: 5 },
    listingTypes: { sale: 20 },
    exclusive: false,
    priceLabel: "NGN 20,000.00 per lead",
  });
  assert.match(message, /20 owner-indicated property listings/);
  assert.match(message, /11 of 20 records/);
  assert.match(message, /4 manager-verified and 16 owner-unverified/);
  assert.match(message, /not marketing consent/);
  assert.match(message, /shared batch and may be offered to other buyers/);
  assert.match(message, /NGN 20,000.00 per lead/);
});

test("currency minor-unit conversion handles NGN and zero-decimal JPY without rounding surprises", () => {
  assert.equal(toMinorUnits(100.25, "NGN"), 10025);
  assert.equal(toMinorUnits(100, "JPY"), 100);
  assert.throws(() => toMinorUnits(100.001, "NGN"), /fraction digits/);
});

test("offer transitions allow human review and reject unverified paid/delivery jumps", () => {
  assert.equal(canTransitionOffer("draft", "ready_for_review"), true);
  assert.equal(canTransitionOffer("approved", "sent"), true);
  assert.equal(canTransitionOffer("accepted", "paid"), false);
  assert.equal(canTransitionOffer("draft", "delivered"), false);
  assert.equal(canTransitionOffer("paid", "delivered"), true);
  assert.equal(canTransitionOffer("delivered", "refunded"), true);
});

test("persisted offer conversion summaries group by city, source coverage, and pricing mode", () => {
  const grouped = summarizeOfferConversions([
    { batch_id: "b-miami", status: "delivered", pricing_mode: "batch", offer_sent_at: today, responded_at: today, paid_at: today, delivered_at: today },
    { batch_id: "b-miami", status: "sent", pricing_mode: "per_lead", offer_sent_at: today },
    { batch_id: "b-austin", status: "accepted", pricing_mode: "batch", offer_sent_at: today, responded_at: today },
  ], [
    { id: "b-miami", city: "Miami", summary: { source_coverage: ["Zillow", "FSBO Feed"] } },
    { id: "b-austin", city: "Austin", summary: { source_coverage: ["FSBO Feed"] } },
  ]);

  assert.equal(grouped.city.Miami.offers, 2);
  assert.equal(grouped.city.Miami.responseRate, 50);
  assert.equal(grouped.city.Miami.interestRate, 50);
  assert.equal(grouped.city.Austin.interested, 1);
  assert.equal(grouped.sourceCoverage["FSBO Feed"].offers, 3);
  assert.equal(grouped.sourceCoverage.Zillow.offers, 2);
  assert.equal(grouped.offerType.batch.offers, 2);
  assert.equal(grouped.offerType.per_lead.offers, 1);
});
