import type {
  AxisId,
  AxisScores,
  CheckpointPlan,
  Phase,
  RatedMovie,
  RecommendSeed,
} from "../../../src/api-types";
import {
  HYPOTHESIS_AGENT_PROMPT,
  QUESTION_AGENT_PROMPT,
  RECOMMENDHORIZON_AGENT_PROMPT,
  RECOMMENDSIMILAR_AGENT_PROMPT,
  RESULT_WRITER_PROMPT,
} from "./prompts.generated";
import { runLlmTask, type ValidationResult } from "./llm-task";
import type { DiscoverParams } from "./tmdb";
import { getTypeName } from "./type-descriptions";

export interface Env {
  AI: Ai;
}

// 2026-07-16: tried bumping both agents off llama-3.2-3b-instruct to fix
// their share of the ~19% deep-dive fallback rate found via E2E validation
// (docs/validation-runs/2026-07-16T06-05-23-667Z-e2e.md). 3 things tried,
// all confirmed live via wrangler pages deployment tail rather than
// assumed, all reverted:
//   1. llama-3.1-8b-instruct-fp8 + response_format — rejected every call
//      with `5025: This model doesn't support JSON Schema`, despite the
//      model catalog's schema listing response_format as an accepted
//      field for it.
//   2. llama-3.3-70b-instruct-fp8-fast + response_format — DOES support
//      JSON Mode, but was far too slow for this latency-sensitive path:
//      even after parallelizing the question-agent and hypothesis-agent
//      calls, both routinely hit the 8s per-attempt timeout outright
//      (wallTime 16000 = 2 failed attempts back to back), and successful
//      calls still took 13-29s end to end.
//   3. llama-3.1-8b-instruct-fp8 *without* response_format, hoping the
//      extra size alone would improve zero-shot JSON-following while
//      staying fast — it didn't stay fast. 8B is ~2.7x 3B's parameters,
//      and that alone was enough to push generation time up against the
//      same 8s timeout on Workers AI, independent of response_format.
//      Every model size tried that's big enough to follow JSON reliably
//      has been too slow for a quiz built around instant-feeling taps;
//      only the original 3B stayed comfortably fast. Reliability is worth
//      revisiting later (prompt tightening, more retry budget on the fast
//      model) but not at the cost of a demo that visibly hangs.
const QUESTION_AGENT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const HYPOTHESIS_AGENT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
// Same small structured-output model as the two agents above (docs/adr/0006
// item 4) — both recommend-* agents only ever emit JSON, no user-facing
// prose, so the same "structured output -> small model" split applies.
const RECOMMEND_SIMILAR_AGENT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const RECOMMEND_HORIZON_AGENT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
// Bigger model — the only one of the 3 agents whose output is user-facing
// prose, where quality (not just structured-output reliability) matters
// (docs/adr/0005).
const RESULT_WRITER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const AXIS_ORDER: AxisId[] = ["volume", "era", "mainstream", "genreWidth"];

// Sampling params (2026-07-15) — none of the 3 agents set these before,
// leaving Workers AI's defaults in effect. Left unchecked, the
// question-agent in particular tended toward similar discover_params picks
// across similar inputs (same root cause discussed for movie/genre
// diversity elsewhere this session, just at the token-sampling level
// instead of the TMDb-page-selection level).
//
// Moderate values for the 2 structured-JSON agents: enough temperature to
// avoid always picking the single most likely option, but top_p=0.9 still
// excludes the least-likely tail so JSON validity doesn't degrade further
// (ADR 0005 already documents ~2/3 first-try JSON success without any
// temperature bump; pushing this too high risks making that worse).
const STRUCTURED_SAMPLING = { temperature: 0.8, top_p: 0.9 } as const;
// Higher for the result-writer: free text, no format to break, and this is
// the one agent whose entire job is a fresh, non-repetitive read on the
// person — worth trading a little more randomness for less sameness.
const PROSE_SAMPLING = { temperature: 0.95, top_p: 0.95 } as const;

// prompts/question-agent.md documents its input/output axis keys in
// snake_case (e.g. "genre_width") for prompt readability; src/api-types.ts
// uses camelCase ("genreWidth") for the wire contract. This is the one
// place that translates between the two — deliberate, not a typo.
const AXIS_ID_TO_SNAKE: Record<AxisId, string> = {
  volume: "volume",
  era: "era",
  mainstream: "mainstream",
  genreWidth: "genre_width",
};
const SNAKE_TO_AXIS_ID: Record<string, AxisId> = {
  volume: "volume",
  era: "era",
  mainstream: "mainstream",
  genre_width: "genreWidth",
};

const ALLOWED_DISCOVER_KEYS = new Set([
  "with_genres",
  "primary_release_date.gte",
  "primary_release_date.lte",
  "vote_count.gte",
  "vote_count.lte",
  "vote_average.gte",
  "vote_average.lte",
  "with_original_language",
  "with_origin_country",
  "sort_by",
]);

export interface QuestionAgentOutput {
  targetAxis: AxisId;
  discoverParams: DiscoverParams;
  /** The agent's own free-text explanation (prompts/question-agent.md's
   *  `reasoning` field) — not used for any selection logic, forwarded
   *  purely for client-side console debugging (2026-07-17). */
  reasoning?: string;
}

export type QuestionAgentResult =
  | { source: "agent"; data: QuestionAgentOutput }
  | { source: "fallback" };

function toSnakeAxisScores(axisScores: AxisScores): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(axisScores) as AxisId[]) {
    out[AXIS_ID_TO_SNAKE[id]] = axisScores[id];
  }
  return out;
}

/** Models occasionally wrap JSON in a markdown code fence despite
 *  instructions not to; strip it defensively before parsing. */
function stripCodeFence(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return match ? match[1] : text;
}

function validateQuestionAgentOutput(raw: string): ValidationResult<QuestionAgentOutput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.target_axis !== "string" || !(obj.target_axis in SNAKE_TO_AXIS_ID)) {
    return { ok: false, reason: "missing/invalid target_axis" };
  }
  if (typeof obj.discover_params !== "object" || obj.discover_params === null) {
    return { ok: false, reason: "missing discover_params" };
  }
  const params = obj.discover_params as Record<string, unknown>;
  for (const key of Object.keys(params)) {
    if (!ALLOWED_DISCOVER_KEYS.has(key)) {
      return { ok: false, reason: `disallowed discover_params key: ${key}` };
    }
  }

  return {
    ok: true,
    data: {
      targetAxis: SNAKE_TO_AXIS_ID[obj.target_axis],
      discoverParams: params as DiscoverParams,
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
    },
  };
}

/** How many times each genre has already appeared among rated movies —
 *  passed to the agent so it can spread question genres out rather than
 *  clustering on one genre/franchise for many of the 80 available
 *  questions (e.g. repeatedly reaching for superhero movies to test
 *  "mainstream"). */
function tallyGenreCoverage(ratedMoviesSoFar: RatedMovie[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const movie of ratedMoviesSoFar) {
    for (const genre of movie.genres) {
      tally[genre] = (tally[genre] ?? 0) + 1;
    }
  }
  return tally;
}

/** Same idea as tallyGenreCoverage but by original-language ISO code —
 *  genre tags alone don't distinguish a Hollywood blockbuster from a Hong
 *  Kong or Japanese film in the same genre, so TMDb's popularity-sorted
 *  results otherwise skew heavily English-language/US without this signal
 *  (real gap found 2026-07-15). */
function tallyLanguageCoverage(ratedMoviesSoFar: RatedMovie[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const movie of ratedMoviesSoFar) {
    tally[movie.originalLanguage] = (tally[movie.originalLanguage] ?? 0) + 1;
  }
  return tally;
}

export async function runQuestionAgent(
  input: {
    phase: Phase;
    questionNumber: number;
    axisScores: AxisScores;
    plan?: CheckpointPlan;
    shownMovieIds: number[];
    ratedMoviesSoFar: RatedMovie[];
    recentTargetAxes: AxisId[];
    tasteHypothesis?: string;
  },
  env: Env,
): Promise<QuestionAgentResult> {
  const userMessage = JSON.stringify({
    phase: input.phase,
    question_number: input.questionNumber,
    axis_scores: toSnakeAxisScores(input.axisScores),
    plan: input.plan,
    shown_movie_ids: input.shownMovieIds,
    genre_coverage: tallyGenreCoverage(input.ratedMoviesSoFar),
    language_coverage: tallyLanguageCoverage(input.ratedMoviesSoFar),
    recent_target_axes: input.recentTargetAxes.map((id) => AXIS_ID_TO_SNAKE[id]),
    taste_hypothesis: input.tasteHypothesis,
  });

  const result = await runLlmTask<QuestionAgentOutput, undefined>({
    call: async () => {
      const res = await env.AI.run(QUESTION_AGENT_MODEL, {
        messages: [
          { role: "system", content: QUESTION_AGENT_PROMPT },
          { role: "user", content: userMessage },
        ],
        ...STRUCTURED_SAMPLING,
      });
      const response = (res as { response: unknown }).response;
      return typeof response === "string" ? response : JSON.stringify(response);
    },
    validate: validateQuestionAgentOutput,
    fallback: () => undefined,
    // 3 instead of the default 2 (2026-07-16, fallback-rate follow-up) —
    // llama-3.2-3b-instruct calls measured ~1.1-1.3s each under normal
    // (non-contended) load, so a 3rd attempt costs little, and most
    // failures are near-instant validation rejections (bad JSON), not
    // actual timeouts, so this doesn't meaningfully raise the worst case.
    maxAttempts: 3,
  });

  return result.source === "agent" ? { source: "agent", data: result.data } : { source: "fallback" };
}

// ---------------------------------------------------------------------------
// Hypothesis agent (periodic deep_dive checkpoint, first run at Q21)
// ---------------------------------------------------------------------------

interface HypothesisAgentOutput {
  plans: Partial<Record<AxisId, string>>;
  tasteHypothesis: string;
}

/** Only the `plan` strings and `taste_hypothesis` — score/confidence are
 *  never trusted from the LLM's echo, even though the prompt instructs it
 *  to copy them verbatim (prompts/hypothesis-agent.md). The caller always
 *  merges the plan strings onto the axisScores it already has from the
 *  request, per the "LLM never recomputes scoring numbers" principle
 *  (CONTEXT.md "scoring.tsのインターフェース設計"). */
function validateHypothesisAgentOutput(raw: string): ValidationResult<HypothesisAgentOutput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  const plans: Partial<Record<AxisId, string>> = {};
  for (const snakeKey of Object.keys(SNAKE_TO_AXIS_ID)) {
    const entry = obj[snakeKey];
    if (typeof entry === "object" && entry !== null && typeof (entry as { plan?: unknown }).plan === "string") {
      plans[SNAKE_TO_AXIS_ID[snakeKey]] = (entry as { plan: string }).plan;
    }
  }
  if (Object.keys(plans).length < AXIS_ORDER.length) {
    return { ok: false, reason: "missing plan for one or more axes" };
  }
  if (typeof obj.taste_hypothesis !== "string" || obj.taste_hypothesis.length === 0) {
    return { ok: false, reason: "missing taste_hypothesis" };
  }
  return { ok: true, data: { plans, tasteHypothesis: obj.taste_hypothesis } };
}

function genericPlan(axisId: AxisId, axisScores: AxisScores): string {
  const confidence = axisScores[axisId].confidence;
  return confidence >= 0.5
    ? "Trend looks reasonably clear; keep confirming with a couple more titles."
    : "Confidence is still low on this axis; prioritize testing it further.";
}

const GENERIC_TASTE_HYPOTHESIS =
  "No specific taste theory yet — keep picking movies on axis signal alone.";

/** Runs on the first deep_dive request, then periodically again every 10
 *  questions (see functions/api/next-batch.ts's isHypothesisCheckpoint).
 *  Always returns a complete CheckpointPlan built from the REAL axisScores
 *  the caller already computed — LLM failure only degrades the `plan`/
 *  `tasteHypothesis` text to a generic message, never blocks the response
 *  (this checkpoint is not user-facing and must not stall the quiz). */
export async function runHypothesisAgent(
  input: { axisScores: AxisScores; notableAnswers: RatedMovie[] },
  env: Env,
): Promise<{ checkpoint: CheckpointPlan; tasteHypothesis: string }> {
  const userMessage = JSON.stringify({
    axis_scores: toSnakeAxisScores(input.axisScores),
    notable_answers: input.notableAnswers.map((m) => ({
      title: m.title,
      year: m.year,
      genres: m.genres,
      vote_count: m.voteCount,
      seen: true,
      rating: m.rating,
    })),
  });

  const result = await runLlmTask<HypothesisAgentOutput, undefined>({
    call: async () => {
      const res = await env.AI.run(HYPOTHESIS_AGENT_MODEL, {
        messages: [
          { role: "system", content: HYPOTHESIS_AGENT_PROMPT },
          { role: "user", content: userMessage },
        ],
        ...STRUCTURED_SAMPLING,
      });
      const response = (res as { response: unknown }).response;
      return typeof response === "string" ? response : JSON.stringify(response);
    },
    validate: validateHypothesisAgentOutput,
    fallback: () => undefined,
    maxAttempts: 3, // same reasoning as the question-agent above
  });

  const plans = result.source === "agent" ? result.data.plans : {};
  const checkpoint = {} as CheckpointPlan;
  for (const axisId of AXIS_ORDER) {
    checkpoint[axisId] = {
      ...input.axisScores[axisId],
      plan: plans[axisId] ?? genericPlan(axisId, input.axisScores),
    };
  }
  const tasteHypothesis =
    result.source === "agent" ? result.data.tasteHypothesis : GENERIC_TASTE_HYPOTHESIS;
  return { checkpoint, tasteHypothesis };
}

// ---------------------------------------------------------------------------
// Result writer (POST /api/flourish) — the only agent whose output is
// shown directly to the user (prompts/result-writer.md "cinema therapist"
// persona).
// ---------------------------------------------------------------------------

interface ResultWriterMovie {
  title: string;
  year: number;
  genres: string[];
  rating: number;
  tmdbVoteAverage: number;
}

// Human-readable framing for the 4 axes, duplicated from the frontend's
// AXIS_META (src/ResultScreen.tsx) — deliberately, since a value import
// from src/ into functions/ would drag React along. Only used to build the
// result-writer's axis_summary input.
const RESULT_AXIS_META: Record<AxisId, { name: string; labels: [string, string] }> = {
  volume: { name: "Volume", labels: ["light viewer", "heavy viewer"] },
  era: { name: "Era", labels: ["old-leaning", "new-leaning"] },
  mainstream: { name: "Mainstream", labels: ["underground-leaning", "mainstream-leaning"] },
  genreWidth: { name: "Genre width", labels: ["focused", "wide-ranging"] },
};

/** Translates the raw {score, confidence} per axis into a form the
 *  result-writer prompt can reason about directly, so the model doesn't
 *  have to re-derive the sign convention itself: `strength` is how far
 *  toward that leaning (0 = barely, 1 = strongly), `confidence` is how
 *  much evidence backs it (0 = little, 1 = a lot) — both meant to
 *  calibrate how decisively the model should phrase that axis. */
function buildAxisSummary(axisScores: AxisScores) {
  return AXIS_ORDER.map((id) => {
    const { score, confidence } = axisScores[id];
    const meta = RESULT_AXIS_META[id];
    return {
      axis: meta.name,
      leaning: score >= 0 ? meta.labels[1] : meta.labels[0],
      strength: Number(Math.abs(score).toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
    };
  });
}

function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// Catches the clearest cases of the LLM leaking the internal 1-5 rating
// scale into user-facing text (e.g. "a perfect 5", "rated it 2/5") — the
// app only ever shows icons (✕/−/✓/★) to the user, never a number, and
// this happened in testing 2026-07-15 despite the prompt already saying
// not to. A backstop, not a substitute for the prompt instruction: doesn't
// try to catch every phrasing, just the literal "digit as a rating" tell.
const RAW_RATING_PATTERN = /\b(a|as a|rated it a?)\s*(perfect\s*)?[1-5]\s*(\/\s*5|out of 5)?\b/i;

/** Plain text, not JSON — validated by content constraints
 *  (prompts/result-writer.md), not a schema. `movieTitles` closes over the
 *  actual titles sent in, so the "must name a movie" constraint checks
 *  against real data, not a guess. */
// The prompt asks for a short, sayable-out-loud script, roughly 50-100
// words — revised 2026-07-15 (second revision same day) from an earlier
// 90-160-word "witty observation" brief, per feedback that the result
// screen should give the user something they can literally recite when
// someone asks "what movies do you like?", not just a comment about them.
// These bounds are padding around that target, not the target itself.
const MIN_WORDS = 35;
const MAX_WORDS = 150;

function makeValidateResultWriterOutput(
  movieTitles: string[],
): (raw: string) => ValidationResult<string> {
  return (raw) => {
    const text = stripWrappingQuotes(stripCodeFence(raw));
    if (text.length === 0) return { ok: false, reason: "empty" };
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS) return { ok: false, reason: `too short (< ${MIN_WORDS} words)` };
    if (wordCount > MAX_WORDS) return { ok: false, reason: `too long (> ${MAX_WORDS} words)` };
    if (!movieTitles.some((title) => text.includes(title))) {
      return { ok: false, reason: "does not mention any given movie title" };
    }
    if (RAW_RATING_PATTERN.test(text)) {
      return { ok: false, reason: "leaks the raw numeric rating" };
    }
    return { ok: true, data: text };
  };
}

export async function runResultWriter(
  input: {
    typeCode: string;
    axisScores: AxisScores;
    topRatedMovies: ResultWriterMovie[];
    signatureMovie: ResultWriterMovie & { deviation: number };
    tasteHypothesis?: string;
  },
  env: Env,
): Promise<{ status: "ok" | "fallback"; comment: string | null }> {
  const userMessage = JSON.stringify({
    type_code: input.typeCode,
    type_name: getTypeName(input.typeCode),
    axis_summary: buildAxisSummary(input.axisScores),
    top_rated_movies: input.topRatedMovies.map((m) => ({
      title: m.title,
      year: m.year,
      genres: m.genres,
      user_rating: m.rating,
      tmdb_vote_average: m.tmdbVoteAverage,
    })),
    signature_movie: {
      title: input.signatureMovie.title,
      year: input.signatureMovie.year,
      genres: input.signatureMovie.genres,
      user_rating: input.signatureMovie.rating,
      tmdb_vote_average: input.signatureMovie.tmdbVoteAverage,
    },
    taste_hypothesis: input.tasteHypothesis,
  });

  const movieTitles = [input.signatureMovie.title, ...input.topRatedMovies.map((m) => m.title)];

  const result = await runLlmTask<string, undefined>({
    call: async () => {
      const res = await env.AI.run(RESULT_WRITER_MODEL, {
        messages: [
          { role: "system", content: RESULT_WRITER_PROMPT },
          { role: "user", content: userMessage },
        ],
        ...PROSE_SAMPLING,
      });
      const response = (res as { response: unknown }).response;
      return typeof response === "string" ? response : JSON.stringify(response);
    },
    validate: makeValidateResultWriterOutput(movieTitles),
    fallback: () => undefined,
    // Prose quality matters more than JSON validity here, and a 70B model
    // is slower than the 3B ones — a bit more room before giving up.
    timeoutMs: 12000,
  });

  return result.source === "agent"
    ? { status: "ok", comment: result.data }
    : { status: "fallback", comment: null };
}

// ---------------------------------------------------------------------------
// Recommend-similar agent (POST /api/recommend-similar) — "You might like
// these movies". Single phase (docs/adr/0006, revised same-day from an
// initial 2-phase design): picks which 1-2 of an already-narrowed candidate
// list to query TMDb `/recommendations` with. Never re-ranks TMDb's
// results afterward — functions/api/recommend-similar.ts uses whatever
// getMovieRecommendations() returns as-is.
// ---------------------------------------------------------------------------

export interface RecommendSimilarAgentOutput {
  selectedTmdbIds: number[];
  /** Debugging aid only (2026-07-17) — see QuestionAgentOutput.reasoning. */
  reasoning?: string;
}

export type RecommendSimilarAgentResult =
  | { source: "agent"; data: RecommendSimilarAgentOutput }
  | { source: "fallback" };

/** At most this many seeds get queried against TMDb /recommendations — the
 *  agent's whole point is narrowing "up to 5 candidates" down to the ones
 *  that best represent overall taste, not just deferring that choice to
 *  more TMDb calls. */
const MAX_SELECTED_SEEDS = 2;

function makeValidateRecommendSimilarOutput(
  candidateIds: number[],
): (raw: string) => ValidationResult<RecommendSimilarAgentOutput> {
  const allowed = new Set(candidateIds);
  return (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch {
      return { ok: false, reason: "not valid JSON" };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "not a JSON object" };
    }
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.selected_tmdb_ids) || obj.selected_tmdb_ids.length === 0) {
      return { ok: false, reason: "missing/empty selected_tmdb_ids" };
    }
    // Never trust an LLM-emitted id at face value — it must be one of the
    // ids actually offered as a candidate, same defensive posture as
    // validateQuestionAgentOutput's ALLOWED_DISCOVER_KEYS check.
    const ids = obj.selected_tmdb_ids.filter(
      (id): id is number => typeof id === "number" && allowed.has(id),
    );
    if (ids.length === 0) {
      return { ok: false, reason: "no selected_tmdb_ids matched the given candidates" };
    }
    return {
      ok: true,
      data: {
        selectedTmdbIds: ids.slice(0, MAX_SELECTED_SEEDS),
        reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
      },
    };
  };
}

export async function runRecommendSimilarAgent(
  input: { candidateSeeds: RecommendSeed[]; tasteHypothesis?: string },
  env: Env,
): Promise<RecommendSimilarAgentResult> {
  const userMessage = JSON.stringify({
    candidate_seeds: input.candidateSeeds.map((s) => ({
      tmdb_id: s.tmdbId,
      title: s.title,
      year: s.year,
      genres: s.genres,
      user_rating: s.rating,
    })),
    taste_hypothesis: input.tasteHypothesis,
  });

  const result = await runLlmTask<RecommendSimilarAgentOutput, undefined>({
    call: async () => {
      const res = await env.AI.run(RECOMMEND_SIMILAR_AGENT_MODEL, {
        messages: [
          { role: "system", content: RECOMMENDSIMILAR_AGENT_PROMPT },
          { role: "user", content: userMessage },
        ],
        ...STRUCTURED_SAMPLING,
      });
      const response = (res as { response: unknown }).response;
      return typeof response === "string" ? response : JSON.stringify(response);
    },
    validate: makeValidateRecommendSimilarOutput(input.candidateSeeds.map((s) => s.tmdbId)),
    fallback: () => undefined,
    maxAttempts: 3, // same reasoning as the question-agent above
  });

  return result.source === "agent"
    ? { source: "agent", data: result.data }
    : { source: "fallback" };
}

// ---------------------------------------------------------------------------
// Recommend-horizon agent (POST /api/recommend-horizon) — "Movies that
// could broaden your horizon". Single phase, same shape as the
// recommend-similar agent above: decides TMDb discover_params, never sees
// or re-ranks the TMDb results.
// ---------------------------------------------------------------------------

export interface RecommendHorizonAgentOutput {
  discoverParams: DiscoverParams;
  /** Debugging aid only (2026-07-17) — see QuestionAgentOutput.reasoning. */
  reasoning?: string;
}

export type RecommendHorizonAgentResult =
  | { source: "agent"; data: RecommendHorizonAgentOutput }
  | { source: "fallback" };

/** Reuses the exact same discover_params validation shape as
 *  validateQuestionAgentOutput (same ALLOWED_DISCOVER_KEYS allowlist) — this
 *  agent has no target_axis field, since it deliberately targets multiple
 *  axes' opposite poles at once rather than one axis at a time. */
function validateRecommendHorizonOutput(raw: string): ValidationResult<RecommendHorizonAgentOutput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.discover_params !== "object" || obj.discover_params === null) {
    return { ok: false, reason: "missing discover_params" };
  }
  const params = obj.discover_params as Record<string, unknown>;
  for (const key of Object.keys(params)) {
    if (!ALLOWED_DISCOVER_KEYS.has(key)) {
      return { ok: false, reason: `disallowed discover_params key: ${key}` };
    }
  }
  return {
    ok: true,
    data: {
      discoverParams: params as DiscoverParams,
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
    },
  };
}

export async function runRecommendHorizonAgent(
  input: {
    axisScores: AxisScores;
    genreCoverage: Record<string, number>;
    languageCoverage: Record<string, number>;
  },
  env: Env,
): Promise<RecommendHorizonAgentResult> {
  const userMessage = JSON.stringify({
    axis_scores: toSnakeAxisScores(input.axisScores),
    genre_coverage: input.genreCoverage,
    language_coverage: input.languageCoverage,
  });

  const result = await runLlmTask<RecommendHorizonAgentOutput, undefined>({
    call: async () => {
      const res = await env.AI.run(RECOMMEND_HORIZON_AGENT_MODEL, {
        messages: [
          { role: "system", content: RECOMMENDHORIZON_AGENT_PROMPT },
          { role: "user", content: userMessage },
        ],
        ...STRUCTURED_SAMPLING,
      });
      const response = (res as { response: unknown }).response;
      return typeof response === "string" ? response : JSON.stringify(response);
    },
    validate: validateRecommendHorizonOutput,
    fallback: () => undefined,
    maxAttempts: 3, // same reasoning as the question-agent above
  });

  return result.source === "agent"
    ? { source: "agent", data: result.data }
    : { source: "fallback" };
}
