/**
 * Deterministic client-side prep for the two result-screen recommendation
 * lists (docs/adr/0006, CONTEXT.md "おすすめ2リスト"). Both
 * /api/recommend-similar and /api/recommend-horizon need a summary of the
 * user's rated movies as input, but a naive summary drawn evenly from all
 * 80 answers would be dominated by the screening phase (Q1-20), which
 * always draws from the same small, fixed fallback_pool.json — repeating
 * across sessions/users far more than the deep-dive phase (Q21-80, live
 * randomized TMDb selection) does. Both helpers here weight deep-dive
 * answers over screening ones so the two lists vary across quiz retakes
 * instead of converging on the same preset-pool favorites.
 */

import type { RecommendSeed } from "../api-types";
import { SCORING_CONSTANTS } from "../scoring";
import type { Answer } from "../types/answer";

// Duplicated from functions/api/next-batch.ts's own SCREENING_QUESTION_COUNT
// (and useMovieBuffer.ts's DEFAULT_SCREENING_QUESTION_COUNT) rather than
// shared — src/ and functions/ deliberately don't share value imports
// (see agents.ts's RESULT_AXIS_META comment for the same reasoning).
// `answers` is appended in strict question order (useQuizState.ts), so the
// screening/deep-dive boundary is just this fixed index cutoff — no
// per-answer phase metadata needs to be stored.
const SCREENING_QUESTION_COUNT = 20;

function isDeepDiveIndex(index: number): boolean {
  return index >= SCREENING_QUESTION_COUNT;
}

type RatedAnswer = Answer & { rating: number };

function ratedSeenWithIndex(answers: Answer[]): Array<{ answer: RatedAnswer; index: number }> {
  return answers
    .map((answer, index) => ({ answer, index }))
    .filter(
      (x): x is { answer: RatedAnswer; index: number } =>
        x.answer.seen && x.answer.rating !== undefined,
    );
}

const MAX_SEEDS = 5;

/** Up to 5 seed movies for RecommendSimilarRequest.candidateSeeds:
 *  deep-dive-rated movies first (highest rating first), backfilled with
 *  screening-rated ones only if there aren't enough deep-dive ones to fill
 *  5 slots. */
export function pickRecommendSeeds(answers: Answer[]): RecommendSeed[] {
  const byRatingDesc = (
    a: { answer: RatedAnswer },
    b: { answer: RatedAnswer },
  ) => b.answer.rating - a.answer.rating;

  const rated = ratedSeenWithIndex(answers);
  const deepDive = rated.filter((x) => isDeepDiveIndex(x.index)).sort(byRatingDesc);
  const screening = rated.filter((x) => !isDeepDiveIndex(x.index)).sort(byRatingDesc);

  return [...deepDive, ...screening].slice(0, MAX_SEEDS).map(({ answer }) => ({
    tmdbId: answer.movie.tmdbId,
    title: answer.movie.title,
    year: answer.movie.year,
    genres: answer.movie.genres,
    rating: answer.rating,
  }));
}

function tallyBy(answers: Answer[], pick: (a: Answer) => string[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const a of answers) {
    if (!a.seen) continue;
    for (const key of pick(a)) tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

/** genre_coverage/language_coverage for RecommendHorizonRequest: computed
 *  from deep-dive-phase answers only, unless there aren't enough of them to
 *  be a meaningful tally — reuses SCORING_CONSTANTS.MIN_SEEN_FOR_SIGNAL
 *  (the same "enough data" bar scoring.ts already applies for its own
 *  low-signal cutoff) as the threshold, in which case screening answers are
 *  folded back in rather than returning a near-empty tally. */
export function pickCoverageTallies(answers: Answer[]): {
  genreCoverage: Record<string, number>;
  languageCoverage: Record<string, number>;
} {
  const deepDiveSeen = answers.filter((a, index) => isDeepDiveIndex(index) && a.seen);
  const source =
    deepDiveSeen.length >= SCORING_CONSTANTS.MIN_SEEN_FOR_SIGNAL
      ? answers.filter((_a, index) => isDeepDiveIndex(index))
      : answers;

  return {
    genreCoverage: tallyBy(source, (a) => a.movie.genres),
    languageCoverage: tallyBy(source, (a) => [a.movie.originalLanguage]),
  };
}
