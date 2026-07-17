/**
 * POST /api/recommend-horizon — live implementation. "Movies that could
 * broaden your horizon" (result screen, docs/adr/0006).
 *
 * Single-phase agent: given the user's 4 axis scores and a pre-filtered,
 * pre-resolved list of genres/languages they've actually seen and rated
 * poorly (CONTEXT.md), decides TMDb `discover/movie` params aimed at the
 * opposite of their established taste. Reuses discoverMovies()
 * (functions/api/_lib/tmdb.ts) exactly as next-batch.ts's deep-dive
 * question flow does, including its existing guardrails (vote_count floor,
 * franchise cap). No AI re-ranking of the results.
 *
 * The "confirmed low affinity" filtering and genre-name-to-id resolution
 * happen here, deterministically, rather than being left to the agent —
 * live-tested 2026-07-17: an earlier version handed the agent raw
 * genre_affinity/language_affinity numbers and asked it to pick a
 * low-rated one and resolve the genre id itself, and the model unreliably
 * both compared the numbers (once called an avg_rating of 4.0 a
 * "dispreference") and hallucinated invalid genre ids. See
 * agents.ts's makeValidateRecommendHorizonOutput for the matching
 * reject-and-retry validation.
 *
 * Fails closed, same reasoning as recommend-similar.ts.
 */

import type {
  ApiErrorResponse,
  RecommendHorizonRequest,
  RecommendHorizonResponse,
  TasteAffinity,
} from "../../src/api-types";
import { runRecommendHorizonAgent, type Env as AgentEnv } from "./_lib/agents";
import {
  discoverMovies,
  FRANCHISE_CAP_PER_LIST,
  getGenreNameToId,
  HORIZON_RELAXED_VOTE_COUNT_FLOOR,
  type DiscoverParams,
} from "./_lib/tmdb";

interface Env extends AgentEnv {
  TMDB_ACCESS_TOKEN: string;
}

// Same reasoning as recommend-similar.ts's CANDIDATE_FETCH_COUNT.
const CANDIDATE_FETCH_COUNT = 10;

// A genre/language counts as a real, confirmed dispreference only with
// this much repeat evidence behind it — a single unlucky pick shouldn't
// brand an entire genre. Absence from the affinity map (never shown at
// all) is handled separately and never counts, regardless of these
// thresholds (see pickConfirmedLowAffinity).
const LOW_AFFINITY_RATING_THRESHOLD = 2.5;
const LOW_AFFINITY_MIN_SEEN_COUNT = 2;

function pickConfirmedLowAffinity(affinity: Record<string, TasteAffinity>): string[] {
  return Object.entries(affinity)
    .filter(
      ([, a]) => a.seenCount >= LOW_AFFINITY_MIN_SEEN_COUNT && a.avgRating <= LOW_AFFINITY_RATING_THRESHOLD,
    )
    .map(([name]) => name);
}

function isValidRequest(body: unknown): body is RecommendHorizonRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.axisScores === "object" &&
    b.axisScores !== null &&
    typeof b.genreAffinity === "object" &&
    b.genreAffinity !== null &&
    typeof b.languageAffinity === "object" &&
    b.languageAffinity !== null &&
    Array.isArray(b.shownMovieIds)
  );
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    const error: ApiErrorResponse = {
      error: { code: "invalid_request", message: "Request body must be valid JSON." },
    };
    return Response.json(error, { status: 400 });
  }

  if (!isValidRequest(body)) {
    const error: ApiErrorResponse = {
      error: {
        code: "invalid_request",
        message: "Request body does not match RecommendHorizonRequest.",
      },
    };
    return Response.json(error, { status: 400 });
  }

  const env = context.env;

  const genreNameToId = await getGenreNameToId(env.TMDB_ACCESS_TOKEN);
  const confirmedLowAffinityGenres = pickConfirmedLowAffinity(body.genreAffinity)
    .map((name) => ({ name, id: genreNameToId.get(name) }))
    .filter((g): g is { name: string; id: number } => g.id !== undefined);
  const confirmedLowAffinityLanguages = pickConfirmedLowAffinity(body.languageAffinity);

  const agentResult = await runRecommendHorizonAgent(
    {
      axisScores: body.axisScores,
      confirmedLowAffinityGenres,
      confirmedLowAffinityLanguages,
    },
    env,
  );

  if (agentResult.source !== "agent") {
    console.warn("[recommend-horizon] agent JSON validation/timeout failed");
    const response: RecommendHorizonResponse = { status: "fallback", movies: null };
    return Response.json(response);
  }

  // Live-tested (2026-07-17): a genre + with_original_language/
  // with_origin_country + era combination the agent judged as a good
  // "opposite corner" pick is sometimes just genuinely thin in TMDb's real
  // catalog (e.g. Horror + Japanese + pre-2005 legitimately returns 0,
  // confirmed directly against TMDb, not a bug — same for niche genres
  // like Documentary, which has only 1 movie at all at the standard 2000
  // vote_count floor vs. 83 at 500). Escalating sequence of relaxation
  // attempts, each dropping/loosening one constraint while keeping the
  // rest, rather than giving up after the agent's exact params come back
  // empty — same "narrow query -> retry broader" resilience
  // discoverMovies() already applies internally for thin pages, just one
  // level up.
  const base = agentResult.data.discoverParams;
  const attempts: Array<{ params: DiscoverParams; voteCountFloor?: number }> = [{ params: base }];
  if (base.with_original_language || base.with_origin_country) {
    const relaxed: DiscoverParams = { ...base };
    delete relaxed.with_original_language;
    delete relaxed.with_origin_country;
    attempts.push({ params: relaxed });
  }
  // Always try the relaxed vote_count floor last, on whichever params
  // variant is currently in play (with or without language/region) — a
  // niche genre can be thin regardless of language.
  attempts.push({
    params: { ...attempts[attempts.length - 1].params },
    voteCountFloor: HORIZON_RELAXED_VOTE_COUNT_FLOOR,
  });

  try {
    for (const attempt of attempts) {
      const movies = await discoverMovies(
        attempt.params,
        env.TMDB_ACCESS_TOKEN,
        body.shownMovieIds,
        CANDIDATE_FETCH_COUNT,
        FRANCHISE_CAP_PER_LIST,
        attempt.voteCountFloor,
      );
      if (movies.length > 0) {
        const response: RecommendHorizonResponse = {
          status: "ok",
          movies,
          reasoning: agentResult.data.reasoning,
        };
        return Response.json(response);
      }
    }

    console.warn(`[recommend-horizon] thin TMDb result even after relaxation: ${JSON.stringify(base)}`);
    const response: RecommendHorizonResponse = { status: "fallback", movies: null };
    return Response.json(response);
  } catch (err) {
    console.warn(`[recommend-horizon] TMDb request threw: ${(err as Error).message}`);
    const response: RecommendHorizonResponse = { status: "fallback", movies: null };
    return Response.json(response);
  }
};
