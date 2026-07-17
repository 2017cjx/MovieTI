/**
 * POST /api/recommend-horizon — live implementation. "Movies that could
 * broaden your horizon" (result screen, docs/adr/0006).
 *
 * Single-phase agent: given the user's 4 axis scores and deep-dive-weighted
 * genre/language coverage (CONTEXT.md), decides TMDb `discover/movie`
 * params aimed at the opposite of their established leaning. Reuses
 * discoverMovies() (functions/api/_lib/tmdb.ts) exactly as next-batch.ts's
 * deep-dive question flow does, including its existing guardrails
 * (vote_count floor, franchise exclusion). No AI re-ranking of the results.
 *
 * Fails closed, same reasoning as recommend-similar.ts.
 */

import type {
  ApiErrorResponse,
  RecommendHorizonRequest,
  RecommendHorizonResponse,
} from "../../src/api-types";
import { runRecommendHorizonAgent, type Env as AgentEnv } from "./_lib/agents";
import { discoverMovies, type DiscoverParams } from "./_lib/tmdb";

interface Env extends AgentEnv {
  TMDB_ACCESS_TOKEN: string;
}

// Same reasoning as recommend-similar.ts's CANDIDATE_FETCH_COUNT.
const CANDIDATE_FETCH_COUNT = 10;

function isValidRequest(body: unknown): body is RecommendHorizonRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.axisScores === "object" &&
    b.axisScores !== null &&
    typeof b.genreCoverage === "object" &&
    b.genreCoverage !== null &&
    typeof b.languageCoverage === "object" &&
    b.languageCoverage !== null &&
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
  const agentResult = await runRecommendHorizonAgent(
    {
      axisScores: body.axisScores,
      genreCoverage: body.genreCoverage,
      languageCoverage: body.languageCoverage,
    },
    env,
  );

  if (agentResult.source !== "agent") {
    console.warn("[recommend-horizon] agent JSON validation/timeout failed");
    const response: RecommendHorizonResponse = { status: "fallback", movies: null };
    return Response.json(response);
  }

  try {
    const movies = await discoverMovies(
      agentResult.data.discoverParams,
      env.TMDB_ACCESS_TOKEN,
      body.shownMovieIds,
      CANDIDATE_FETCH_COUNT,
    );
    if (movies.length > 0) {
      const response: RecommendHorizonResponse = {
        status: "ok",
        movies,
        reasoning: agentResult.data.reasoning,
      };
      return Response.json(response);
    }

    // Live-tested (2026-07-17): a genre + with_original_language/
    // with_origin_country + era combination the agent judged as a good
    // "opposite corner" pick is sometimes just genuinely thin in TMDb's
    // real catalog at the vote_count floor (e.g. Horror + Japanese +
    // pre-2005 legitimately returns 0, confirmed directly against TMDb, not
    // a bug) — language/region is the constraint the prompt itself calls
    // out as "often the single biggest lever," so it's also the one most
    // likely to combine badly with genre+era. One deterministic relaxation
    // retry (drop it, keep everything else) recovers most of these without
    // a second LLM call, same "narrow query -> retry broader" resilience
    // discoverMovies() already applies internally for thin pages.
    if (
      agentResult.data.discoverParams.with_original_language ||
      agentResult.data.discoverParams.with_origin_country
    ) {
      const relaxed: DiscoverParams = { ...agentResult.data.discoverParams };
      delete relaxed.with_original_language;
      delete relaxed.with_origin_country;
      const relaxedMovies = await discoverMovies(
        relaxed,
        env.TMDB_ACCESS_TOKEN,
        body.shownMovieIds,
        CANDIDATE_FETCH_COUNT,
      );
      if (relaxedMovies.length > 0) {
        const response: RecommendHorizonResponse = {
          status: "ok",
          movies: relaxedMovies,
          reasoning: agentResult.data.reasoning,
        };
        return Response.json(response);
      }
    }

    console.warn(
      `[recommend-horizon] thin TMDb result even after relaxation: ${JSON.stringify(agentResult.data.discoverParams)}`,
    );
    const response: RecommendHorizonResponse = { status: "fallback", movies: null };
    return Response.json(response);
  } catch (err) {
    console.warn(`[recommend-horizon] TMDb request threw: ${(err as Error).message}`);
    const response: RecommendHorizonResponse = { status: "fallback", movies: null };
    return Response.json(response);
  }
};
