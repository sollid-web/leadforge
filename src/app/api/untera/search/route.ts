import { NextResponse } from "next/server";
import { z } from "zod";
import { claimUnteraApiRequest, unteraSearchBlockReason, waitForNextUnteraSlot } from "@/lib/untera-access";
import { getActiveUnteraSource, getUnteraManagerContext } from "@/lib/untera-auth";
import { posterTypeSchema } from "@/lib/providers/types";
import { getUnteraSources, searchUnteraListings, unteraCountriesFromSources, UnteraProviderError, unteraSearchSchema } from "@/lib/providers/untera";

export const runtime = "nodejs";

const searchRequestSchema = z.object({
  sourceId: z.string().uuid(),
  filters: unteraSearchSchema,
  posterFilter: z.union([z.literal("owner_candidates"), posterTypeSchema, z.literal("all")]).default("owner_candidates"),
  sourceName: z.string().trim().max(120).optional(),
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).optional(),
  contactAvailability: z.enum(["any", "available", "unavailable"]).default("any"),
  freshnessDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
});

function safeFilters(input: z.infer<typeof searchRequestSchema>) {
  const { sourceId: _sourceId, ...filters } = input;
  return filters;
}

export async function POST(request: Request) {
  const parsed = searchRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid Untera search filters", details: parsed.error.flatten() }, { status: 400 });
  const context = await getUnteraManagerContext();
  if ("error" in context) return NextResponse.json({ error: context.error }, { status: context.status });
  const blocked = unteraSearchBlockReason();
  if (blocked) return NextResponse.json({ error: blocked, code: "provider_not_configured" }, { status: 503 });
  const sourceResult = await getActiveUnteraSource(context.supabase, context.organizationId, parsed.data.sourceId);
  if (sourceResult.error || !sourceResult.source) {
    return NextResponse.json({ error: sourceResult.error ?? "Untera source is not available." }, { status: 409 });
  }

  const runInsert = await context.admin.from("listing_collection_runs").insert({
    organization_id: context.organizationId,
    source_id: sourceResult.source.id,
    provider: "untera",
    status: "running",
    search_filters: safeFilters(parsed.data),
  }).select("id").single();
  if (runInsert.error || !runInsert.data) return NextResponse.json({ error: "Unable to start an Untera discovery run." }, { status: 500 });
  const runId = runInsert.data.id;
  const startedAt = new Date().toISOString();
  try {
    const registryClaim = await claimUnteraApiRequest(context.admin);
    if (registryClaim.error || !registryClaim.allowed) {
      const message = registryClaim.error
        ? "Unable to apply the Untera API request limit."
        : "Untera API request limit reached. Wait before searching again.";
      await context.admin.from("listing_collection_runs").update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      }).eq("id", runId).eq("organization_id", context.organizationId);
      if (registryClaim.error) return NextResponse.json({ error: message }, { status: 500 });
      return NextResponse.json(
        { error: message, runId, retryAfterSeconds: registryClaim.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(registryClaim.retryAfterSeconds ?? 1) } },
      );
    }
    const supportedCountries = unteraCountriesFromSources(await getUnteraSources(process.env.UNTERA_API_KEY!));
    if (!supportedCountries.some(({ code }) => code === parsed.data.filters.country)) {
      const message = `Untera does not list ${parsed.data.filters.country} in its current supported source registry. Choose a listed country.`;
      const [runUpdate, healthUpdate] = await Promise.all([
        context.admin.from("listing_collection_runs").update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
        }).eq("id", runId).eq("organization_id", context.organizationId),
        context.admin.from("source_health").upsert({
          organization_id: context.organizationId,
          source_id: sourceResult.source.id,
          status: "failed",
          last_checked_at: new Date().toISOString(),
          last_sync_attempt_at: startedAt,
          consecutive_failures: 1,
          message: "Selected country is not currently present in Untera's source registry.",
        }, { onConflict: "source_id" }),
      ]);
      if (runUpdate.error || healthUpdate.error) return NextResponse.json({ error: "Unsupported country was detected, but provider diagnostics could not be recorded.", runId }, { status: 500 });
      return NextResponse.json({ error: message, code: "unsupported_country", supportedCountries }, { status: 422 });
    }
    await waitForNextUnteraSlot();
    const searchClaim = await claimUnteraApiRequest(context.admin);
    if (searchClaim.error || !searchClaim.allowed) {
      const message = searchClaim.error
        ? "Unable to apply the Untera API request limit."
        : "Untera API request limit reached before the listing search. Wait and retry.";
      await context.admin.from("listing_collection_runs").update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      }).eq("id", runId).eq("organization_id", context.organizationId);
      if (searchClaim.error) return NextResponse.json({ error: message }, { status: 500 });
      return NextResponse.json(
        { error: message, runId, retryAfterSeconds: searchClaim.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(searchClaim.retryAfterSeconds ?? 1) } },
      );
    }
    const providerResult = await searchUnteraListings(parsed.data.filters, process.env.UNTERA_API_KEY!);
    const knownPosterCount = providerResult.listings.filter((listing) => listing.posterType !== "UNKNOWN").length;
    const unknownPosterCount = providerResult.listings.length - knownPosterCount;
    const cutoff = parsed.data.freshnessDays
      ? Date.now() - parsed.data.freshnessDays * 24 * 60 * 60 * 1000
      : null;
    const listings = providerResult.listings.filter((listing) => {
      if (parsed.data.posterFilter === "owner_candidates" && !["OWNER_VERIFIED", "OWNER_UNVERIFIED"].includes(listing.posterType)) return false;
      if (parsed.data.posterFilter !== "owner_candidates" && parsed.data.posterFilter !== "all" && listing.posterType !== parsed.data.posterFilter) return false;
      if (parsed.data.sourceName && listing.sourceName?.toLocaleLowerCase("en") !== parsed.data.sourceName.toLocaleLowerCase("en")) return false;
      if (parsed.data.currency && listing.originalCurrency?.toUpperCase() !== parsed.data.currency.toUpperCase()) return false;
      if (parsed.data.contactAvailability === "available" && !listing.contactAvailable) return false;
      if (parsed.data.contactAvailability === "unavailable" && listing.contactAvailable) return false;
      if (cutoff !== null) {
        const date = listing.updatedAt ?? listing.publishedAt;
        if (!date || !Number.isFinite(Date.parse(date)) || Date.parse(date) < cutoff) return false;
      }
      return true;
    });
    const completedAt = new Date().toISOString();
    const status = providerResult.rejected ? "degraded" : "completed";
    const [runUpdate, healthUpdate] = await Promise.all([
      context.admin.from("listing_collection_runs").update({
        status,
        discovered_count: providerResult.discovered,
        rejected_count: providerResult.rejected,
        known_poster_count: knownPosterCount,
        unknown_poster_count: unknownPosterCount,
        contacts_found_count: providerResult.listings.filter((listing) => listing.contactAvailable).length,
        completed_at: completedAt,
      }).eq("id", runId).eq("organization_id", context.organizationId),
      context.admin.from("source_health").upsert({
        organization_id: context.organizationId,
        source_id: sourceResult.source.id,
        status: providerResult.rejected ? "degraded" : "healthy",
        last_checked_at: completedAt,
        last_sync_attempt_at: startedAt,
        last_success_at: completedAt,
        consecutive_failures: 0,
        message: providerResult.rejected ? `${providerResult.rejected} provider records were invalid.` : null,
      }, { onConflict: "source_id" }),
    ]);
    if (runUpdate.error || healthUpdate.error) {
      return NextResponse.json({ error: "Untera returned results, but discovery diagnostics could not be saved.", runId }, { status: 500 });
    }
    const { error: auditError } = await context.admin.from("audit_logs").insert({
      organization_id: context.organizationId,
      actor_id: context.userId,
      action: "source.untera_search_completed",
      entity_type: "listing_source",
      entity_id: sourceResult.source.id,
      metadata: {
        run_id: runId,
        country: parsed.data.filters.country,
        page: providerResult.page,
        results_returned: providerResult.discovered,
        rejected: providerResult.rejected,
        unknown_poster: unknownPosterCount,
      },
    });
    if (auditError) return NextResponse.json({ error: "Untera returned results, but the search audit record could not be saved.", runId }, { status: 500 });

    return NextResponse.json({
      runId,
      provider: "Untera",
      resultsReturned: providerResult.discovered,
      total: providerResult.total ?? null,
      page: providerResult.page,
      pageSize: providerResult.pageSize,
      hasMore: providerResult.hasMore,
      rejected: providerResult.rejected,
      knownPosterCount,
      unknownPosterCount,
      localFiltersApplied: [
        ...(parsed.data.sourceName ? ["Source portal filter applies to this page only; the API does not document server-side source filtering."] : []),
        ...(parsed.data.posterFilter !== "all" ? ["Poster classification filter applies to this page only."] : []),
        ...(parsed.data.currency ? ["Original-currency filter applies to this page only; API price bounds are USD."] : []),
        ...(parsed.data.contactAvailability !== "any" ? ["Contact availability filter applies to this page only."] : []),
        ...(parsed.data.freshnessDays ? ["Freshness filter applies to this page only and requires a provider publication/update date."] : []),
      ],
      data: listings.map(({ contact: _contact, ...listing }) => listing),
      attribution: { text: "Powered by Untera", url: "https://untera.io" },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof UnteraProviderError ? error.message : "Untera search failed. Review provider configuration and retry.";
    const code = error instanceof UnteraProviderError ? error.code : "provider_error";
    const completedAt = new Date().toISOString();
    await Promise.all([
      context.admin.from("listing_collection_runs").update({
        status: "failed",
        error_message: message.slice(0, 500),
        completed_at: completedAt,
      }).eq("id", runId).eq("organization_id", context.organizationId),
      context.admin.from("source_health").upsert({
        organization_id: context.organizationId,
        source_id: sourceResult.source.id,
        status: "failed",
        last_checked_at: completedAt,
        last_sync_attempt_at: startedAt,
        consecutive_failures: 1,
        message: message.slice(0, 500),
      }, { onConflict: "source_id" }),
      context.admin.from("audit_logs").insert({
        organization_id: context.organizationId,
        actor_id: context.userId,
        action: "source.untera_search_failed",
        entity_type: "listing_source",
        entity_id: sourceResult.source.id,
        metadata: { run_id: runId, error_code: code },
      }),
    ]);
    const status = code === "unauthorized" ? 502 : code === "rate_limited" ? 429 : code === "not_found" ? 404 : 502;
    return NextResponse.json({ error: message, code, runId }, {
      status,
      ...(error instanceof UnteraProviderError && error.retryAfterSeconds
        ? { headers: { "Retry-After": String(error.retryAfterSeconds) } }
        : {}),
    });
  }
}
