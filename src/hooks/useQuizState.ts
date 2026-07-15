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
import { computeScores } from "../scoring";
import type { Answer } from "../types/answer";

export const STORAGE_KEY = "movieti:quiz-state";

interface PersistedState {
  answers: Answer[];
  checkpoint?: CheckpointPlan;
  tasteHypothesis?: string;
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
      patch((prev) => ({ ...prev, tasteHypothesis }));
    },
    [patch],
  );

  const reset = useCallback(() => {
    patch(() => ({ answers: [], checkpoint: undefined, tasteHypothesis: undefined }));
  }, [patch]);

  const ratedMoviesSoFar = useMemo(
    () =>
      state.answers
        .filter((a): a is Answer & { rating: number } => a.seen && a.rating !== undefined)
        .map(toRatedMovie),
    [state.answers],
  );

  const provisional = useMemo(() => computeScores(state.answers), [state.answers]);

  return {
    answers: state.answers,
    checkpoint: state.checkpoint,
    tasteHypothesis: state.tasteHypothesis,
    axisScores: provisional.axisScores,
    ratedMoviesSoFar,
    recordAnswer,
    setCheckpoint,
    setTasteHypothesis,
    reset,
  };
}
