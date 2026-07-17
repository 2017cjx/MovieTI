/**
 * POST /api/next-batch — live implementation.
 *
 * Screening phase (Q1-20): always served from the curated fallback pool,
 * randomly, by design (docs/adr/0001, revised 2026-07-15) — no agent/TMDb
 * call at all. A cold-start live agent call (all axis scores at 0) tends to
 * converge on similar popular picks every session; the hand-curated pool
 * guarantees genre/era/region variety from question 1 instead.
 *
 * Deep-dive phase (Q21-80): calls the question-selection agent
 * (functions/api/_lib/agents.ts) to decide TMDb discover params, then
 * queries TMDb for real movies. Falls back to the local fallback pool
 * whenever the agent or TMDb doesn't produce enough usable movies — never a
 * partial/empty batch to the frontend.
 */

import type {
  ApiErrorResponse,
  NextBatchRequest,
  NextBatchResponse,
  QuestionMovie,
  RatedMovie,
} from "../../src/api-types";
import { runHypothesisAgent, runQuestionAgent, type Env as AgentEnv } from "./_lib/agents";
import { getFallbackBatch } from "./_lib/fallback-pool";
import { discoverMovies } from "./_lib/tmdb";

interface Env extends AgentEnv {
  TMDB_ACCESS_TOKEN: string;
}

const NOTABLE_ANSWERS_COUNT = 5;
const SCREENING_QUESTION_COUNT = 20;
// genreWidth's own accuracy depends on era/mainstream already having some
// signal (scoring.ts's leaningMatchedSeen baseline needs an established
// era/mainstream lean to filter against) — below this floor, disallow
// genreWidth as this batch's target_axis. Enforced deterministically here
// rather than left to the LLM's own confidence comparison: a prompt-only
// version of this rule was live-tested (2026-07-17) and found unreliable —
// the model would sometimes explain the rule correctly in its own
// `reasoning` text and then pick genreWidth anyway. See
// makeValidateQuestionAgentOutput in agents.ts for the enforcement side.
const GENRE_WIDTH_DEPENDENCY_FLOOR = 0.3;
// Session-wide franchise cap (Disney/Marvel/Pixar/Lucasfilm), matching
// tmdb.ts's FRANCHISE_CAP_PER_LIST used by the 2 result-screen
// recommendation lists — kept as a separate literal rather than importing
// that constant, since this one is a *session total across ~80 questions*,
// a different unit than "per one list build."
const FRANCHISE_SESSION_CAP = 3;
// Re-run the hypothesis checkpoint every 5 questions through deep_dive (not
// just once at Q21) — a plan formed from only 20 screening answers goes
// stale over the remaining 60 questions, and a periodic refresh lets it
// react to things like a lopsided genre/language mix building up
// (CONTEXT.md "質問選定エージェント" — 2026-07-15, user-requested).
// Tightened from every 10 to every 5 questions (2026-07-15, same day,
// second revision) — with batchSize also 5, this means every single
// deep_dive batch now re-runs the checkpoint, for more frequent
// angle-switching at the cost of one extra LLM call per batch (mostly
// hidden by the prefetch buffer's lookahead).
const HYPOTHESIS_AGENT_INTERVAL = 5;

/** The 3-5 answers that most inform the hypothesis checkpoint: the ones
 *  where the user's rating diverged most from TMDb's crowd average — the
 *  same "surprising" signal src/scoring.ts uses to pick the signature movie. */
function pickNotableAnswers(ratedMoviesSoFar: RatedMovie[]): RatedMovie[] {
  return [...ratedMoviesSoFar]
    .sort(
      (a, b) =>
        Math.abs(b.rating * 2 - b.tmdbVoteAverage) - Math.abs(a.rating * 2 - a.tmdbVoteAverage),
    )
    .slice(0, NOTABLE_ANSWERS_COUNT);
}

/** True on questionNumber 21, 26, 31, ... (assumes batches land on
 *  HYPOTHESIS_AGENT_INTERVAL-question boundaries — but a batch doesn't
 *  always start exactly on one of those boundaries. A page reload resumes
 *  with `initialDispatchedCount` set to however many questions were
 *  answered (an arbitrary number, not necessarily a multiple of
 *  batchSize), which permanently shifts every later fetch's starting
 *  question number off the clean 1/6/11/16/21/... sequence a fresh session
 *  produces. An exact-equality check would then silently never fire again
 *  for the rest of that session (found via browser testing, 2026-07-15).
 *  Fixed two ways: (1) always trigger on the first deep_dive call
 *  regardless of where it lands, since `plan` being unset there is
 *  unambiguous; (2) afterward, trigger if *any* question number this batch
 *  will fill crosses an interval boundary, not just the batch's first
 *  one. */
function isHypothesisCheckpoint(
  phase: NextBatchRequest["phase"],
  questionNumber: number,
  batchSize: number,
  hasPlan: boolean,
): boolean {
  if (phase !== "deep_dive") return false;
  if (!hasPlan) return true;
  for (let q = questionNumber; q < questionNumber + batchSize; q++) {
    if ((q - SCREENING_QUESTION_COUNT - 1) % HYPOTHESIS_AGENT_INTERVAL === 0) return true;
  }
  return false;
}

function isValidRequest(body: unknown): body is NextBatchRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    (b.phase === "screening" || b.phase === "deep_dive") &&
    typeof b.questionNumber === "number" &&
    typeof b.axisScores === "object" &&
    Array.isArray(b.shownMovieIds) &&
    Array.isArray(b.ratedMoviesSoFar)
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
      error: { code: "invalid_request", message: "Request body does not match NextBatchRequest." },
    };
    return Response.json(error, { status: 400 });
  }

  const batchSize = body.batchSize ?? 5;
  const env = context.env;

  // Kicked off before the question-agent/TMDb pipeline below rather than
  // after, so the two run concurrently — they're fully independent (this
  // only needs axisScores + notableAnswers already in the request body),
  // and both now call the same 70B model (2026-07-16, JSON Mode fix).
  // Running them sequentially measured ~22s per deep-dive batch, since
  // isHypothesisCheckpoint is true on every batch at the current interval
  // (HYPOTHESIS_AGENT_INTERVAL === batchSize) — too slow for the
  // interactive quiz flow the prefetch buffer is built around.
  const wantsCheckpoint = isHypothesisCheckpoint(
    body.phase,
    body.questionNumber,
    batchSize,
    body.plan !== undefined,
  );
  const hypothesisPromise = wantsCheckpoint
    ? runHypothesisAgent(
        { axisScores: body.axisScores, notableAnswers: pickNotableAnswers(body.ratedMoviesSoFar) },
        env,
      )
    : null;

  let batch: QuestionMovie[] = [];
  let source: NextBatchResponse["source"];
  let targetAxis: NextBatchResponse["targetAxis"];
  let reasoning: NextBatchResponse["reasoning"];

  if (body.phase === "screening") {
    batch = getFallbackBatch(batchSize, body.shownMovieIds);
    source = "preset";
  } else {
    // Session-wide cap of 3 franchise (Disney/Marvel/Pixar/Lucasfilm)
    // movies across the whole quiz, spread out at most 1 per batch rather
    // than letting one batch use up the whole budget at once (2026-07-17,
    // user feedback — relaxed from the prior hard exclusion, see
    // tmdb.ts's EXCLUDED_COMPANY_IDS comment).
    const franchiseCap =
      (body.franchiseShownCount ?? 0) < FRANCHISE_SESSION_CAP ? 1 : 0;

    // A live contradiction (this batch only) always takes priority over
    // the genreWidth dependency gate — mutually exclusive by construction.
    const disallowedAxis =
      !body.contradiction &&
      (body.axisScores.era.confidence < GENRE_WIDTH_DEPENDENCY_FLOOR ||
        body.axisScores.mainstream.confidence < GENRE_WIDTH_DEPENDENCY_FLOOR)
        ? "genreWidth"
        : undefined;

    const agentResult = await runQuestionAgent(
      {
        phase: body.phase,
        questionNumber: body.questionNumber,
        axisScores: body.axisScores,
        plan: body.plan,
        shownMovieIds: body.shownMovieIds,
        ratedMoviesSoFar: body.ratedMoviesSoFar,
        recentTargetAxes: body.recentTargetAxes ?? [],
        tasteHypothesis: body.tasteHypothesis,
        contradiction: body.contradiction,
        disallowedAxis,
      },
      env,
    );

    let agentBatch: QuestionMovie[] | null = null;
    if (agentResult.source === "agent") {
      try {
        const movies = await discoverMovies(
          agentResult.data.discoverParams,
          env.TMDB_ACCESS_TOKEN,
          body.shownMovieIds,
          batchSize,
          franchiseCap,
        );
        if (movies.length >= batchSize) {
          agentBatch = movies;
        } else {
          // Fewer than requested (thin TMDb result set after filtering) —
          // fall through to the fallback pool rather than serving a short
          // batch. Logged (2026-07-16, E2E validation follow-up) to tell
          // this apart from an agent JSON failure — both show up as
          // source: "fallback" to the client, but only this one implicates
          // discover_params/tmdb.ts guardrails rather than the LLM.
          console.warn(
            `[next-batch] thin TMDb result: got ${movies.length}/${batchSize} for params ${JSON.stringify(agentResult.data.discoverParams)}`,
          );
        }
      } catch (err) {
        console.warn(`[next-batch] TMDb request threw: ${(err as Error).message}`);
      }
    } else {
      console.warn("[next-batch] question-agent JSON validation/timeout failed, using fallback pool");
    }

    if (agentBatch) {
      batch = agentBatch;
      source = "agent";
      targetAxis = agentResult.source === "agent" ? agentResult.data.targetAxis : undefined;
      reasoning = agentResult.source === "agent" ? agentResult.data.reasoning : undefined;
    } else {
      batch = getFallbackBatch(batchSize, body.shownMovieIds);
      source = "fallback";
    }
  }

  const response: NextBatchResponse = { batch, source, targetAxis, reasoning };

  if (hypothesisPromise) {
    const { checkpoint, tasteHypothesis } = await hypothesisPromise;
    response.checkpoint = checkpoint;
    response.tasteHypothesis = tasteHypothesis;
  }

  return Response.json(response);
};
