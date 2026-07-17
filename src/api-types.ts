/**
 * Wire contract between the MovieTI frontend and its Cloudflare Pages
 * Functions backend. Type-only — no runtime code. Imported by both
 * `src/` (frontend, direct import) and `functions/api/*.ts` (backend,
 * relative import, e.g. `../../src/api-types`).
 *
 * Chosen after comparing 4 designs via /design-an-interface: minimal
 * 2-endpoint surface, the Q20 hypothesis checkpoint fully absorbed inside
 * /api/next-batch (no separate endpoint, no frontend branching), explicit
 * fields resent each call (no opaque continuation token — see CONTEXT.md
 * for why), and only the two failure-visibility flags actually needed
 * (`source`, `status`) rather than a full diagnostic-code taxonomy.
 */

export type Phase = "screening" | "deep_dive";

/** Must match the axis keys produced by src/scoring.ts exactly. */
export type AxisId = "volume" | "era" | "mainstream" | "genreWidth";

export interface AxisScore {
  /** -1.0 .. +1.0 */
  score: number;
  /** 0..1 */
  confidence: number;
}

/** Always all four axes, computed client-side by scoring.ts. The backend
 *  never recomputes these — it only reads them. */
export type AxisScores = Record<AxisId, AxisScore>;

/** A movie the user has seen and rated. Matches the plain-language shape
 *  prompts/hypothesis-agent.md and prompts/result-writer.md expect as input
 *  (genre names, not TMDb genre IDs). */
export interface RatedMovie {
  title: string;
  year: number;
  genres: string[];
  voteCount: number;
  /** 1-5, the user's own rating. */
  rating: number;
  /** TMDb's community average, 0-10. */
  tmdbVoteAverage: number;
  /** ISO 639-1 (e.g. "en", "ja", "ko", "fr"). Lets the backend track
   *  region/language coverage across the session — genre tags alone don't
   *  distinguish a Hollywood blockbuster from a Hong Kong or Japanese film
   *  in the same genre. Added 2026-07-15 to fix a diversity gap. */
  originalLanguage: string;
}

/** Output of the Q20 hypothesis checkpoint (prompts/hypothesis-agent.md).
 *  The backend computes this once, returns it on exactly one /api/next-batch
 *  response, and forgets it immediately after (stateless). The client must
 *  persist it (React state + localStorage) and echo it back as `plan` on
 *  every subsequent deep_dive call. */
export type CheckpointPlan = Record<AxisId, AxisScore & { plan: string }>;

export interface QuestionMovie {
  tmdbId: number;
  title: string;
  year: number;
  /** TMDb poster_path fragment; the client builds the full image URL
   *  (e.g. `https://image.tmdb.org/t/p/w342${posterPath}`), null if TMDb
   *  had none (shouldn't happen given the vote_count guardrail, but typed
   *  as nullable defensively). */
  posterPath: string | null;
  genres: string[];
  voteCount: number;
  voteAverage: number;
  /** ISO 639-1, see RatedMovie.originalLanguage. */
  originalLanguage: string;
}

// ---------------------------------------------------------------------------
// POST /api/next-batch
//
// Called repeatedly through both phases, paced by the frontend's own
// ready-queue/prefetch buffer (see CONTEXT.md "先読みバッファ"). The request
// shape is IDENTICAL every time — the backend alone decides, based on
// `questionNumber`, whether this call needs to run the Q20 hypothesis
// checkpoint before selecting the batch. The frontend never branches on
// question number to decide what to send.
// ---------------------------------------------------------------------------

export interface NextBatchRequest {
  phase: Phase;
  /** 1-based index of the first question this batch will fill (1, 6, 11, ...). */
  questionNumber: number;
  /** Fresh output of the client's own scoring.ts computeScores(answers). */
  axisScores: AxisScores;
  /** TMDb ids already shown this session (answered or currently buffered), for dedup. */
  shownMovieIds: number[];
  /** Required once phase === "deep_dive" (the plan from an earlier response's
   *  `checkpoint` field, persisted client-side). Omit while phase === "screening". */
  plan?: CheckpointPlan;
  /** Every seen+rated movie so far this session, always sent, every call —
   *  not just at the Q20 boundary. Cheap at this scale (<=80 entries) and
   *  keeps the request shape uniform. The backend only actually reads this
   *  the one time questionNumber crosses 20; every other call ignores it. */
  ratedMoviesSoFar: RatedMovie[];
  /** Default 5 if omitted (ADR 0001). Server-capped; response length is authoritative. */
  batchSize?: number;
  /** The last few `targetAxis` values the agent picked (most recent last),
   *  echoed back from prior responses' `targetAxis` field. Added
   *  2026-07-15 so the agent can avoid picking the same axis batch after
   *  batch — without this, "mainstream" tends to get targeted for many
   *  consecutive batches, which skews several questions in a row toward
   *  the same kind of blockbuster. Only meaningful once phase ===
   *  "deep_dive"; the client can omit or ignore this during screening. */
  recentTargetAxes?: AxisId[];
  /** Free-text theory about this specific person's taste (e.g. "seems to
   *  gravitate toward slow-paced, morally ambiguous crime dramas, often
   *  non-English"), from an earlier response's `tasteHypothesis` field —
   *  same echo-back pattern as `plan`. Added 2026-07-15: the 4 axes alone
   *  don't capture "what kind of movies does this person actually like,"
   *  just coarse H/L-N/O-M/U-W/F buckets. Omit while phase === "screening". */
  tasteHypothesis?: string;
}

export interface NextBatchResponse {
  batch: QuestionMovie[];
  /** Where this batch came from — silent to the *user*, but visible in the
   *  response for logging/demo-instrumentation (docs/adr/0001):
   *  - "preset": screening phase, always — the curated fallback pool by
   *    design, not a failure.
   *  - "agent": deep_dive phase, the live TMDb+LLM agent worked.
   *  - "fallback": deep_dive phase, the live agent/TMDb failed and the
   *    pool was used as the safety net instead. */
  source: "agent" | "fallback" | "preset";
  /** The axis the agent targeted for this batch. Present only when
   *  source === "agent" (preset/fallback batches have no agent decision
   *  behind them). The client should track the last few of these and echo
   *  them back as `recentTargetAxes` on the next request, so the agent can
   *  see its own recent pattern and deliberately rotate axes. */
  targetAxis?: AxisId;
  /** Present on every response where the hypothesis checkpoint ran: the
   *  first deep_dive response, and then periodically again every 10
   *  questions through the rest of deep_dive (2026-07-15 — a plan formed
   *  from only the 20 screening answers goes stale over 60 more
   *  questions). The client must persist the latest one and echo it back
   *  as `plan` on every subsequent deep_dive call, overwriting the
   *  previous value each time a new checkpoint arrives. */
  checkpoint?: CheckpointPlan;
  /** Present alongside `checkpoint` (same timing — first deep_dive
   *  response, then periodically). The client persists and echoes it back
   *  as `tasteHypothesis`, same pattern as `plan`. */
  tasteHypothesis?: string;
  /** The question-agent's own free-text explanation for this batch's pick
   *  (prompts/question-agent.md's `reasoning` field) — present only when
   *  source === "agent". Not used by any scoring/selection logic; purely
   *  for local debugging (console-logged client-side, docs/adr/0006-adjacent
   *  2026-07-17 addition) so the agent's reasoning is inspectable without a
   *  separate logging pipeline. */
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// POST /api/flourish
//
// Called once, after all 80 answers, once scoring.ts has produced the final
// type code client-side.
// ---------------------------------------------------------------------------

export interface FlourishRequest {
  /** e.g. "HNMW", computed client-side by scoring.ts. */
  typeCode: string;
  /** All 4 axis scores, so the result-writer agent can describe the
   *  person's overall taste pattern (why they landed on this type among
   *  the 16), not just react to one movie in isolation. Added 2026-07-15
   *  per user feedback that the flourish read as too narrowly fixated on
   *  the signature movie. */
  axisScores: AxisScores;
  /** 3-5 movies. */
  topRatedMovies: RatedMovie[];
  /** The movie where the user's rating deviated most from tmdbVoteAverage. */
  signatureMovie: RatedMovie & {
    /** rating (normalized to 0-10) minus tmdbVoteAverage; signed. */
    deviation: number;
  };
  /** From the hypothesis-agent checkpoint, if deep_dive reached it (absent
   *  for low-signal sessions). Added 2026-07-17 so result-writer has a
   *  specific, content-level claim to lead with instead of only axis
   *  leanings — see prompts/result-writer.md's rewritten Task section
   *  (the prior version's fixed "lead with genre" formula, reinforced by
   *  few-shot examples that all opened with the same phrase, was producing
   *  near-identical-shaped output across different types). */
  tasteHypothesis?: string;
  /** The *first* hypothesis checkpoint's tasteHypothesis (Q21, before 60
   *  more questions of evidence), distinct from `tasteHypothesis` above
   *  (which is always the latest). Lets result-writer contrast an early
   *  read against the final one. Absent whenever `tasteHypothesis` is
   *  absent (both come from the same low-signal gate). */
  earlyTasteHypothesis?: string;
}

export interface FlourishResponse {
  status: "ok" | "fallback";
  /** null iff status === "fallback". The backend holds no fallback copy
   *  itself (type_descriptions.json is client-side only) — this is purely
   *  a signal to render the local static template. */
  comment: string | null;
}

// ---------------------------------------------------------------------------
// POST /api/recommend-similar
//
// "You might like these movies" (result screen, docs/adr/0006). Called once,
// after /api/flourish's inputs are available. Two independent endpoints
// (this one and /api/recommend-horizon below) rather than one combined
// endpoint, specifically so the frontend can show each list's own loading
// spinner and let either fail without blocking the other — a single shared
// endpoint can only respond once both pipelines finish.
// ---------------------------------------------------------------------------

/** One candidate seed for the TMDb "similar movies" lookup. A deliberately
 *  thin slice of RatedMovie (no tmdbVoteAverage/originalLanguage — the agent
 *  doesn't need them to judge representativeness) plus the `tmdbId` RatedMovie
 *  itself omits (RatedMovie is shaped for LLM prose input, never used to
 *  make a follow-up API call before now). */
export interface RecommendSeed {
  tmdbId: number;
  title: string;
  year: number;
  genres: string[];
  /** 1-5, the user's own rating. */
  rating: number;
}

export interface RecommendSimilarRequest {
  /** Up to 5 candidates, already narrowed/ordered client-side — deep-dive
   *  phase (Q21-80) ratings preferred over screening-phase (Q1-20) ones,
   *  since screening always draws from the same small fallback_pool.json
   *  and would otherwise make this list converge across sessions
   *  (CONTEXT.md "スクリーニング（プリセット）由来データの弱体化"). The
   *  agent picks 1-2 of these; it never sees the person's full history. */
  candidateSeeds: RecommendSeed[];
  /** From the hypothesis-agent checkpoint, if deep_dive reached it — helps
   *  the agent judge which seed best represents overall taste rather than
   *  just picking the single highest rating. */
  tasteHypothesis?: string;
  /** TMDb ids to exclude from results (already-shown quiz movies; the
   *  backend also excludes candidateSeeds' own ids so a movie can't
   *  recommend itself back). */
  shownMovieIds: number[];
}

export interface RecommendSimilarResponse {
  status: "ok" | "fallback";
  /** Null iff status === "fallback" — there is no static fallback content
   *  for this list (unlike FlourishResponse), so the frontend omits the
   *  whole section rather than showing a substitute. When present, up to
   *  ~10 movies (a display slice of 5 plus a backfill buffer the frontend
   *  draws from if a movie collides with the other recommendation list). */
  movies: QuestionMovie[] | null;
  /** The agent's own free-text explanation for which seed(s) it picked
   *  (prompts/recommend-similar-agent.md's `reasoning` field). Debugging
   *  aid only, console-logged client-side — see NextBatchResponse.reasoning. */
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// POST /api/recommend-horizon
//
// "Movies that could broaden your horizon" (result screen, docs/adr/0006).
// Called once, concurrently with /api/recommend-similar.
// ---------------------------------------------------------------------------

export interface RecommendHorizonRequest {
  axisScores: AxisScores;
  /** Same shape as functions/api/_lib/agents.ts's tallyGenreCoverage output,
   *  but computed client-side and weighted the same way as
   *  RecommendSimilarRequest.candidateSeeds: deep-dive-phase answers
   *  preferred, screening-phase folded back in only when there isn't
   *  enough deep-dive data to tally from. */
  genreCoverage: Record<string, number>;
  languageCoverage: Record<string, number>;
  shownMovieIds: number[];
}

export interface RecommendHorizonResponse {
  status: "ok" | "fallback";
  /** Same null/omit-on-failure and display-slice-plus-buffer shape as
   *  RecommendSimilarResponse.movies. */
  movies: QuestionMovie[] | null;
  /** Same debugging-aid purpose as RecommendSimilarResponse.reasoning,
   *  sourced from prompts/recommend-horizon-agent.md's `reasoning` field. */
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Errors — reserved for genuine HTTP-level failures (malformed request body,
// unknown route). LLM/TMDb degradation is NEVER surfaced this way; it's
// always a 200 with source/status set accordingly above.
// ---------------------------------------------------------------------------

export interface ApiErrorResponse {
  error: {
    code: "invalid_request" | "internal_error";
    message: string;
  };
}
