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
  /** top-1-2-genre share above this leans Focused (F) rather than Wide (W). */
  GENRE_CONCENTRATION_THRESHOLD: 0.5,
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
  const eraScore = toAxisScore(
    highlyRatedSeen.length > 0 ? eraSum / highlyRatedSeen.length : 0,
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
          average(majorRatings) - average(minorRatings),
          Math.min(majorRatings.length, minorRatings.length),
        )
      : toAxisScore(0, 0);

  // --- GenreWidth (W/F): concentration of top 1-2 genres among highly-rated seen movies. ---
  const genreCounts = new Map<string, number>();
  for (const a of highlyRatedSeen) {
    for (const genre of a.movie.genres) {
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    }
  }
  // Share of genre *tags* (not movies) that the top 1-2 genres account for.
  // Movies commonly carry 2-3 genre tags each, so the denominator must be
  // the total tag count, not highlyRatedSeen.length (movie count) — dividing
  // by movie count let the numerator regularly exceed the denominator
  // (e.g. 3 genre-diverse movies × 3 tags each already sums top-2 to 2/3 of
  // the movie count), pinning the score to -1 (Focused) almost always
  // regardless of actual variety. Bug found 2026-07-15.
  const totalGenreTags = [...genreCounts.values()].reduce((sum, count) => sum + count, 0);
  const topGenreShare =
    totalGenreTags > 0
      ? [...genreCounts.values()]
          .sort((a, b) => b - a)
          .slice(0, SCORING_CONSTANTS.TOP_GENRE_COUNT)
          .reduce((sum, count) => sum + count, 0) / totalGenreTags
      : 0;
  // Positive score leans Wide (low concentration); negative leans Focused.
  const genreWidthScore = toAxisScore(
    (SCORING_CONSTANTS.GENRE_CONCENTRATION_THRESHOLD - topGenreShare) * 2,
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
