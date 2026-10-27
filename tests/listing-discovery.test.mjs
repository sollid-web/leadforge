import assert from "node:assert/strict";
import test from "node:test";
import { contactFingerprint } from "../src/lib/contact-identity.ts";
import { parseCsv, parseCsvRecords } from "../src/lib/listing-csv.ts";
import { mapScraperCsvRow } from "../src/lib/scraper-csv.ts";
import { listingInputSchema, normalizeListing } from "../src/lib/opportunities.ts";

const listing = {
  sourceName: "Owner submission",
  sourceType: "manual",
  title: "Two bedroom home",
  propertyType: "house",
  area: "Lekki",
  city: "Lagos",
  countryCode: "NG",
  currency: "NGN",
};

test("listing URL deduplication ignores tracking parameters but preserves meaningful query values", () => {
  const first = normalizeListing(listingInputSchema.parse({
    ...listing,
    sourceUrl: "https://example.com/property?id=42&utm_source=mail#details",
  }));
  const repeated = normalizeListing(listingInputSchema.parse({
    ...listing,
    sourceUrl: "https://example.com/property?id=42&fbclid=tracking",
  }));

  assert.equal(first.dedupeKey, repeated.dedupeKey);
  assert.equal(first.sourceUrl, "https://example.com/property?id=42");
});

test("owner verified classifications cannot be asserted through listing intake", () => {
  const result = listingInputSchema.safeParse({
    ...listing,
    posterType: "OWNER_VERIFIED",
  });

  assert.equal(result.success, false);
});

test("same listing contact identity produces a stable deduplication fingerprint", () => {
  const first = contactFingerprint("owner", {
    email: "OWNER@example.com",
    phone: "+234 801-234-5678",
  });
  const repeated = contactFingerprint("owner", {
    email: "owner@example.com",
    phone: "+2348012345678",
  });

  assert.ok(first);
  assert.equal(first, repeated);
  assert.notEqual(first, contactFingerprint("listing_agent", {
    email: "owner@example.com",
    phone: "+2348012345678",
  }));
  assert.equal(
    contactFingerprint("owner", { name: "  Jane   Owner " }),
    contactFingerprint("owner", { name: "jane owner" }),
  );
  assert.equal(contactFingerprint("owner", {}), null);
});

test("CSV import parses quoted delimiters and rejects malformed rows", () => {
  const records = parseCsv(
    'title,property_type,area,city,country_code,description\r\n"Home, duplex",house,Lekki,Lagos,NG,"Owner said ""available"""\r\n',
  );

  assert.equal(records[0].title, "Home, duplex");
  assert.equal(records[0].description, 'Owner said "available"');
  assert.throws(() => parseCsv("title,property_type,area,city,country_code\n\"unfinished,house,Lekki,Lagos,NG"));
  assert.throws(() => parseCsv("title,property_type,area,city,country_code\none,house,Lekki,Lagos,NG,extra"));
});

test("legacy scraper CSV maps only to an approved matching feed and keeps contacts unclassified", () => {
  const [row] = parseCsvRecords('id,type,source,city,title,price,location,date_posted,link,owner_name,phone,notes,email\n"z-42",FSBO,Zillow,Miami,"2 bed home", "$500,000", "Miami, FL",2026-10-01,https://www.zillow.com/homedetails/42/,Jane Doe,3055550100,"2bd/2ba",jane@example.com');
  const mapped = mapScraperCsvRow(row, [{
    name: "Zillow",
    source_type: "approved_feed",
    source_url: "https://www.zillow.com",
    approved: true,
    active: true,
  }]);

  assert.deepEqual(mapped.errors, []);
  assert.ok(mapped.payload);
  assert.equal(mapped.payload.countryCode, "US");
  assert.equal(mapped.payload.region, "FL");
  assert.equal(mapped.payload.currency, "USD");
  assert.equal(mapped.payload.listingType, "sale");
  assert.equal(mapped.payload.posterType, "OWNER_UNVERIFIED");
  assert.equal(mapped.payload.privateDetails?.otherContactEmail, "jane@example.com");
  assert.equal(mapped.payload.privateDetails?.otherContactPhone, "3055550100");
  assert.equal(mapped.payload.privateDetails?.otherContactName, "Jane Doe");
  assert.equal("ownerEmail" in (mapped.payload.privateDetails ?? {}), false);
  assert.match(mapped.payload.publicContactContext ?? "", /role are not independently verified/);
  assert.equal(listingInputSchema.safeParse(mapped.payload).success, true);

  const ambiguous = mapScraperCsvRow({ ...row, price: "From $500,000 - $600,000" }, [{
    name: "Zillow",
    source_type: "approved_feed",
    source_url: "https://www.zillow.com",
    approved: true,
    active: true,
  }]);
  assert.equal(ambiguous.payload?.price, undefined);
  assert.ok(ambiguous.warnings.some((warning) => warning.includes("single unambiguous numeric amount")));
});

test("LeadForge worker manifest maps into preview with exact source, US sale, and owner-unverified evidence", () => {
  const [row] = parseCsvRecords('external_id,source_name,source_url,country_code,region,currency,listing_type,property_type,poster_type,poster_evidence,city,title,price,link,owner_name,phone,email\nlf-123,ForSaleByOwner.com,https://www.forsalebyowner.com/listing/123,US,FL,USD,sale,other,OWNER_UNVERIFIED,"Owner-search result; identity not verified.",Miami,"Sample listing",$420000,https://www.forsalebyowner.com/listing/123,Contact,3055550100,contact@example.com');
  const mapped = mapScraperCsvRow(row, [{
    name: "ForSaleByOwner.com",
    source_type: "approved_feed",
    source_url: "https://www.forsalebyowner.com",
    approved: true,
    active: true,
  }]);

  assert.deepEqual(mapped.errors, []);
  assert.ok(mapped.payload);
  assert.equal(mapped.payload.sourceName, "ForSaleByOwner.com");
  assert.equal(mapped.payload.externalId, "lf-123");
  assert.equal(mapped.payload.listingType, "sale");
  assert.equal(mapped.payload.propertyType, "other");
  assert.equal(mapped.payload.posterType, "OWNER_UNVERIFIED");
  assert.equal(mapped.payload.ownerLedClaim, true);
  assert.equal(mapped.payload.currency, "USD");
  assert.equal(listingInputSchema.safeParse(mapped.payload).success, true);
});

test("legacy scraper CSV rejects unapproved sources, mismatched hosts, missing transaction, and verified-owner claims", () => {
  const row = {
    source: "Listings",
    city: "Miami",
    title: "Property",
    type: "unknown",
    price: "$200,000",
    location: "Miami, FL",
    link: "https://example.com/listing/1",
    poster_type: "OWNER_VERIFIED",
  };
  const source = {
    name: "Listings",
    source_type: "approved_feed",
    source_url: "https://listings.example",
    approved: false,
    active: false,
  };
  const mapped = mapScraperCsvRow(row, [source]);
  assert.equal(mapped.payload, undefined);
  assert.ok(mapped.errors.some((error) => error.includes("not approved and active")));
  assert.ok(mapped.errors.some((error) => error.includes("host does not match")));
  assert.ok(mapped.errors.some((error) => error.includes("Sale or rental status")));
  assert.ok(mapped.errors.some((error) => error.includes("cannot assert OWNER_VERIFIED")));
});
