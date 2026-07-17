/**
 * Fetches the two result-screen recommendation lists (docs/adr/0006) via
 * two fully independent requests, each with its own loading state so
 * either can fail or resolve without waiting on the other (a single
 * combined endpoint can't do this — it can only respond once both
 * pipelines finish, which was the reason ADR 0006 splits them into two
 * endpoints in the first place).
 *
 * Cross-list dedup only applies during a fresh fetch, never against an
 * already-cached list: whichever of the two resolves first keeps its picks
 * exactly as TMDb/the agent returned them (already visible to the user, so
 * it must not change retroactively); the other is filtered against
 * whatever the first one already claimed and backfills from its own
 * buffer (the API returns ~10 candidates, only 5 of which are shown).
 */

import { useEffect, useRef, useState } from "react";
import type {
  QuestionMovie,
  RecommendHorizonRequest,
  RecommendHorizonResponse,
  RecommendSimilarRequest,
  RecommendSimilarResponse,
} from "../api-types";

/** undefined = not yet resolved (still loading, or nothing to fetch), null =
 *  resolved but failed/empty (section should be omitted), array = resolved
 *  successfully. */
export type RecommendListState = QuestionMovie[] | null | undefined;

const DISPLAY_COUNT = 5;

function pickUnique(candidates: QuestionMovie[], taken: Set<number>): QuestionMovie[] {
  const picked: QuestionMovie[] = [];
  for (const movie of candidates) {
    if (picked.length >= DISPLAY_COUNT) break;
    if (taken.has(movie.tmdbId)) continue;
    picked.push(movie);
    taken.add(movie.tmdbId);
  }
  return picked;
}

interface UseRecommendationsInput {
  /** Present (including null) iff this list was already fetched and
   *  persisted in an earlier visit to this result — skips fetching
   *  entirely, so a page reload shows a stable result (ADR 0006 item 9)
   *  instead of re-rolling TMDb's randomized candidate selection. */
  cachedSimilar: RecommendListState;
  cachedHorizon: RecommendListState;
  /** Null means there isn't enough data to build a request at all (e.g. no
   *  rated movies) — the fetch is skipped and the section stays omitted,
   *  same end state as a failed fetch, without wasting a round-trip. */
  similarRequest: RecommendSimilarRequest | null;
  horizonRequest: RecommendHorizonRequest | null;
  onSimilarResolved: (movies: QuestionMovie[] | null) => void;
  onHorizonResolved: (movies: QuestionMovie[] | null) => void;
}

export function useRecommendations({
  cachedSimilar,
  cachedHorizon,
  similarRequest,
  horizonRequest,
  onSimilarResolved,
  onHorizonResolved,
}: UseRecommendationsInput): { similar: RecommendListState; horizon: RecommendListState } {
  const [similar, setSimilar] = useState<RecommendListState>(cachedSimilar);
  const [horizon, setHorizon] = useState<RecommendListState>(cachedHorizon);
  // Shared across both effects so whichever resolves second sees what the
  // first already claimed — see the module doc comment above.
  const takenIds = useRef(new Set<number>());

  useEffect(() => {
    if (cachedSimilar !== undefined || !similarRequest) return;
    let cancelled = false;
    fetch("/api/recommend-similar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(similarRequest),
    })
      .then((res) => res.json())
      .then((data: RecommendSimilarResponse) => {
        if (cancelled) return;
        // Dev/demo visibility only — see useMovieBuffer.ts's matching log
        // for the other 2 agents.
        if (data.reasoning) console.log("[MovieTI] recommend-similar reasoning:", data.reasoning);
        const picked = data.movies ? pickUnique(data.movies, takenIds.current) : null;
        setSimilar(picked);
        onSimilarResolved(picked);
      })
      .catch(() => {
        if (cancelled) return;
        setSimilar(null);
        onSimilarResolved(null);
      });
    return () => {
      cancelled = true;
    };
    // Fires once on mount only — cachedSimilar/onSimilarResolved are stable
    // for the lifetime of a single result screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cachedHorizon !== undefined || !horizonRequest) return;
    let cancelled = false;
    fetch("/api/recommend-horizon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(horizonRequest),
    })
      .then((res) => res.json())
      .then((data: RecommendHorizonResponse) => {
        if (cancelled) return;
        if (data.reasoning) console.log("[MovieTI] recommend-horizon reasoning:", data.reasoning);
        const picked = data.movies ? pickUnique(data.movies, takenIds.current) : null;
        setHorizon(picked);
        onHorizonResolved(picked);
      })
      .catch(() => {
        if (cancelled) return;
        setHorizon(null);
        onHorizonResolved(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { similar, horizon };
}
