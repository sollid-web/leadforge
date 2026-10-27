export type MetricBatch = {
  id: string;
  city: string;
  summary?: Record<string, unknown> | null;
};

export type MetricOffer = {
  batch_id: string;
  status: string;
  pricing_mode: string;
  currency?: string;
  price_minor_units?: number;
  offer_sent_at?: string | null;
  responded_at?: string | null;
  paid_at?: string | null;
  delivered_at?: string | null;
  refunded_at?: string | null;
};

export type OfferBucket = {
  offers: number;
  sent: number;
  responses: number;
  interested: number;
  paid: number;
  delivered: number;
  responseRate: number | null;
  interestRate: number | null;
};

function emptyBucket(): OfferBucket {
  return { offers: 0, sent: 0, responses: 0, interested: 0, paid: 0, delivered: 0, responseRate: null, interestRate: null };
}

function countBuckets(offers: MetricOffer[], keysFor: (offer: MetricOffer) => string[]) {
  const buckets = new Map<string, OfferBucket>();
  for (const offer of offers) {
    for (const key of new Set(keysFor(offer).map((value) => value.trim()).filter(Boolean))) {
      const bucket = buckets.get(key) ?? emptyBucket();
      bucket.offers += 1;
      if (offer.offer_sent_at) bucket.sent += 1;
      if (offer.responded_at) bucket.responses += 1;
      if (["interested", "accepted", "paid", "delivered"].includes(offer.status)) bucket.interested += 1;
      if (offer.paid_at) bucket.paid += 1;
      if (offer.delivered_at) bucket.delivered += 1;
      buckets.set(key, bucket);
    }
  }
  for (const bucket of buckets.values()) {
    bucket.responseRate = bucket.sent ? Math.round(bucket.responses * 1000 / bucket.sent) / 10 : null;
    bucket.interestRate = bucket.sent ? Math.round(bucket.interested * 1000 / bucket.sent) / 10 : null;
  }
  return Object.fromEntries([...buckets.entries()].sort(([a], [b]) => a.localeCompare(b, "en")));
}

export function summarizeOfferConversions(offers: MetricOffer[], batches: MetricBatch[]) {
  const batchesById = new Map(batches.map((batch) => [batch.id, batch]));
  const city = countBuckets(offers, (offer) => {
    const value = batchesById.get(offer.batch_id)?.city;
    return value ? [value] : [];
  });
  const offerType = countBuckets(offers, (offer) => [offer.pricing_mode]);
  const sourceCoverage = countBuckets(offers, (offer) => {
    const summary = batchesById.get(offer.batch_id)?.summary;
    const names = summary?.source_coverage;
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  });
  return { city, sourceCoverage, offerType };
}
