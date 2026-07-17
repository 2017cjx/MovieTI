/**
 * POST /api/recommend-similar — live implementation. "You might like these
 * movies" (result screen, docs/adr/0006).
 *
 * Single-phase agent: picks 1-2 of the up-to-5 candidate seed movies
 * (already narrowed/ordered client-side) to query TMDb
 * `/movie/{id}/recommendations` with. No AI re-ranking of the TMDb results
 * (ADR 0006 item 8) — returns TMDb's own shuffled candidate set as-is (a
 * display slice of 5 plus a backfill buffer, sliced client-side for
 * cross-list dedup against /api/recommend-horizon).
 *
 * Fails closed: any failure anywhere in the pipeline (agent JSON, TMDb call)
 * returns status: "fallback" with movies: null. Unlike /api/flourish, there
 * is no static fallback content for this list — the frontend omits the
 * whole section rather than substituting anything.
 */

import type {
  ApiErrorResponse,
  RecommendSimilarRequest,
  RecommendSimilarResponse,
} from "../../src/api-types";
import { runRecommendSimilarAgent, type Env as AgentEnv } from "./_lib/agents";
import { getMovieRecommendations } from "./_lib/tmdb";

interface Env extends AgentEnv {
  TMDB_ACCESS_TOKEN: string;
}

// Fetches more than the 5 actually displayed so the frontend has a backfill
// buffer if a movie collides with /api/recommend-horizon's picks (CONTEXT.md
// "除外ルール").
const CANDIDATE_FETCH_COUNT = 10;

function isValidRequest(body: unknown): body is RecommendSimilarRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    Array.isArray(b.candidateSeeds) &&
    b.candidateSeeds.length > 0 &&
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
        message: "Request body does not match RecommendSimilarRequest.",
      },
    };
    return Response.json(error, { status: 400 });
  }

  const env = context.env;
  const agentResult = await runRecommendSimilarAgent(
    { candidateSeeds: body.candidateSeeds, tasteHypothesis: body.tasteHypothesis },
    env,
  );

  if (agentResult.source !== "agent") {
    console.warn("[recommend-similar] agent JSON validation/timeout failed");
    const response: RecommendSimilarResponse = { status: "fallback", movies: null };
    return Response.json(response);
  }

  // A rated movie shouldn't recommend itself back, on top of the
  // already-shown-this-session exclusions.
  const excludeIds = [...body.shownMovieIds, ...body.candidateSeeds.map((s) => s.tmdbId)];

  try {
    const movies = await getMovieRecommendations(
      agentResult.data.selectedTmdbIds,
      env.TMDB_ACCESS_TOKEN,
      excludeIds,
      CANDIDATE_FETCH_COUNT,
    );
    if (movies.length === 0) {
      const response: RecommendSimilarResponse = { status: "fallback", movies: null };
      return Response.json(response);
    }
    const response: RecommendSimilarResponse = {
      status: "ok",
      movies,
      reasoning: agentResult.data.reasoning,
    };
    return Response.json(response);
  } catch (err) {
    console.warn(`[recommend-similar] TMDb request threw: ${(err as Error).message}`);
    const response: RecommendSimilarResponse = { status: "fallback", movies: null };
    return Response.json(response);
  }
};
