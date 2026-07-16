/**
 * Pure unit tests for the low-signal / genreWidth-baseline logic in
 * src/scoring.ts (added 2026-07-16 during /review-fix — that logic had no
 * repeatable regression coverage, only live E2E scripts against real
 * network calls, which are non-deterministic and expensive to run on every
 * change). No framework: this repo has none wired up (see package.json),
 * so this follows the same node-direct-execution pattern as
 * scripts/e2e-persona-validation.ts and scripts/genre-width-diagnostic.ts
 * rather than introducing one. Exits non-zero on any failure so it can be
 * wired into CI later without changes.
 *
 * Usage:
 *   node --experimental-strip-types scripts/scoring-unit-test.ts
 */

import { computeScores, SCORING_CONSTANTS } from "../src/scoring.ts";
import type { Answer } from "../src/types/answer.ts";

let failures = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function mkAnswer(
  id: number,
  year: number,
  voteCount: number,
  genres: string[],
  seen: boolean,
  rating?: number,
): Answer {
  return {
    movie: {
      tmdbId: id,
      title: `M${id}`,
      year,
      posterPath: null,
      genres,
      voteCount,
      voteAverage: 7,
      originalLanguage: "en",
    },
    seen,
    rating,
  };
}

const CURRENT_YEAR = new Date().getFullYear();
const RECENT_YEAR = CURRENT_YEAR - 2;
const OLD_YEAR = CURRENT_YEAR - 30;
const MAJOR_VOTES = SCORING_CONSTANTS.MAJOR_VOTE_COUNT_THRESHOLD + 5000;
const MINOR_VOTES = SCORING_CONSTANTS.MAJOR_VOTE_COUNT_THRESHOLD - 1000;

// --- Test 1: lowSignal triggers below MIN_SEEN_FOR_SIGNAL and forces
// era/mainstream/genreWidth to neutral, leaving volume alone. ---
console.log("Test 1: lowSignal forces neutral axes below the seen-count floor");
{
  const answers: Answer[] = [
    mkAnswer(1, RECENT_YEAR, MAJOR_VOTES, ["Drama"], true, 5),
    mkAnswer(2, RECENT_YEAR, MAJOR_VOTES, ["Comedy"], true, 5),
    mkAnswer(3, OLD_YEAR, MINOR_VOTES, ["Horror"], false),
  ];
  const result = computeScores(answers, { final: true });
  assert("lowSignal is true", result.lowSignal === true);
  assert("era forced neutral", result.axisScores.era.score === 0 && result.axisScores.era.confidence === 0);
  assert(
    "mainstream forced neutral",
    result.axisScores.mainstream.score === 0 && result.axisScores.mainstream.confidence === 0,
  );
  assert(
    "genreWidth forced neutral",
    result.axisScores.genreWidth.score === 0 && result.axisScores.genreWidth.confidence === 0,
  );
  assert("volume NOT forced neutral", result.axisScores.volume.confidence > 0);
}

// --- Test 2: above the floor, lowSignal is false and axes compute normally. ---
console.log("Test 2: lowSignal is false at/above the seen-count floor");
{
  const answers: Answer[] = Array.from({ length: SCORING_CONSTANTS.MIN_SEEN_FOR_SIGNAL }, (_, i) =>
    mkAnswer(i, RECENT_YEAR, MAJOR_VOTES, ["Drama"], true, 5),
  );
  const result = computeScores(answers, { final: true });
  assert("lowSignal is false", result.lowSignal === false);
}

// --- Test 3: genreWidth leaning-matched baseline — a genre-blind persona
// (rating driven only by era+mainstream fit, genre uncorrelated with
// rating) whose exposure pool skews toward one genre within their own
// era/mainstream leaning should NOT read as falsely Focused. This is the
// exact confound found via scripts/genre-width-diagnostic.ts against live
// data (docs/validation-runs — HOUW/HOMW/HNUW/HNMF mismatches). ---
console.log("Test 3: genreWidth baseline resists the era/mainstream-correlated-genre confound");
{
  const answers: Answer[] = [];
  let id = 0;
  // Exposure pool: all recent+major (so era/mainstream leaning is
  // unambiguous), genre skewed toward Drama regardless of rating — genre
  // has ZERO correlation with whether a movie gets a high rating.
  const genreCycle = ["Drama", "Drama", "Drama", "Comedy", "Action"];
  for (let i = 0; i < 20; i++) {
    const genres = [genreCycle[i % genreCycle.length]];
    // Rating alternates high/low independent of genre — a genre-blind
    // persona's actual behavior.
    const rating = i % 2 === 0 ? 5 : 2;
    answers.push(mkAnswer(id++, RECENT_YEAR, MAJOR_VOTES, genres, true, rating));
  }
  const result = computeScores(answers, { final: true });
  assert(
    "genreWidth reads as Wide (score >= 0), not falsely Focused",
    result.axisScores.genreWidth.score >= 0,
    `got ${result.axisScores.genreWidth.score.toFixed(3)}`,
  );
}

// --- Test 4: sample-size guard — a genuinely Focused persona (rating IS
// genre-driven) should still read as Focused even when the leaning-matched
// subset is small (falls back to plain `seen`, per the guard added
// alongside this test). ---
console.log("Test 4: genuinely Focused persona still reads as Focused (sample-size guard doesn't erase real signal)");
{
  const answers: Answer[] = [];
  let id = 0;
  for (let i = 0; i < 20; i++) {
    // Wide exposure pool: many genres.
    const genres = [["Drama", "Comedy", "Horror", "Action", "Romance"][i % 5]];
    // But only Drama gets rated highly — a real genre preference.
    const rating = genres[0] === "Drama" ? 5 : 2;
    answers.push(mkAnswer(id++, RECENT_YEAR, MAJOR_VOTES, genres, true, rating));
  }
  const result = computeScores(answers, { final: true });
  assert(
    "genreWidth reads as Focused (score < 0)",
    result.axisScores.genreWidth.score < 0,
    `got ${result.axisScores.genreWidth.score.toFixed(3)}`,
  );
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
