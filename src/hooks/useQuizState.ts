/**
 * Owns the quiz's answer history and the Q20 checkpoint plan, and is the
 * single source of truth for reload-safety: every change is written to
 * localStorage under one key, and restored on mount. useMovieBuffer reads
 * its resume point (initialDispatchedCount / initialShownMovieIds) from
 * this hook's restored `answers`, since useMovieBuffer itself holds no
 * persistent state of its own.
 */

import { useCallback, useMemo, useState } from "react";
import type { CheckpointPlan, QuestionMovie, RatedMovie } from "../api-types";
import { detectContradiction } from "../lib/contradiction";
import { computeScores } from "../scoring";
import type { Answer } from "../types/answer";

export const STORAGE_KEY = "movieti:quiz-state";

interface PersistedState {
  answers: Answer[];
  checkpoint?: CheckpointPlan;
  tasteHypothesis?: string;
  /** The *first* hypothesis checkpoint's tasteHypothesis (formed at Q21,
   *  from just the 20 screening answers), captured once and never
   *  overwritten by later re-runs — unlike `tasteHypothesis` above, which
   *  always holds the latest. Lets the result screen contrast "the early
   *  read" against "the final read" (2026-07-17, user-requested — this
   *  reveal was the reason the hypothesis was kept hidden from the user
   *  until the result screen in the first place, per CONTEXT.md
   *  "仮説形成エージェントの定期再実行"). Absent for low-signal sessions
   *  that never reach deep_dive/Q21. */
  earlyTasteHypothesis?: string;
  /** The two result-screen recommendation lists (docs/adr/0006 item 9).
   *  undefined = not yet fetched, null = fetched but failed (section stays
   *  omitted on reload too, not re-attempted), array = fetched
   *  successfully. Piggybacks on this same STORAGE_KEY so a page reload
   *  shows a stable result instead of re-rolling TMDb's randomized
   *  candidate selection — see useRecommendations.ts. */
  recommendSimilar?: QuestionMovie[] | null;
  recommendHorizon?: QuestionMovie[] | null;
}

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { answers: [] };
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      answers: parsed.answers ?? [],
      checkpoint: parsed.checkpoint,
      tasteHypothesis: parsed.tasteHypothesis,
      earlyTasteHypothesis: parsed.earlyTasteHypothesis,
      recommendSimilar: parsed.recommendSimilar,
      recommendHorizon: parsed.recommendHorizon,
    };
  } catch {
    return { answers: [] };
  }
}

function toRatedMovie(answer: Answer & { rating: number }): RatedMovie {
  return {
    title: answer.movie.title,
    year: answer.movie.year,
    genres: answer.movie.genres,
    voteCount: answer.movie.voteCount,
    rating: answer.rating,
    tmdbVoteAverage: answer.movie.voteAverage,
    originalLanguage: answer.movie.originalLanguage,
  };
}

function writeStorage(next: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable (private browsing, quota) — reload-safety
    // degrades silently, the in-memory state still works for this session.
  }
}

export function useQuizState() {
  const [state, setState] = useState<PersistedState>(loadPersisted);

  // Every mutator below merges against the *functional* `prev`, never the
  // `state` closure — useMovieBuffer fires onCheckpoint and
  // onTasteHypothesis back-to-back in the same tick, and two setters that
  // each read the same stale `state` snapshot would clobber each other
  // (the second call's spread wouldn't see the first call's change yet).
  // Found via browser testing 2026-07-15: checkpoint silently disappeared
  // whenever tasteHypothesis arrived in the same response.
  const patch = useCallback((fn: (prev: PersistedState) => PersistedState) => {
    setState((prev) => {
      const next = fn(prev);
      writeStorage(next);
      return next;
    });
  }, []);

  const recordAnswer = useCallback(
    (movie: QuestionMovie, seen: boolean, rating?: number) => {
      const answer: Answer = { movie, seen, rating: seen ? rating : undefined };
      patch((prev) => ({ ...prev, answers: [...prev.answers, answer] }));
    },
    [patch],
  );

  const setCheckpoint = useCallback(
    (checkpoint: CheckpointPlan) => {
      patch((prev) => ({ ...prev, checkpoint }));
    },
    [patch],
  );

  const setTasteHypothesis = useCallback(
    (tasteHypothesis: string) => {
      patch((prev) => ({
        ...prev,
        tasteHypothesis,
        // Capture only the first one ever seen this session; every later
        // re-run keeps overwriting `tasteHypothesis` above but must not
        // touch this.
        earlyTasteHypothesis: prev.earlyTasteHypothesis ?? tasteHypothesis,
      }));
    },
    [patch],
  );

  const setRecommendSimilar = useCallback(
    (recommendSimilar: QuestionMovie[] | null) => {
      patch((prev) => ({ ...prev, recommendSimilar }));
    },
    [patch],
  );

  const setRecommendHorizon = useCallback(
    (recommendHorizon: QuestionMovie[] | null) => {
      patch((prev) => ({ ...prev, recommendHorizon }));
    },
    [patch],
  );

  const reset = useCallback(() => {
    patch(() => ({
      answers: [],
      checkpoint: undefined,
      tasteHypothesis: undefined,
      earlyTasteHypothesis: undefined,
      recommendSimilar: undefined,
      recommendHorizon: undefined,
    }));
  }, [patch]);

  const ratedMoviesSoFar = useMemo(
    () =>
      state.answers
        .filter((a): a is Answer & { rating: number } => a.seen && a.rating !== undefined)
        .map(toRatedMovie),
    [state.answers],
  );

  const provisional = useMemo(() => computeScores(state.answers), [state.answers]);

  // Compared against the lean established *before* the latest answer, not
  // one that already includes it — see contradiction.ts's doc comment.
  const latestContradiction = useMemo(() => {
    if (state.answers.length === 0) return null;
    const priorScores = computeScores(state.answers.slice(0, -1)).axisScores;
    return detectContradiction(state.answers[state.answers.length - 1], priorScores);
  }, [state.answers]);

  // Derived, not persisted separately — every shown movie already lives in
  // `answers`, and QuestionMovie.isFranchise is set server-side, so this is
  // just a count over data already there (2026-07-17, see
  // NextBatchRequest.franchiseShownCount).
  const franchiseShownCount = useMemo(
    () => state.answers.filter((a) => a.movie.isFranchise).length,
    [state.answers],
  );

  return {
    answers: state.answers,
    checkpoint: state.checkpoint,
    tasteHypothesis: state.tasteHypothesis,
    earlyTasteHypothesis: state.earlyTasteHypothesis,
    recommendSimilar: state.recommendSimilar,
    recommendHorizon: state.recommendHorizon,
    axisScores: provisional.axisScores,
    ratedMoviesSoFar,
    latestContradiction,
    franchiseShownCount,
    recordAnswer,
    setCheckpoint,
    setTasteHypothesis,
    setRecommendSimilar,
    setRecommendHorizon,
    reset,
  };
}
