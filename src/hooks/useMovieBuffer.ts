/**
 * Prefetch/lookahead buffer for the quiz (先読みバッファ). Hides the latency
 * of POST /api/next-batch from the user by always keeping a small queue of
 * ready-to-show movies, refilling in the background before the queue runs
 * dry. See CONTEXT.md "先読みバッファ（プリフェッチ）" for the design
 * rationale and the 3 alternatives compared via /design-an-interface.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AxisId,
  AxisScores,
  CheckpointPlan,
  NextBatchRequest,
  NextBatchResponse,
  Phase,
  QuestionMovie,
  RatedMovie,
} from "../api-types";
import type { Contradiction } from "../lib/contradiction";

// How many recent target-axis picks to remember and echo back to the
// agent (src/api-types.ts NextBatchRequest.recentTargetAxes) — enough for
// it to notice "I've been repeating myself" without carrying the whole
// session's history.
const RECENT_TARGET_AXES_LIMIT = 3;

/** Everything the caller must supply fresh at the moment a fetch fires.
 *  Read via a callback (not passed as plain props) because these values
 *  change as the user answers more questions, while this hook's own
 *  fetch-triggering effect must not re-run just because they changed. */
export interface NextBatchContext {
  axisScores: AxisScores;
  ratedMoviesSoFar: RatedMovie[];
  /** Only read when the upcoming batch is in the deep_dive phase. */
  plan?: CheckpointPlan;
  /** Only read when the upcoming batch is in the deep_dive phase. */
  tasteHypothesis?: string;
  /** Only read when the upcoming batch is in the deep_dive phase. Whatever
   *  contradiction.ts found from the single most recent answer — null if
   *  none. Not accumulated/deduped across batches; if it's still relevant
   *  next batch too, detectContradiction will simply find it again from
   *  the same still-most-recent answer. */
  contradiction?: Contradiction | null;
  /** How many franchise (Disney/Marvel/Pixar/Lucasfilm) movies have been
   *  shown so far this session — read on every fetch, not just deep_dive
   *  (see NextBatchRequest.franchiseShownCount). */
  franchiseShownCount: number;
}

export interface UseMovieBufferOptions {
  getContext: () => NextBatchContext;
  /** Fired the one time a response carries `checkpoint` (questionNumber
   *  crossed 20). The caller must persist it (state + localStorage) so it
   *  can be handed back via NextBatchContext.plan on later calls. */
  onCheckpoint: (checkpoint: CheckpointPlan) => void;
  /** Fired alongside onCheckpoint, whenever a response carries
   *  `tasteHypothesis`. Same persist-and-echo-back contract as onCheckpoint. */
  onTasteHypothesis: (tasteHypothesis: string) => void;
  /** How many questions were already answered before this hook mounted
   *  (e.g. restored from localStorage after a reload). Used only to seed
   *  initial state — later changes to this value are ignored. Without
   *  this, a mid-quiz reload would re-fetch from questionNumber 1. */
  initialDispatchedCount?: number;
  /** TMDb ids already shown in those prior answers, so dedup still works
   *  across a reload. Same seed-only semantics as initialDispatchedCount. */
  initialShownMovieIds?: number[];
  totalQuestionCount?: number;
  screeningQuestionCount?: number;
  /** Fetch the next batch once the queue length drops to this. */
  fetchThreshold?: number;
  batchSize?: number;
}

export interface UseMovieBufferResult {
  /** null while a fetch is in flight (isLoading) or after the quiz ends (isComplete). */
  currentMovie: QuestionMovie | null;
  /** True only while genuinely blocked waiting on a batch (queue is empty). */
  isLoading: boolean;
  /** True once a fetch has failed at the HTTP level. TMDb/LLM degradation
   *  never reaches here — that's absorbed server-side as source: "fallback". */
  error: boolean;
  isComplete: boolean;
  /** Call once the user has answered currentMovie. */
  advance: () => void;
  /** Re-attempt after `error`. */
  retry: () => void;
}

const DEFAULT_TOTAL_QUESTION_COUNT = 80;
const DEFAULT_SCREENING_QUESTION_COUNT = 20;
// Refill while 3 are still queued (not 1) — the Tinder-style 3-tap answer
// flow (2026-07-15) lets people blow through a batch in a couple of
// seconds, well under the LLM+TMDb round trip time. A bigger head start
// means the buffer is far less likely to run dry mid-session.
const DEFAULT_FETCH_THRESHOLD = 3;
const DEFAULT_BATCH_SIZE = 5;

export function useMovieBuffer(options: UseMovieBufferOptions): UseMovieBufferResult {
  const {
    totalQuestionCount = DEFAULT_TOTAL_QUESTION_COUNT,
    screeningQuestionCount = DEFAULT_SCREENING_QUESTION_COUNT,
    fetchThreshold = DEFAULT_FETCH_THRESHOLD,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options;

  // Stashed in refs so the fetch effect below can always read the latest
  // callback without re-running just because the caller re-rendered.
  const getContextRef = useRef(options.getContext);
  getContextRef.current = options.getContext;
  const onCheckpointRef = useRef(options.onCheckpoint);
  onCheckpointRef.current = options.onCheckpoint;
  const onTasteHypothesisRef = useRef(options.onTasteHypothesis);
  onTasteHypothesisRef.current = options.onTasteHypothesis;

  const [queue, setQueue] = useState<QuestionMovie[]>([]);
  const [dispatchedCount, setDispatchedCount] = useState(options.initialDispatchedCount ?? 0);
  const [shownMovieIds, setShownMovieIds] = useState<number[]>(options.initialShownMovieIds ?? []);
  const [error, setError] = useState(false);
  const inFlightRef = useRef(false);
  // Not React state: doesn't need to trigger a re-render, only read at the
  // moment a fetch fires (like getContextRef/onCheckpointRef below).
  const recentTargetAxesRef = useRef<AxisId[]>([]);

  const isComplete = dispatchedCount >= totalQuestionCount;
  const nextQuestionNumber = dispatchedCount + queue.length + 1;

  const fetchBatch = useCallback(async () => {
    if (inFlightRef.current || isComplete || nextQuestionNumber > totalQuestionCount) {
      return;
    }
    inFlightRef.current = true;
    try {
      const context = getContextRef.current();
      const phase: Phase = nextQuestionNumber <= screeningQuestionCount ? "screening" : "deep_dive";
      const request: NextBatchRequest = {
        phase,
        questionNumber: nextQuestionNumber,
        axisScores: context.axisScores,
        shownMovieIds,
        plan: phase === "deep_dive" ? context.plan : undefined,
        ratedMoviesSoFar: context.ratedMoviesSoFar,
        batchSize,
        recentTargetAxes: recentTargetAxesRef.current,
        tasteHypothesis: phase === "deep_dive" ? context.tasteHypothesis : undefined,
        contradiction: phase === "deep_dive" ? (context.contradiction ?? undefined) : undefined,
        franchiseShownCount: context.franchiseShownCount,
      };
      const res = await fetch("/api/next-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(`next-batch failed: ${res.status}`);
      const data: NextBatchResponse = await res.json();
      if (data.targetAxis) {
        recentTargetAxesRef.current = [...recentTargetAxesRef.current, data.targetAxis].slice(
          -RECENT_TARGET_AXES_LIMIT,
        );
      }
      // Guard against an empty batch: spreading `[]` into setState still
      // creates a new array *reference* with equal contents, which would
      // change fetchBatch's identity (shownMovieIds is one of its deps)
      // and re-trigger the effect below every render — an infinite fetch
      // loop with nothing actually progressing. A well-behaved backend
      // should never send an empty batch (functions/api/_lib/fallback-pool.ts
      // always backfills), but this keeps the frontend safe regardless.
      if (data.batch.length > 0) {
        setQueue((prev) => [...prev, ...data.batch]);
        setShownMovieIds((prev) => [...prev, ...data.batch.map((m) => m.tmdbId)]);
      }
      if (data.checkpoint) onCheckpointRef.current(data.checkpoint);
      if (data.tasteHypothesis) onTasteHypothesisRef.current(data.tasteHypothesis);
      // Dev/demo visibility into the agents' own guesswork (2026-07-17,
      // user-requested) — none of this is used by any app logic, it's
      // purely so the reasoning behind a pick is inspectable in the browser
      // console rather than only in Cloudflare's server-side logs.
      if (data.reasoning) console.log("[MovieTI] question-agent reasoning:", data.reasoning);
      if (data.checkpoint || data.tasteHypothesis) {
        // Natural-language guesswork only — score/confidence numbers are
        // already visible in the axis bars on the result screen itself, so
        // repeating them here would just be noise (2026-07-17, user-requested).
        const planText = data.checkpoint
          ? Object.fromEntries(
              Object.entries(data.checkpoint).map(([axis, axisPlan]) => [axis, axisPlan.plan]),
            )
          : undefined;
        console.log("[MovieTI] hypothesis-agent guess:", {
          tasteHypothesis: data.tasteHypothesis,
          plan: planText,
        });
      }
      setError(false);
    } catch {
      setError(true);
    } finally {
      inFlightRef.current = false;
    }
  }, [isComplete, nextQuestionNumber, screeningQuestionCount, shownMovieIds, batchSize, totalQuestionCount]);

  useEffect(() => {
    if (isComplete || error) return;
    if (queue.length <= fetchThreshold && !inFlightRef.current) {
      void fetchBatch();
    }
  }, [queue.length, isComplete, error, fetchThreshold, fetchBatch]);

  const advance = useCallback(() => {
    setQueue((prev) => prev.slice(1));
    setDispatchedCount((prev) => prev + 1);
  }, []);

  const retry = useCallback(() => {
    setError(false);
    void fetchBatch();
  }, [fetchBatch]);

  return {
    currentMovie: queue[0] ?? null,
    isLoading: queue.length === 0 && !isComplete && !error,
    error,
    isComplete,
    advance,
    retry,
  };
}
