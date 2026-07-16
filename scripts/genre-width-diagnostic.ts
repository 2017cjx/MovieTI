/**
 * Focused follow-up to scripts/e2e-persona-validation.ts: the first E2E run
 * (docs/validation-runs/2026-07-16T06-05-23-667Z-e2e.md) found that
 * high-volume "Wide" personas (HOUW, HOMW, HNUW) kept getting scored
 * Focused despite high confidence. Hypothesis: src/scoring.ts's genreWidth
 * formula compares topGenreShare(highlyRatedSeen) against
 * topGenreShare(seen) as its exposure baseline, but that baseline is only a
 * fair counterfactual if which movies get highly-rated is independent of
 * genre given the OTHER axes. For a Wide persona (genre has zero effect on
 * rating — see rateMovie()), ratings are driven purely by era/mainstream
 * fit. If era/mainstream fit correlates with genre in what the live agent
 * actually serves (e.g. it reaches for Action/Sci-Fi disproportionately
 * when testing mainstream), the highly-rated subset would show genre
 * concentration that has nothing to do with genre preference — a
 * confound, not persona noise.
 *
 * This script drives ONE Wide persona through the real live pipeline (same
 * as the E2E script) and prints the genre tally for `seen` vs
 * `highlyRatedSeen` side by side, plus which axis each batch targeted, so
 * the confound can be confirmed against real TMDb data rather than theory.
 *
 * Usage:
 *   node --experimental-strip-types scripts/genre-width-diagnostic.ts [--type=HNUW] [--seed=N]
 */

import { computeScores, SCORING_CONSTANTS } from "../src/scoring.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const BASE_URL = (args["base-url"] ?? "https://movieti.pages.dev").replace(/\/$/, "");
const TYPE_CODE = args.type ?? "HNUW";
const SEED = args.seed ? Number(args.seed) : Date.now();

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CURRENT_YEAR = new Date().getFullYear();
const GENRES_POOL = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
  "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery",
  "Romance", "Science Fiction", "Thriller", "War", "Western",
];

interface Persona {
  seenProb: number;
  eraPole: "N" | "O";
  mainstreamPole: "M" | "U";
  genreWidthPole: "W" | "F";
  favoriteGenres: string[];
}

function buildPersona(typeCode: string, rng: () => number): Persona {
  const [v, e, m, g] = typeCode.split("");
  return {
    seenProb: v === "H" ? 0.55 : 0.05,
    eraPole: e as "N" | "O",
    mainstreamPole: m as "M" | "U",
    genreWidthPole: g as "W" | "F",
    favoriteGenres: [...GENRES_POOL].sort(() => rng() - 0.5).slice(0, 2),
  };
}

function rateMovie(persona: Persona, movie: { year: number; genres: string[]; voteCount: number }, rng: () => number): number {
  let score = 3;
  const isRecent = CURRENT_YEAR - movie.year <= SCORING_CONSTANTS.ERA_RECENT_YEARS;
  score += persona.eraPole === "N" ? (isRecent ? 1.6 : -1.6) : (isRecent ? -1.6 : 1.6);
  const isMajor = movie.voteCount >= SCORING_CONSTANTS.MAJOR_VOTE_COUNT_THRESHOLD;
  score += persona.mainstreamPole === "M" ? (isMajor ? 1.6 : -1.6) : (isMajor ? -1.6 : 1.6);
  if (persona.genreWidthPole === "F") {
    const isFavorite = movie.genres.some((g) => persona.favoriteGenres.includes(g));
    score += isFavorite ? 1.6 : -0.8;
  }
  score += (rng() - 0.5) * 1.2;
  return Math.max(1, Math.min(5, Math.round(score)));
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

interface Answer {
  movie: { tmdbId: number; title: string; year: number; genres: string[]; voteCount: number; voteAverage: number; originalLanguage: string };
  seen: boolean;
  rating?: number;
}

function toRatedMovie(a: Answer & { rating: number }) {
  return {
    title: a.movie.title,
    year: a.movie.year,
    genres: a.movie.genres,
    voteCount: a.movie.voteCount,
    rating: a.rating,
    tmdbVoteAverage: a.movie.voteAverage,
    originalLanguage: a.movie.originalLanguage,
  };
}

function tallyGenres(items: Answer[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const a of items) {
    for (const g of a.movie.genres) tally.set(g, (tally.get(g) ?? 0) + 1);
  }
  return tally;
}

function printTally(label: string, tally: Map<string, number>) {
  const total = [...tally.values()].reduce((s, c) => s + c, 0);
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n${label} (${total} genre tags total):`);
  for (const [genre, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`  ${genre.padEnd(18)} ${String(count).padStart(3)}  (${pct}%)`);
  }
}

async function main() {
  const rng = mulberry32(SEED);
  const persona = buildPersona(TYPE_CODE, rng);
  console.log(`Diagnostic run: type=${TYPE_CODE} seed=${SEED} favoriteGenres=${persona.favoriteGenres.join(",")} (irrelevant for Wide personas — genre has no effect on rating)`);

  const answers: Answer[] = [];
  let shownMovieIds: number[] = [];
  let checkpoint: unknown;
  let tasteHypothesis: string | undefined;
  let recentTargetAxes: string[] = [];
  const batchLog: { questionNumber: number; targetAxis?: string; genres: string[] }[] = [];

  while (answers.length < 80) {
    const nextQuestionNumber = answers.length + 1;
    const phase = nextQuestionNumber <= 20 ? "screening" : "deep_dive";
    const { axisScores } = computeScores(answers as never);
    const ratedMoviesSoFar = answers
      .filter((a): a is Answer & { rating: number } => a.seen && a.rating !== undefined)
      .map(toRatedMovie);

    const data = (await postJson("/api/next-batch", {
      phase,
      questionNumber: nextQuestionNumber,
      axisScores,
      shownMovieIds,
      plan: phase === "deep_dive" ? checkpoint : undefined,
      ratedMoviesSoFar,
      batchSize: 5,
      recentTargetAxes,
      tasteHypothesis: phase === "deep_dive" ? tasteHypothesis : undefined,
    })) as {
      batch: Answer["movie"][];
      source: string;
      targetAxis?: string;
      checkpoint?: unknown;
      tasteHypothesis?: string;
    };

    if (data.targetAxis) recentTargetAxes = [...recentTargetAxes, data.targetAxis].slice(-3);
    if (data.checkpoint) checkpoint = data.checkpoint;
    if (data.tasteHypothesis) tasteHypothesis = data.tasteHypothesis;
    if (data.batch.length === 0) throw new Error(`empty batch at question ${nextQuestionNumber}`);

    batchLog.push({
      questionNumber: nextQuestionNumber,
      targetAxis: data.targetAxis,
      genres: [...new Set(data.batch.flatMap((m) => m.genres))],
    });

    for (const movie of data.batch) {
      const seen = rng() < persona.seenProb;
      answers.push(seen ? { movie, seen, rating: rateMovie(persona, movie, rng) } : { movie, seen });
    }
    shownMovieIds = [...shownMovieIds, ...data.batch.map((m) => m.tmdbId)];
  }

  const result = computeScores(answers as never, { final: true });
  const seen = answers.filter((a) => a.seen);
  const highlyRatedSeen = seen.filter((a) => (a.rating ?? 0) >= SCORING_CONSTANTS.HIGH_RATING_THRESHOLD);

  console.log(`\n=== Result ===`);
  console.log(`Intended: ${TYPE_CODE} | Actual: ${result.typeCode} | Match: ${result.typeCode === TYPE_CODE ? "YES" : "NO"}`);
  console.log(`Seen: ${seen.length}/80 | Highly-rated (>=4): ${highlyRatedSeen.length}`);
  console.log(`GenreWidth score: ${result.axisScores.genreWidth.score.toFixed(3)} (confidence ${result.axisScores.genreWidth.confidence.toFixed(2)})`);

  printTally("Genre tally: ALL SEEN (exposure baseline)", tallyGenres(seen));
  printTally("Genre tally: HIGHLY-RATED SEEN (what drives the score)", tallyGenres(highlyRatedSeen));

  console.log(`\n=== Per-batch target axis + genres served (deep_dive only) ===`);
  for (const b of batchLog) {
    if (b.questionNumber > 20) {
      console.log(`  Q${b.questionNumber}: targetAxis=${b.targetAxis ?? "(fallback/preset)"} genres=[${b.genres.join(", ")}]`);
    }
  }

  console.log(`\n=== Highly-rated movies (what the persona liked) ===`);
  for (const a of highlyRatedSeen as (Answer & { rating: number })[]) {
    console.log(`  ${a.movie.title} (${a.movie.year}, votes=${a.movie.voteCount}) [${a.movie.genres.join(", ")}] rating=${a.rating}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
