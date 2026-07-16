import type { AxisScore, AxisScores } from "./api-types";
import type { Answer } from "./types/answer";

/**
 * Threshold/tuning constants for axis scoring (docs/adr/0002 — absolute,
 * not session-relative). Placeholder values; SPEC.md 9節 lists tuning
 * against real TMDb data as an open item.
 */
export const SCORING_CONSTANTS = {
  /** TMDb vote_count at/above this counts as "major" for the mainstream axis. */
  MAJOR_VOTE_COUNT_THRESHOLD: 5000,
  /** A movie's release year within this many years of "now" counts as "new". */
  ERA_RECENT_YEARS: 15,
  /** seenCount/answeredCount ratio at which the Volume score is 0 (neither
   *  H nor L). Deliberately low, not 0.5 — most people barely watch movies
   *  at all (Japan's average theatrical attendance is ~1.4 films/year), so
   *  recognizing even a modest slice of an 80-title, partly-niche sample
   *  already marks someone as unusually engaged. A 50%-recognition
   *  threshold made every realistic answerer cluster near score=0 instead
   *  of spreading across the scale — found 2026-07-15 via live testing
   *  ("the indicator always lands in the middle"). */
  VOLUME_NEUTRAL_RATIO: 0.15,
  /** Ratio distance from VOLUME_NEUTRAL_RATIO at which the Volume score
   *  saturates to ±1. E.g. with NEUTRAL=0.15 and SPREAD=0.35, a 50% seen
   *  ratio (40 of 80 questions) already reads as fully Heavy. */
  VOLUME_SPREAD: 0.35,
  /** Fraction-recent distance from 50% at which the Era score saturates to
   *  ±1. Live-verified 2026-07-15 that the real TMDb candidate pool splits
   *  close to 50/50 across the 15-year line, so 50% is the right neutral
   *  point — but the un-scaled formula only reached ±1 at 0%/100% recent,
   *  which almost no one's favorites actually are (real tastes are a mix).
   *  A narrower spread means a real, but not total, lean already reads as
   *  decisive: e.g. 70% recent among your highly-rated movies already
   *  maxes out New, not just "leans new" — found 2026-07-15 via live
   *  testing (same "everything lands near the middle" complaint as
   *  Volume, but here it's the spread, not the anchor, that was off). */
  ERA_SPREAD: 0.2,
  /** Rating-gap (0-1 normalized) between major- and minor-release average
   *  ratings at which the Mainstream score saturates to ±1. The un-scaled
   *  formula needed a full 1.0 gap (e.g. major movies averaging 5/5 while
   *  minor movies average 0/5) to reach ±1 — essentially unreachable, since
   *  real rating gaps between two groups a person actually watched and
   *  rated are naturally much smaller. Found 2026-07-15, same class of fix
   *  as ERA_SPREAD/VOLUME_SPREAD. */
  MAINSTREAM_SPREAD: 0.4,
  /** Distance between the highly-rated top-genre share and this person's
   *  own *seen* top-genre share (their exposure baseline, not a fixed
   *  50%) at which the GenreWidth score saturates to ±1. Replaced the
   *  earlier fixed 50% threshold entirely — 2026-07-15, see the
   *  GenreWidth block in computeScores() for why a per-person baseline is
   *  necessary (the question-selection agent deliberately diversifies what
   *  gets shown, which biased the fixed-threshold version toward Wide for
   *  everyone regardless of actual taste). */
  GENRE_CONCENTRATION_SPREAD: 0.2,
  /** How many highest-frequency genres count toward the "top genre share". */
  TOP_GENRE_COUNT: 2,
  /** A 1-5 star rating at/above this counts as "highly rated" — only
   *  highly-rated seen movies feed the era and genreWidth axes
   *  (CONTEXT.md "軸 (Axis)"). */
  HIGH_RATING_THRESHOLD: 4,
  /** Per-axis sample count at which confidence saturates to 1.0. */
  MIN_SAMPLES_FOR_CONFIDENCE: 8,
} as const;

export interface SignatureMovie {
  movie: Answer["movie"];
  rating: number;
  /** rating normalized to 0-10, minus tmdbVoteAverage; signed. Matches
   *  FlourishRequest["signatureMovie"]["deviation"] in api-types.ts. */
  deviation: number;
}

export interface ComputeScoresResult {
  axisScores: AxisScores;
  /** Only present when `final: true` and there's at least 1 answer. */
  typeCode?: string;
  /** Only present when `final: true` and at least 1 movie was seen+rated. */
  signatureMovie?: SignatureMovie;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Builds one axis's {score, confidence} pair. `raw` need not be pre-clamped. */
function toAxisScore(raw: number, sampleCount: number): AxisScore {
  return {
    score: clamp(raw, -1, 1),
    confidence: clamp(sampleCount / SCORING_CONSTANTS.MIN_SAMPLES_FOR_CONFIDENCE, 0, 1),
  };
}

function average(xs: number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/**
 * Pure, stateless, deterministic. Recomputes from the full answer array on
 * every call (n <= 80 makes incremental/accumulator designs unnecessary
 * complexity — CONTEXT.md "scoring.tsのインターフェース設計"). Called both
 * as provisional scoring after each batch (final omitted) and as the final
 * calculation once all 80 questions are answered (final: true).
 */
export function computeScores(
  answers: Answer[],
  options?: { final?: boolean },
): ComputeScoresResult {
  const currentYear = new Date().getFullYear();
  const seen = answers.filter((a) => a.seen);
  const highlyRatedSeen = seen.filter(
    (a) => (a.rating ?? 0) >= SCORING_CONSTANTS.HIGH_RATING_THRESHOLD,
  );

  // --- Volume (H/L): seen ratio over all answered questions so far. ---
  const volumeRatio = answers.length > 0 ? seen.length / answers.length : 0;
  const volumeScore = toAxisScore(
    (volumeRatio - SCORING_CONSTANTS.VOLUME_NEUTRAL_RATIO) / SCORING_CONSTANTS.VOLUME_SPREAD,
    answers.length,
  );

  // --- Era (N/O): recency of highly-rated seen movies. ---
  const eraSum = highlyRatedSeen.reduce(
    (sum, a) =>
      sum + (currentYear - a.movie.year <= SCORING_CONSTANTS.ERA_RECENT_YEARS ? 1 : -1),
    0,
  );
  // eraSum/n alone is already (fractionRecent - 0.5) * 2 (range -1..1,
  // zero at a 50/50 split) — dividing by 2*ERA_SPREAD rescales so a
  // fractionRecent within ERA_SPREAD of 50/50 stays proportional, but
  // saturates to ±1 well before the unreachable 0%/100% extremes.
  const eraScore = toAxisScore(
    highlyRatedSeen.length > 0
      ? eraSum / highlyRatedSeen.length / (2 * SCORING_CONSTANTS.ERA_SPREAD)
      : 0,
    highlyRatedSeen.length,
  );

  // --- Mainstream (M/U): rating gap between major- and minor-release buckets. ---
  const majorRatings: number[] = [];
  const minorRatings: number[] = [];
  for (const a of seen) {
    if (a.rating === undefined) continue;
    const bucket =
      a.movie.voteCount >= SCORING_CONSTANTS.MAJOR_VOTE_COUNT_THRESHOLD
        ? majorRatings
        : minorRatings;
    bucket.push(a.rating / 5);
  }
  const mainstreamScore =
    majorRatings.length > 0 && minorRatings.length > 0
      ? toAxisScore(
          (average(majorRatings) - average(minorRatings)) / SCORING_CONSTANTS.MAINSTREAM_SPREAD,
          Math.min(majorRatings.length, minorRatings.length),
        )
      : toAxisScore(0, 0);

  // --- GenreWidth (W/F): concentration of top 1-2 genres among highly-rated
  // seen movies, relative to a per-person baseline (not a fixed 50%). ---
  //
  // Share of genre *tags* (not movies) that the top N genres account for.
  // Movies commonly carry 2-3 genre tags each, so the denominator must be
  // the total tag count, not movie count — dividing by movie count let the
  // numerator regularly exceed the denominator (e.g. 3 genre-diverse movies
  // × 3 tags each already sums top-2 to 2/3 of the movie count), pinning
  // the score to -1 (Focused) almost always regardless of actual variety.
  // Bug found 2026-07-15.
  function topGenreShareOf(subset: Answer[]): number {
    const counts = new Map<string, number>();
    for (const a of subset) {
      for (const genre of a.movie.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    return total > 0
      ? [...counts.values()]
          .sort((a, b) => b - a)
          .slice(0, SCORING_CONSTANTS.TOP_GENRE_COUNT)
          .reduce((sum, count) => sum + count, 0) / total
      : 0;
  }
  const topGenreShare = topGenreShareOf(highlyRatedSeen);
  // Baseline: genre concentration across *everything seen*, not just what
  // was highly rated. The question-selection agent deliberately serves a
  // genre-diverse mix (axis rotation, anti-repetition — CONTEXT.md "質問選
  // 定エージェント"), so `seen` is not a neutral sample of this person's
  // taste; it's already artificially spread across genres by design. Using
  // a fixed 50% cutoff on `topGenreShare` alone conflates "the exposure
  // pool was diverse" with "this person's taste is wide" — a genuine genre
  // specialist would still end up with a fairly spread `seen` set, since
  // most of what they're shown isn't their preferred genre. Comparing
  // favorites against *this person's own* exposure baseline cancels that
  // out: only a favorites-set that concentrates *more* than what they were
  // simply shown counts as real Focus signal. Found 2026-07-15 via live
  // testing + user's own diagnosis ("まんべんなく出すから結局ワイドにな
  // りやすいんじゃない？").
  const seenTopGenreShare = topGenreShareOf(seen);
  // Positive delta = favorites concentrate more than the exposure baseline
  // (real Focus signal); zero/negative = favorites are as spread out as
  // what was simply shown (Wide, or no real preference detected).
  const concentrationDelta = topGenreShare - seenTopGenreShare;
  const genreWidthScore = toAxisScore(
    -concentrationDelta / SCORING_CONSTANTS.GENRE_CONCENTRATION_SPREAD,
    highlyRatedSeen.length,
  );

  const axisScores: AxisScores = {
    volume: volumeScore,
    era: eraScore,
    mainstream: mainstreamScore,
    genreWidth: genreWidthScore,
  };

  if (!options?.final) {
    return { axisScores };
  }

  const typeCode =
    (axisScores.volume.score >= 0 ? "H" : "L") +
    (axisScores.era.score >= 0 ? "N" : "O") +
    (axisScores.mainstream.score >= 0 ? "M" : "U") +
    (axisScores.genreWidth.score >= 0 ? "W" : "F");

  const ratedSeen = seen.filter((a): a is Answer & { rating: number } => a.rating !== undefined);
  let signatureMovie: SignatureMovie | undefined;
  for (const a of ratedSeen) {
    const deviation = a.rating * 2 - a.movie.voteAverage;
    if (!signatureMovie || Math.abs(deviation) > Math.abs(signatureMovie.deviation)) {
      signatureMovie = { movie: a.movie, rating: a.rating, deviation };
    }
  }

  return { axisScores, typeCode, signatureMovie };
}
