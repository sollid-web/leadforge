import { NextResponse } from "next/server";
import { z } from "zod";
import { claimUnteraApiRequest, unteraSearchBlockReason, waitForNextUnteraSlot } from "@/lib/untera-access";
import { getUnteraManagerContext } from "@/lib/untera-auth";
import { getUnteraSources, getUnteraStats, unteraCountriesFromSources } from "@/lib/providers/untera";

export const runtime = "nodejs";

export async function GET() {
  const context = await getUnteraManagerContext();
  if ("error" in context) return NextResponse.json({ error: context.error }, { status: context.status });
  const blocked = unteraSearchBlockReason();
  if (blocked) return NextResponse.json({ error: blocked, code: "provider_not_configured" }, { status: 503 });

  const firstClaim = await claimUnteraApiRequest(context.admin);
  if (firstClaim.error) return NextResponse.json({ error: "Unable to apply the Untera API request limit." }, { status: 500 });
  if (!firstClaim.allowed) {
    return NextResponse.json(
      { error: "Untera API rate limit reached. Wait before refreshing provider coverage.", retryAfterSeconds: firstClaim.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(firstClaim.retryAfterSeconds ?? 1) } },
    );
  }

  try {
    const sources = await getUnteraSources(process.env.UNTERA_API_KEY!);
    await waitForNextUnteraSlot();
    const secondClaim = await claimUnteraApiRequest(context.admin);
    if (secondClaim.error) return NextResponse.json({ error: "Unable to apply the Untera API request limit." }, { status: 500 });
    if (!secondClaim.allowed) {
      return NextResponse.json(
        { error: "Provider coverage loaded, but the request limit paused the stats check. Retry shortly.", partial: true, countries: unteraCountriesFromSources(sources), sources },
        { status: 429, headers: { "Retry-After": String(secondClaim.retryAfterSeconds ?? 1) } },
      );
    }
    const stats = await getUnteraStats(process.env.UNTERA_API_KEY!);
    const statsRecord = z.record(z.string(), z.unknown()).safeParse(stats);
    const totals = statsRecord.success
      ? {
        listings: statsRecord.data.listings ?? statsRecord.data.totalListings ?? null,
        sources: statsRecord.data.sources ?? statsRecord.data.totalSources ?? null,
        countries: statsRecord.data.countries ?? statsRecord.data.totalCountries ?? null,
      }
      : null;

    return NextResponse.json({
      provider: "Untera",
      countries: unteraCountriesFromSources(sources),
      sources,
      totals,
      attributionRequired: true,
      links: { attribution: "https://untera.io", terms: "https://untera.io/terms", documentation: "https://untera.io/developers" },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to load Untera provider coverage.",
      code: "provider_error",
    }, { status: 502 });
  }
}
