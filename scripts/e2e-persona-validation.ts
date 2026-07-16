/**
 * E2E synthetic-persona validation (SPEC.md 4.1.2, the "biggest open item"
 * per SPEC.md 9節): drive the REAL deployed app end-to-end — actual
 * POST /api/next-batch calls (live TMDb discover + live Workers AI agents),
 * actual POST /api/flourish — for all 16 extreme archetypes (every
 * combination of H/L, N/O, M/U, W/F), and check whether the resulting type
 * code matches the intended persona. This exercises the exact HTTP contract
 * src/hooks/useMovieBuffer.ts and src/hooks/useQuizState.ts use, just
 * driven by a scripted persona instead of a human tapping through the UI.
 *
 * Each "persona" is a decision function: given a real QuestionMovie the
 * live agent actually returned, decide seen/rating according to the axis
 * it's meant to test. Everything else (which movies get shown, whether the
 * agent's discover_params are any good, whether TMDb/LLM calls succeed) is
 * the real production pipeline — nothing is mocked.
 *
 * Usage:
 *   node --experimental-strip-types scripts/e2e-persona-validation.ts \
 *     [--base-url=https://movieti.pages.dev] [--concurrency=3] [--seed=N] [--skip-flourish]
 */

import { computeScores, SCORING_CONSTANTS } from "../src/scoring.ts";
import type { Answer } from "../src/types/answer.ts";
import { writeFileSync, mkdirSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const BASE_URL = (args["base-url"] ?? "https://movieti.pages.dev").replace(/\/$/, "");
const CONCURRENCY = Number(args.concurrency ?? 3);
const BASE_SEED = args.seed ? Number(args.seed) : Date.now();
const SKIP_FLOURISH = args["skip-flourish"] === "true";
const REQUEST_TIMEOUT_MS = 30_000;

const AXES = ["volume", "era", "mainstream", "genreWidth"] as const;
type Axis = (typeof AXES)[number];
const POLE_INDEX: Record<Axis, number> = { volume: 0, era: 1, mainstream: 2, genreWidth: 3 };
const POLES: Record<Axis, [string, string]> = {
  volume: ["H", "L"],
  era: ["N", "O"],
  mainstream: ["M", "U"],
  genreWidth: ["W", "F"],
};

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
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

const CURRENT_YEAR = new Date().getFullYear();
const GENRES_POOL = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
  "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery",
  "Romance", "Science Fiction", "Thriller", "War", "Western",
];

interface Persona {
  typeCode: string;
  seenProb: number;
  eraPole: "N" | "O";
  mainstreamPole: "M" | "U";
  genreWidthPole: "W" | "F";
  favoriteGenres: string[];
}

function buildPersona(typeCode: string, rng: () => number): Persona {
  const [v, e, m, g] = typeCode.split("");
  const favoriteGenres = [...GENRES_POOL].sort(() => rng() - 0.5).slice(0, 2);
  return {
    typeCode,
    seenProb: v === "H" ? 0.55 : 0.05,
    eraPole: e as "N" | "O",
    mainstreamPole: m as "M" | "U",
    genreWidthPole: g as "W" | "F",
    favoriteGenres,
  };
}

// Rates a REAL movie returned by the live agent, per the persona's axis
// preferences. Same additive-adjustment shape as the pre-E2E draft, just
// applied to actual TMDb data instead of a synthetic catalog.
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
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

const EXCLUDED_FRANCHISE_HINTS = ["disney", "pixar", "marvel", "lucasfilm", "star wars"];

async function runPersona(typeCode: string, seed: number) {
  const rng = mulberry32(seed);
  const persona = buildPersona(typeCode, rng);
  const answers: Answer[] = [];
  let shownMovieIds: number[] = [];
  let checkpoint: unknown;
  let tasteHypothesis: string | undefined;
  let recentTargetAxes: Axis[] = [];
  const sourceCounts = { agent: 0, fallback: 0, preset: 0 };
  const suspiciousTitles: string[] = [];
  let batchCount = 0;

  while (answers.length < 80) {
    const nextQuestionNumber = answers.length + 1;
    const phase = nextQuestionNumber <= 20 ? "screening" : "deep_dive";
    const { axisScores } = computeScores(answers);
    const ratedMoviesSoFar = answers
      .filter((a): a is Answer & { rating: number } => a.seen && a.rating !== undefined)
      .map(toRatedMovie);

    const body = {
      phase,
      questionNumber: nextQuestionNumber,
      axisScores,
      shownMovieIds,
      plan: phase === "deep_dive" ? checkpoint : undefined,
      ratedMoviesSoFar,
      batchSize: 5,
      recentTargetAxes,
      tasteHypothesis: phase === "deep_dive" ? tasteHypothesis : undefined,
    };

    const data = (await postJson("/api/next-batch", body)) as {
      batch: Answer["movie"][];
      source: "agent" | "fallback" | "preset";
      targetAxis?: Axis;
      checkpoint?: unknown;
      tasteHypothesis?: string;
    };

    sourceCounts[data.source]++;
    batchCount++;
    if (data.targetAxis) recentTargetAxes = [...recentTargetAxes, data.targetAxis].slice(-3);
    if (data.checkpoint) checkpoint = data.checkpoint;
    if (data.tasteHypothesis) tasteHypothesis = data.tasteHypothesis;

    if (data.batch.length === 0) {
      throw new Error(`empty batch at question ${nextQuestionNumber} (source=${data.source})`);
    }

    for (const movie of data.batch) {
      const lowerTitle = movie.title.toLowerCase();
      if (EXCLUDED_FRANCHISE_HINTS.some((h) => lowerTitle.includes(h))) {
        suspiciousTitles.push(movie.title);
      }
      const seen = rng() < persona.seenProb;
      answers.push(seen ? { movie, seen, rating: rateMovie(persona, movie, rng) } : { movie, seen });
    }
    shownMovieIds = [...shownMovieIds, ...data.batch.map((m) => m.tmdbId)];
  }

  const result = computeScores(answers, { final: true });

  let flourishOk: boolean | null = null;
  if (!SKIP_FLOURISH) {
    try {
      const ratedMovies = answers
        .filter((a): a is Answer & { rating: number } => a.seen && a.rating !== undefined)
        .map(toRatedMovie);
      const topRatedMovies = [...ratedMovies].sort((a, b) => b.rating - a.rating).slice(0, 5);
      const flourishRes = (await postJson("/api/flourish", {
        typeCode: result.typeCode,
        axisScores: result.axisScores,
        topRatedMovies,
        signatureMovie: result.signatureMovie
          ? {
              ...toRatedMovie({ movie: result.signatureMovie.movie, seen: true, rating: result.signatureMovie.rating }),
              deviation: result.signatureMovie.deviation,
            }
          : topRatedMovies[0],
      })) as { status: string; comment: string | null };
      flourishOk = flourishRes.status === "ok" && !!flourishRes.comment;
    } catch {
      flourishOk = false;
    }
  }

  const uniqueShown = new Set(shownMovieIds).size;
  return {
    persona,
    result,
    sourceCounts,
    batchCount,
    duplicates: shownMovieIds.length - uniqueShown,
    suspiciousTitles,
    flourishOk,
    seenCount: answers.filter((a) => a.seen).length,
  };
}

async function withConcurrency<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const typeCodes = Array.from({ length: 16 }, (_, bit) =>
    (bit & 8 ? "H" : "L") + (bit & 4 ? "N" : "O") + (bit & 2 ? "M" : "U") + (bit & 1 ? "W" : "F"),
  );

  console.log(`E2E persona validation against ${BASE_URL}`);
  console.log(`Seed: ${BASE_SEED} | Concurrency: ${CONCURRENCY} | Flourish: ${!SKIP_FLOURISH}\n`);

  const startedAt = Date.now();
  const rows = await withConcurrency(typeCodes, CONCURRENCY, async (typeCode) => {
    const seed = hashSeed(`${BASE_SEED}-${typeCode}`);
    const t0 = Date.now();
    try {
      const r = await runPersona(typeCode, seed);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `[${typeCode}] done in ${elapsed}s -> ${r.result.typeCode} ${r.result.typeCode === typeCode ? "✅" : "❌"} (seen ${r.seenCount}/80, sources agent=${r.sourceCounts.agent} fallback=${r.sourceCounts.fallback} preset=${r.sourceCounts.preset}${r.suspiciousTitles.length ? `, SUSPICIOUS: ${r.suspiciousTitles.join(", ")}` : ""})`,
      );
      return { typeCode, ok: true as const, ...r };
    } catch (err) {
      console.log(`[${typeCode}] FAILED: ${(err as Error).message}`);
      return { typeCode, ok: false as const, error: (err as Error).message };
    }
  });

  const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const lines: string[] = [];
  const log = (s = "") => {
    console.log(s);
    lines.push(s);
  };

  log(`\n# E2E persona validation — ${new Date().toISOString()}`);
  log(`Target: ${BASE_URL} | Seed: ${BASE_SEED} | Total wall time: ${totalElapsed}s\n`);
  log("| Intended | Actual | Match | Seen | Volume | Era | Mainstream | GenreWidth | Sources (agent/fallback/preset) | Flourish |");
  log("|---|---|---|---|---|---|---|---|---|---|");

  const successRows = rows.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  for (const row of successRows) {
    const fmt = (axis: Axis) => {
      const s = row.result.axisScores[axis];
      return `${s.score.toFixed(2)} (c=${s.confidence.toFixed(2)})`;
    };
    log(
      `| ${row.typeCode} | ${row.result.typeCode} | ${row.result.typeCode === row.typeCode ? "✅" : "❌"} | ${row.seenCount}/80 | ${fmt("volume")} | ${fmt("era")} | ${fmt("mainstream")} | ${fmt("genreWidth")} | ${row.sourceCounts.agent}/${row.sourceCounts.fallback}/${row.sourceCounts.preset} | ${row.flourishOk === null ? "skipped" : row.flourishOk ? "✅" : "❌"} |`,
    );
  }
  for (const row of rows) {
    if (!row.ok) log(`| ${row.typeCode} | — | ⚠️ ERROR | — | — | — | — | — | — | — | (${row.error}) |`);
  }

  log("\n## Summary\n");
  const failedRuns = rows.filter((r) => !r.ok).length;
  if (failedRuns > 0) log(`⚠️ ${failedRuns}/16 runs failed outright (network/HTTP error) — see rows above.\n`);
  const matchCount = successRows.filter((r) => r.result.typeCode === r.typeCode).length;
  log(`Overall type-code match rate: ${((matchCount / successRows.length) * 100).toFixed(1)}% (${matchCount}/${successRows.length} completed runs)\n`);

  for (const axis of AXES) {
    const [pos, neg] = POLES[axis];
    let correct = 0;
    let totalAbsScore = 0;
    let minConfidence = 1;
    for (const row of successRows) {
      const intendedPole = row.typeCode[POLE_INDEX[axis]];
      const actualPole = row.result.axisScores[axis].score >= 0 ? pos : neg;
      if (actualPole === intendedPole) correct++;
      totalAbsScore += Math.abs(row.result.axisScores[axis].score);
      minConfidence = Math.min(minConfidence, row.result.axisScores[axis].confidence);
    }
    log(
      `- **${axis}** (${pos}/${neg}): ${correct}/${successRows.length} correct pole, avg |score| ${(totalAbsScore / successRows.length).toFixed(2)}, min confidence ${minConfidence.toFixed(2)}`,
    );
  }

  const totalAgent = successRows.reduce((s, r) => s + r.sourceCounts.agent, 0);
  const totalFallback = successRows.reduce((s, r) => s + r.sourceCounts.fallback, 0);
  const totalPreset = successRows.reduce((s, r) => s + r.sourceCounts.preset, 0);
  log(
    `\nDeep-dive batch sources across all runs: agent=${totalAgent}, fallback=${totalFallback} (live agent/TMDb degraded and silently used the safety net), preset=${totalPreset} (screening, expected).`,
  );
  const allSuspicious = successRows.flatMap((r) => r.suspiciousTitles);
  log(
    allSuspicious.length > 0
      ? `\n⚠️ Franchise-exclusion leak: ${allSuspicious.length} titles matched Disney/Marvel/Pixar/Lucasfilm hints despite the without_companies filter: ${allSuspicious.join(", ")}`
      : `\nFranchise exclusion held across all ${successRows.reduce((s, r) => s + r.batchCount, 0)} batches — no Disney/Marvel/Pixar/Lucasfilm titles slipped through.`,
  );
  const totalDuplicates = successRows.reduce((s, r) => s + r.duplicates, 0);
  log(`Duplicate movies shown within a single session: ${totalDuplicates} total across all runs.`);

  mkdirSync("docs/validation-runs", { recursive: true });
  const outPath = `docs/validation-runs/${new Date().toISOString().replace(/[:.]/g, "-")}-e2e.md`;
  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`\nFull report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
