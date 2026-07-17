/**
 * Detects when the most recently rated movie contradicts an already
 * well-established axis lean — e.g. a strongly Underground-leaning person
 * just Super Liking an extremely mainstream blockbuster. Mirrors the
 * grilling skill's "probe the surprising answer immediately" principle
 * (2026-07-17, user-requested): feeds into the question-agent as a hint to
 * prioritize verifying this specific surprise on the very next batch,
 * rather than waiting for the next scheduled hypothesis check-in
 * (currently every 5 questions in deep_dive).
 *
 * Only fires on era/mainstream — the 2 axes with a clear, deterministic
 * per-movie criterion (a single movie's own year/vote_count either matches
 * the established lean or it doesn't). genreWidth is an *aggregate*
 * concentration property (scoring.ts compares a whole highly-rated set
 * against a baseline set) with no single-movie contradiction concept, and
 * volume is a seen/answered ratio, not a per-movie property — neither fits
 * this detector. Only fires on a positive rating (>= HIGH_RATING_THRESHOLD):
 * a low rating that "should" have fit the lean is also arguably a
 * contradiction worth probing, but that's left as a possible future
 * extension rather than in scope here.
 */

import type { AxisScores, Contradiction } from "../api-types";
import { SCORING_CONSTANTS } from "../scoring";
import type { Answer } from "../types/answer";

export type { Contradiction };

/** How confident an axis lean must already be before a single movie can
 *  "contradict" it — chasing a barely-established lean (still mostly
 *  noise) would just be reacting to randomness, not a real surprise. */
const CONTRADICTION_CONFIDENCE_FLOOR = 0.5;

function toMovieSummary(answer: Answer & { rating: number }): Contradiction["movie"] {
  return {
    title: answer.movie.title,
    year: answer.movie.year,
    genres: answer.movie.genres,
    voteCount: answer.movie.voteCount,
  };
}

/** `axisScoresBeforeLatestAnswer` must be computed from all answers except
 *  the latest one — the point is comparing the new answer against the
 *  lean that was already established *before* it arrived, not a lean that
 *  already includes it. */
export function detectContradiction(
  latestAnswer: Answer,
  axisScoresBeforeLatestAnswer: AxisScores,
): Contradiction | null {
  if (!latestAnswer.seen || latestAnswer.rating === undefined) return null;
  if (latestAnswer.rating < SCORING_CONSTANTS.HIGH_RATING_THRESHOLD) return null;
  const rated = latestAnswer as Answer & { rating: number };

  const currentYear = new Date().getFullYear();
  const { era, mainstream } = axisScoresBeforeLatestAnswer;

  if (era.confidence >= CONTRADICTION_CONFIDENCE_FLOOR) {
    const isRecent = currentYear - rated.movie.year <= SCORING_CONSTANTS.ERA_RECENT_YEARS;
    if ((era.score >= 0) !== isRecent) {
      return { axis: "era", movie: toMovieSummary(rated) };
    }
  }
  if (mainstream.confidence >= CONTRADICTION_CONFIDENCE_FLOOR) {
    const isMajor = rated.movie.voteCount >= SCORING_CONSTANTS.MAJOR_VOTE_COUNT_THRESHOLD;
    if ((mainstream.score >= 0) !== isMajor) {
      return { axis: "mainstream", movie: toMovieSummary(rated) };
    }
  }
  return null;
}
