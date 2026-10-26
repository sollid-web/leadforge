import type { SupabaseClient } from "@supabase/supabase-js";

export function unteraConfiguration() {
  return {
    apiKeyConfigured: Boolean(process.env.UNTERA_API_KEY),
    commercialUseAuthorized: process.env.UNTERA_COMMERCIAL_USE_AUTHORIZED === "true",
    listingReuseAuthorized: process.env.UNTERA_LISTING_REUSE_AUTHORIZED === "true",
  };
}

export function unteraSearchBlockReason() {
  const config = unteraConfiguration();
  if (!config.apiKeyConfigured) return "Untera is not configured: add the server-only UNTERA_API_KEY.";
  if (!config.commercialUseAuthorized) {
    return "Untera search is disabled until your plan and written provider terms authorize commercial use in this app. The free tier is documented for prototypes, research, and side projects.";
  }
  return null;
}

export function unteraPersistenceBlockReason() {
  const searchReason = unteraSearchBlockReason();
  if (searchReason) return searchReason;
  if (process.env.UNTERA_LISTING_REUSE_AUTHORIZED !== "true") {
    return "Saving is disabled until Untera confirms in writing that your plan permits retaining and redistributing these listing records as leads.";
  }
  return null;
}

export async function claimUnteraApiRequest(admin: SupabaseClient) {
  const { data, error } = await admin.rpc("claim_untera_api_request");
  if (error) return { allowed: false, retryAfterSeconds: null, error };
  const claim = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(claim?.allowed),
    retryAfterSeconds: typeof claim?.retry_after_seconds === "number" ? claim.retry_after_seconds : 1,
    error: null,
  };
}

export async function waitForNextUnteraSlot() {
  await new Promise((resolve) => setTimeout(resolve, 4_100));
}
