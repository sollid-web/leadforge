import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeUnteraListing,
  searchUnteraListings,
  UnteraProviderError,
  unteraSearchSchema,
} from "../src/lib/providers/untera.ts";

const originalFetch = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = handler;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("search validates supported filters, encodes documented query fields, and reads pagination", async () => {
  let requestUrl;
  mockFetch(async (url, options) => {
    requestUrl = new URL(url);
    assert.equal(options.headers["X-API-Key"], "server-test-key");
    return Response.json({
      results: [{ id: "listing-1", title: "Two bedroom home", country_code: "NG" }],
      pagination: { page: 2, pageSize: 10, total: 25 },
    });
  });

  const filters = unteraSearchSchema.parse({
    country: "ng",
    location: "Lagos",
    propertyType: "house",
    transaction: "rental",
    minPrice: 100,
    maxPrice: 1000,
    minBedrooms: 2,
    minSizeSqm: 40,
    maxSizeSqm: 100,
    page: 2,
    pageSize: 10,
  });
  const result = await searchUnteraListings(filters, "server-test-key");

  assert.equal(requestUrl.pathname, "/api/v1/listings/search");
  assert.equal(requestUrl.searchParams.get("country"), "NG");
  assert.equal(requestUrl.searchParams.get("location"), "Lagos");
  assert.equal(requestUrl.searchParams.get("type"), "house");
  assert.equal(requestUrl.searchParams.get("transaction"), "rent");
  assert.equal(requestUrl.searchParams.get("minPrice"), "100");
  assert.equal(requestUrl.searchParams.get("maxPrice"), "1000");
  assert.equal(requestUrl.searchParams.get("minBeds"), "2");
  assert.equal(requestUrl.searchParams.get("minSqm"), "40");
  assert.equal(requestUrl.searchParams.get("maxSqm"), "100");
  assert.equal(result.page, 2);
  assert.equal(result.total, 25);
  assert.equal(result.hasMore, true);
  assert.equal(result.discovered, 1);
});

test("invalid search filters and unsupported country code shapes are rejected", () => {
  assert.equal(unteraSearchSchema.safeParse({ country: "Nigeria" }).success, false);
  assert.equal(unteraSearchSchema.safeParse({ country: "NG", minPrice: 50, maxPrice: 20 }).success, false);
  assert.equal(unteraSearchSchema.safeParse({ country: "NG", minSizeSqm: 50, maxSizeSqm: 20 }).success, false);
});

test("listing normalization keeps absent and unrecognized posters unknown", () => {
  const absent = normalizeUnteraListing({ id: "unknown-1", title: "Listing" });
  const unrecognized = normalizeUnteraListing({ id: "unknown-2", posted_by: "not supplied" });
  const explicitOwner = normalizeUnteraListing({ id: "owner-1", seller_type: "private_owner" });

  assert.equal(absent.posterType, "UNKNOWN");
  assert.match(absent.posterEvidence, /No poster classification/);
  assert.equal(unrecognized.posterType, "UNKNOWN");
  assert.equal(explicitOwner.posterType, "OWNER_UNVERIFIED");
  assert.match(explicitOwner.posterEvidence, /not independently verified/);
  assert.equal(normalizeUnteraListing({ title: "No identifier" }), null);
});

test("contact fields are recognized only when supplied by the provider and safe listing URLs are retained", () => {
  const withoutContact = normalizeUnteraListing({ id: "listing-1", url: "http://example.com/listing" });
  const withContact = normalizeUnteraListing({
    id: "listing-2",
    url: "https://example.com/listing/2",
    contact: { name: "Listing contact", phone: "+2348012345678" },
  });

  assert.equal(withoutContact.url, null);
  assert.equal(withoutContact.contactAvailable, false);
  assert.equal(withContact.url, "https://example.com/listing/2");
  assert.equal(withContact.contactAvailable, true);
  assert.deepEqual(withContact.contact, { name: "Listing contact", phone: "+2348012345678" });
});

test("provider authentication, rate limits, and timeout failures are reported safely", async () => {
  const filters = unteraSearchSchema.parse({ country: "NG" });
  mockFetch(async () => new Response("{}", { status: 401 }));
  await assert.rejects(searchUnteraListings(filters, "key"), (error) => {
    assert.ok(error instanceof UnteraProviderError);
    assert.equal(error.code, "unauthorized");
    return true;
  });

  mockFetch(async () => new Response("{}", { status: 429, headers: { "Retry-After": "12" } }));
  await assert.rejects(searchUnteraListings(filters, "key"), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryAfterSeconds, 12);
    return true;
  });

  mockFetch(async () => {
    const error = new Error("internal network detail");
    error.name = "TimeoutError";
    throw error;
  });
  await assert.rejects(searchUnteraListings(filters, "key"), (error) => {
    assert.equal(error.code, "timeout");
    assert.doesNotMatch(error.message, /internal network detail/);
    return true;
  });
});

test("malformed provider payload is rejected instead of appearing as an empty search", async () => {
  mockFetch(async () => Response.json({ unexpected: [] }));
  await assert.rejects(
    searchUnteraListings(unteraSearchSchema.parse({ country: "NG" }), "key"),
    (error) => error.code === "invalid_response",
  );
});
