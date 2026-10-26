import assert from "node:assert/strict";
import test from "node:test";
import { contactFingerprint } from "../src/lib/contact-identity.ts";
import { parseCsv } from "../src/lib/listing-csv.ts";
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
