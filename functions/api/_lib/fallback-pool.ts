import pool from "../../../data/fallback_pool.json";
import type { QuestionMovie } from "../../../src/api-types";

const FALLBACK_POOL = pool as QuestionMovie[];

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Returns exactly `count` movies, randomly ordered, preferring ones not
 *  already in `excludeIds`. Used two ways (docs/adr/0001, revised
 *  2026-07-15): (1) by design, for every screening-phase batch — a
 *  hand-curated, genre/era/region-balanced set beats what a cold-start
 *  live agent call (all-zero axis scores) tends to reach for; (2) as the
 *  deep_dive safety net when the live TMDb/LLM-driven selection fails.
 *  Either way, once the pool is exhausted within a session it backfills
 *  with repeats rather than ever returning fewer than requested (an
 *  empty/short batch would stall the frontend's prefetch buffer
 *  indefinitely) — randomizing which repeats get picked too, so the
 *  backfill isn't always the same handful of movies. */
export function getFallbackBatch(count: number, excludeIds: number[]): QuestionMovie[] {
  const excluded = new Set(excludeIds);
  const fresh = shuffle(FALLBACK_POOL.filter((m) => !excluded.has(m.tmdbId)));
  if (fresh.length >= count) return fresh.slice(0, count);
  const repeatsNeeded = count - fresh.length;
  const repeats = shuffle(FALLBACK_POOL).slice(0, repeatsNeeded);
  return [...fresh, ...repeats];
}
