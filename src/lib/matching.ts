import type { SupabaseClient } from "@supabase/supabase-js";
import { scoreAgentMatch } from "@/lib/opportunities";

type ListingMatchInput = Parameters<typeof scoreAgentMatch>[0] & {
  id: string;
  summary: string;
};

type AgentMatchProfile = Omit<Parameters<typeof scoreAgentMatch>[1], "active"> & {
  agent_id: string;
  display_name: string;
};

export async function saveAgentMatches(
  supabase: SupabaseClient,
  organizationId: string,
  listing: ListingMatchInput,
  profiles: AgentMatchProfile[],
  activeAgentIds: Set<string>,
  limit = 50,
) {
  const ranked = profiles
    .filter((profile) => activeAgentIds.has(profile.agent_id))
    .map((profile) => {
      const result = scoreAgentMatch(listing, { ...profile, active: true });
      return { id: "", agent_id: profile.agent_id, display_name: profile.display_name, score: result.score, reasons: result.reasons };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (!ranked.length) return ranked;
  const { data: savedMatches, error: matchError } = await supabase.from("matches").upsert(
    ranked.map((match) => ({
      organization_id: organizationId,
      listing_id: listing.id,
      agent_id: match.agent_id,
      score: match.score,
      reasons: match.reasons,
    })),
    { onConflict: "listing_id,agent_id" },
  ).select("id,agent_id");
  if (matchError) throw new Error("Unable to save agent matches");

  const matchIds = (savedMatches ?? []).map((match) => match.id);
  const { data: existingNotices, error: noticeQueryError } = matchIds.length
    ? await supabase.from("outreach_messages").select("match_id").eq("channel", "in_app").in("match_id", matchIds)
    : { data: [], error: null };
  if (noticeQueryError) throw new Error("Matches saved but summary notices could not be checked");
  const existingNoticeIds = new Set((existingNotices ?? []).map((notice) => notice.match_id));
  const missingNotices = (savedMatches ?? []).filter((match) => !existingNoticeIds.has(match.id));
  if (missingNotices.length) {
    const { error } = await supabase.from("outreach_messages").insert(missingNotices.map((match) => ({
      organization_id: organizationId,
      match_id: match.id,
      channel: "in_app",
      summary: listing.summary,
      status: "draft",
    })));
    if (error) throw new Error("Matches saved but summary-only notices could not be created");
  }

  const matchIdByAgent = new Map((savedMatches ?? []).map((match) => [match.agent_id, match.id]));
  for (const match of ranked) match.id = matchIdByAgent.get(match.agent_id) ?? "";
  return ranked;
}
