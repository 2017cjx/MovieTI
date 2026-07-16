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
  /** Below this many *seen* answers, era/mainstream/genreWidth fall back to
   *  a neutral fixed value instead of a formula-computed score (SPEC.md
   *  2節 edge case, never actually implemented until this constant).
   *  Volume is unaffected — it's computed from the seen/answered ratio over
   *  all 80 questions, so it never runs low on samples the way the other 3
   *  (which only draw from *highly-rated seen* movies, a shrinking subset
   *  of an already-small pool) can. Reuses MIN_SAMPLES_FOR_CONFIDENCE's
   *  value rather than adding a second magic number. Added 2026-07-16: an
   *  E2E validation run (docs/validation-runs/2026-07-16T06-05-23-667Z-e2e.md)
   *  showed low-`seen`-count personas' era/genreWidth scores swinging to a
   *  full ±1 off as few as 1-2 highly-rated movies — not a real signal,
   *  just topGenreShareOf() being trivially ~100%-concentrated on a
   *  1-movie sample. */
  MIN_SEEN_FOR_SIGNAL: 8,
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
  /** True when `seen.length < SCORING_CONSTANTS.MIN_SEEN_FOR_SIGNAL` —
   *  era/mainstream/genreWidth were forced to a neutral {score: 0,
   *  confidence: 0} rather than computed, per SPEC.md 2節's low-signal edge
   *  case. The result screen should show a "reference value only" caveat
   *  when this is true. */
  lowSignal: boolean;
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
  // Baseline: genre concentration across everything seen that matches this
  // person's OWN era/mainstream leaning — not just any seen movie, and not
  // just what was highly rated. The question-selection agent deliberately
  // serves a genre-diverse mix (axis rotation, anti-repetition —
  // CONTEXT.md "質問選定エージェント"), so plain `seen` is not a neutral
  // sample of this person's taste; it's already artificially spread across
  // genres by design. Using a fixed 50% cutoff on `topGenreShare` alone
  // conflates "the exposure pool was diverse" with "this person's taste is
  // wide" — a genuine genre specialist would still end up with a fairly
  // spread `seen` set, since most of what they're shown isn't their
  // preferred genre. Comparing favorites against *this person's own*
  // exposure baseline cancels that out: only a favorites-set that
  // concentrates *more* than what they were simply shown counts as real
  // Focus signal. Found 2026-07-15 via live testing + user's own diagnosis
  // ("まんべんなく出すから結局ワイドになりやすいんじゃない？").
  //
  // That plain-`seen` baseline still isn't a fair counterfactual on its
  // own, though: era and mainstream aren't independent of genre in TMDb's
  // actual catalog (e.g. the moderate-vote-count, well-reviewed band this
  // app's own guardrails draw from — functions/api/_lib/tmdb.ts — skews
  // toward anime and awards dramas). A genre-blind person whose ratings
  // are driven purely by era/mainstream fit will still end up with a
  // genre-concentrated highly-rated set purely as a byproduct of which
  // *other*-axis-testing batches they happened to like — not a genre
  // preference at all. Confirmed against real E2E data 2026-07-16
  // (scripts/genre-width-diagnostic.ts): an HNUW (Wide-intended) persona's
  // highly-rated set was ~47% Drama/Romance, but so was its full exposure
  // pool's *era/mainstream-matching* subset — the plain-`seen` baseline
  // missed this because it averages in movies the person's era/mainstream
  // leaning would never have surfaced favorites from anyway. Restricting
  // the baseline to only the seen movies that share the person's actual
  // era/mainstream leaning makes it an apples-to-apples comparison; falls
  // back to plain `seen` if that subset is empty (too little data to
  // restrict on) or an axis has no signal yet (confidence 0 — don't filter
  // on a leaning that isn't established).
  function matchesLeaning(a: Answer): boolean {
    if (eraScore.confidence > 0) {
      const isRecent = currentYear - a.movie.year <= SCORING_CONSTANTS.ERA_RECENT_YEARS;
      if ((eraScore.score >= 0) !== isRecent) return false;
    }
    if (mainstreamScore.confidence > 0) {
      const isMajor = a.movie.voteCount >= SCORING_CONSTANTS.MAJOR_VOTE_COUNT_THRESHOLD;
      if ((mainstreamScore.score >= 0) !== isMajor) return false;
    }
    return true;
  }
  const leaningMatchedSeen = seen.filter(matchesLeaning);
  const seenTopGenreShare = topGenreShareOf(
    leaningMatchedSeen.length > 0 ? leaningMatchedSeen : seen,
  );
  // Positive delta = favorites concentrate more than the exposure baseline
  // (real Focus signal); zero/negative = favorites are as spread out as
  // what was simply shown (Wide, or no real preference detected).
  const concentrationDelta = topGenreShare - seenTopGenreShare;
  const genreWidthScore = toAxisScore(
    -concentrationDelta / SCORING_CONSTANTS.GENRE_CONCENTRATION_SPREAD,
    highlyRatedSeen.length,
  );

  const lowSignal = seen.length < SCORING_CONSTANTS.MIN_SEEN_FOR_SIGNAL;
  const neutral: AxisScore = { score: 0, confidence: 0 };
  const axisScores: AxisScores = {
    volume: volumeScore,
    era: lowSignal ? neutral : eraScore,
    mainstream: lowSignal ? neutral : mainstreamScore,
    genreWidth: lowSignal ? neutral : genreWidthScore,
  };

  if (!options?.final) {
    return { axisScores, lowSignal };
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

  return { axisScores, lowSignal, typeCode, signatureMovie };
}
