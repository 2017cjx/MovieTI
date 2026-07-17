import type { QuestionMovie } from "../../../src/api-types";

/** Only the keys prompts/question-agent.md is allowed to emit. */
export interface DiscoverParams {
  with_genres?: number[];
  "primary_release_date.gte"?: string;
  "primary_release_date.lte"?: string;
  "vote_count.gte"?: number;
  /** Caps how huge a hit the movie is — TMDb has no budget filter, so this
   *  is the closest lever for "not a mega-blockbuster" (mid/small-budget,
   *  regional cinema). Added 2026-07-15 for the diversity fix. */
  "vote_count.lte"?: number;
  "vote_average.gte"?: number;
  "vote_average.lte"?: number;
  /** ISO 639-1 (e.g. "ja", "ko", "fr"). Added 2026-07-15 for the diversity fix. */
  with_original_language?: string;
  /** ISO 3166-1 (e.g. "HK", "JP", "FR"). Added 2026-07-15 for the diversity fix. */
  with_origin_country?: string;
  sort_by?: string;
}

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
/** Recognizability guardrail (docs/adr/0001; raised 2026-07-15 from 500 —
 *  500 let genuinely obscure titles through, which user testing found
 *  "not fun" to rate blind. 2000 keeps the "underground" end of the
 *  mainstream axis at indie/arthouse-recognizable rather than unknown. */
const MIN_VOTE_COUNT_GUARDRAIL = 2000;
/** Relaxation floor for recommend-horizon.ts specifically — smaller genres
 *  (Documentary confirmed via live testing 2026-07-17: only 1 movie exists
 *  at the 2000 floor, vs. 83 at 500) are inherently lower-vote-count on
 *  TMDb, and a horizon-list suggestion isn't a blind-rating question where
 *  recognizability matters the way it does during the quiz. Still well
 *  above "unknown," just not "instantly recognizable." */
export const HORIZON_RELAXED_VOTE_COUNT_FLOOR = 500;
/** No real TMDb movie has vote_count anywhere near this; clamps
 *  LLM-hallucinated values (observed in testing: e.g. 1,000,000) that
 *  would otherwise make TMDb return zero results. */
const MAX_PLAUSIBLE_VOTE_COUNT = 50000;
/** Default ceiling applied only when the agent didn't set vote_count.lte
 *  itself AND isn't deliberately reaching for a maximal-popularity title
 *  (sort_by popularity.desc — the one case prompts/question-agent.md
 *  documents as an intentional blockbuster-extreme test for the mainstream
 *  axis). Otherwise, an agent call that just omits vote_count.lte would
 *  silently be free to surface mega-franchise hits every time. Added
 *  2026-07-15 alongside the recognizability floor above. */
const DEFAULT_VOTE_COUNT_CEILING = 20000;
/** TMDb company IDs for Disney/Marvel/Pixar/Lucasfilm — user feedback
 *  2026-07-15: these franchises were dominating batches and crowding out
 *  everything else, so originally hard-excluded via `without_companies`.
 *  2026-07-17 (follow-up user feedback): fully excluding them was too
 *  strict — some franchise content is fine, just not dominant. Changed
 *  from a hard `without_companies` exclusion to a soft per-list/per-session
 *  cap (see FRANCHISE_CAP_PER_LIST, capFranchiseMovies()) enforced by
 *  checking each candidate's actual `production_companies` (only available
 *  from TMDb's movie-detail endpoint, not the list/discover/recommendations
 *  responses this file otherwise works with). */
const EXCLUDED_COMPANY_IDS = [2, 3, 1, 420, 6125, 7505];
const EXCLUDED_COMPANY_ID_SET = new Set(EXCLUDED_COMPANY_IDS);
/** Default cap for a single self-contained list build (the 2 result-screen
 *  recommendation lists) — next-batch.ts computes its own, session-tracked
 *  cap for the quiz instead of using this constant directly. */
export const FRANCHISE_CAP_PER_LIST = 3;

/** `voteCountFloor` defaults to MIN_VOTE_COUNT_GUARDRAIL (the "must be
 *  recognizable enough to blind-rate" bar the quiz needs) but callers may
 *  pass a lower one — recommend-horizon.ts does, as a relaxation retry,
 *  since smaller genres (Documentary confirmed via live testing: only 1
 *  movie exists at all at the 2000 floor, vs. 83 at 500) are inherently
 *  lower-vote-count on TMDb, and the horizon list isn't a blind-rating
 *  question where recognizability matters the same way. */
function sanitizeParams(params: DiscoverParams, voteCountFloor: number = MIN_VOTE_COUNT_GUARDRAIL): DiscoverParams {
  const clean: DiscoverParams = { ...params };
  const voteCountGte = clean["vote_count.gte"] ?? voteCountFloor;
  clean["vote_count.gte"] = Math.min(Math.max(voteCountGte, voteCountFloor), MAX_PLAUSIBLE_VOTE_COUNT);
  if (clean["vote_count.lte"] === undefined && clean.sort_by !== "popularity.desc") {
    if (clean["vote_count.gte"] < DEFAULT_VOTE_COUNT_CEILING) {
      clean["vote_count.lte"] = DEFAULT_VOTE_COUNT_CEILING;
    }
  }
  if (clean["vote_count.lte"] !== undefined) {
    // Must stay >= vote_count.gte, or the range is impossible (0 results).
    clean["vote_count.lte"] = Math.max(clean["vote_count.lte"], clean["vote_count.gte"]);
  }
  if (clean["vote_average.gte"] !== undefined) {
    clean["vote_average.gte"] = Math.max(0, Math.min(10, clean["vote_average.gte"]));
  }
  if (clean["vote_average.lte"] !== undefined) {
    clean["vote_average.lte"] = Math.max(0, Math.min(10, clean["vote_average.lte"]));
  }
  if (
    clean["primary_release_date.gte"] !== undefined &&
    clean["primary_release_date.lte"] !== undefined &&
    clean["primary_release_date.gte"] > clean["primary_release_date.lte"]
  ) {
    // An inverted range (gte after lte) always returns zero results — drop
    // gte rather than let a malformed agent output (observed from
    // recommend-horizon-agent.md during testing: gte 2005, lte 1999 in the
    // same response) silently produce an empty candidate pool. String
    // comparison is safe here since both are ISO 8601 dates (YYYY-MM-DD),
    // which sort lexicographically the same as chronologically.
    delete clean["primary_release_date.gte"];
  }
  return clean;
}

interface TmdbMovieResult {
  id: number;
  title: string;
  release_date: string;
  poster_path: string | null;
  genre_ids: number[];
  vote_count: number;
  vote_average: number;
  original_language: string;
}

interface TmdbGenre {
  id: number;
  name: string;
}

/** How many of TMDb's result pages (20 movies each) are treated as "in
 *  play" for a single discover call. Always taking page 1 would mean
 *  always taking the literal top-20 by whatever sort_by is in effect —
 *  deterministic and blockbuster-heavy regardless of sort order, since
 *  "top 20 by popularity" and "top 20 by rating" are both narrow, famous
 *  slices of the full matching set. Picking a random page within this
 *  range instead samples much more broadly. Capped at 10 (not TMDb's
 *  max of 500) so results stay within the metadata-quality-guardrailed,
 *  reasonably-attested part of the catalog. */
const MAX_PAGE_POOL = 10;

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Workers isolates are frequently reused across requests, so this
// module-level cache avoids re-fetching TMDb's near-static genre list on
// every /api/next-batch call within the same isolate's lifetime.
let genreMapCache: Map<number, string> | null = null;

async function getGenreMap(accessToken: string): Promise<Map<number, string>> {
  if (genreMapCache) return genreMapCache;
  const res = await fetch(`${TMDB_BASE_URL}/genre/movie/list?language=en-US`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`TMDb genre list failed: ${res.status}`);
  const data = (await res.json()) as { genres: TmdbGenre[] };
  genreMapCache = new Map(data.genres.map((g) => [g.id, g.name]));
  return genreMapCache;
}

/** Reverse of getGenreMap — used by recommend-horizon.ts to resolve a
 *  genre *name* (from RecommendHorizonRequest.genreAffinity, which is
 *  keyed by name since that's what QuestionMovie.genres already stores)
 *  into the numeric TMDb id discover_params actually needs, deterministically
 *  server-side rather than asking the LLM to recall/invent the id itself
 *  (live-tested 2026-07-17: the model hallucinated invalid genre ids —
 *  e.g. 23, 34, 2, none of which exist — a meaningful fraction of the
 *  time when left to do this translation on its own). */
export async function getGenreNameToId(accessToken: string): Promise<Map<string, number>> {
  const map = await getGenreMap(accessToken);
  const reversed = new Map<string, number>();
  for (const [id, name] of map) reversed.set(name, id);
  return reversed;
}

interface TmdbMovieDetail {
  production_companies: { id: number }[];
}

/** TMDb's list/discover/recommendations responses don't include company
 *  info (confirmed by inspecting the live response shape 2026-07-17) — only
 *  the single-movie detail endpoint does, hence one extra request per
 *  candidate being checked. */
async function isFranchiseMovie(tmdbId: number, accessToken: string): Promise<boolean> {
  const res = await fetch(`${TMDB_BASE_URL}/movie/${tmdbId}?language=en-US`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return false; // fails open — a detail-lookup hiccup shouldn't sink the candidate
  const data = (await res.json()) as TmdbMovieDetail;
  return data.production_companies.some((c) => EXCLUDED_COMPANY_ID_SET.has(c.id));
}

/** Walks `candidates` in order, admitting up to `count` total but at most
 *  `franchiseCap` Disney/Marvel/Pixar/Lucasfilm titles among them — a soft
 *  cap, not the hard exclusion this replaced (2026-07-17, user feedback:
 *  full exclusion was too strict, some franchise content is fine, just not
 *  dominant). Checks every candidate's franchise status in parallel up
 *  front rather than sequentially per admission decision, since the
 *  decision for candidate N can depend on how many franchise slots
 *  candidates before it already used. */
async function capFranchiseMovies(
  candidates: TmdbMovieResult[],
  accessToken: string,
  count: number,
  franchiseCap: number,
): Promise<Array<{ movie: TmdbMovieResult; isFranchise: boolean }>> {
  const isFranchiseFlags = await Promise.all(
    candidates.map((m) => isFranchiseMovie(m.id, accessToken)),
  );
  const picked: Array<{ movie: TmdbMovieResult; isFranchise: boolean }> = [];
  let franchiseUsed = 0;
  for (let i = 0; i < candidates.length && picked.length < count; i++) {
    if (isFranchiseFlags[i]) {
      if (franchiseUsed >= franchiseCap) continue;
      franchiseUsed++;
    }
    picked.push({ movie: candidates[i], isFranchise: isFranchiseFlags[i] });
  }
  return picked;
}

function buildQuery(clean: DiscoverParams, page: number): URLSearchParams {
  const query = new URLSearchParams({ language: "en-US", page: String(page) });
  if (clean.with_genres?.length) query.set("with_genres", clean.with_genres.join(","));
  if (clean["primary_release_date.gte"]) {
    query.set("primary_release_date.gte", clean["primary_release_date.gte"]);
  }
  if (clean["primary_release_date.lte"]) {
    query.set("primary_release_date.lte", clean["primary_release_date.lte"]);
  }
  if (clean["vote_count.gte"] !== undefined) {
    query.set("vote_count.gte", String(clean["vote_count.gte"]));
  }
  if (clean["vote_count.lte"] !== undefined) {
    query.set("vote_count.lte", String(clean["vote_count.lte"]));
  }
  if (clean["vote_average.gte"] !== undefined) {
    query.set("vote_average.gte", String(clean["vote_average.gte"]));
  }
  if (clean["vote_average.lte"] !== undefined) {
    query.set("vote_average.lte", String(clean["vote_average.lte"]));
  }
  if (clean.with_original_language) {
    query.set("with_original_language", clean.with_original_language);
  }
  if (clean.with_origin_country) {
    query.set("with_origin_country", clean.with_origin_country);
  }
  // No longer a hard `without_companies` exclusion (2026-07-17) — see
  // EXCLUDED_COMPANY_IDS's updated comment. Franchise presence is now
  // capped, not blocked, via capFranchiseMovies() after fetching.
  // Default to quality (critical reception), not popularity — an agent
  // call that omits sort_by should not silently skew toward blockbusters.
  query.set("sort_by", clean.sort_by ?? "vote_average.desc");
  return query;
}

async function fetchDiscoverPage(
  clean: DiscoverParams,
  accessToken: string,
  page: number,
): Promise<{ results: TmdbMovieResult[]; totalPages: number }> {
  const res = await fetch(
    `${TMDB_BASE_URL}/discover/movie?${buildQuery(clean, page).toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`TMDb discover failed: ${res.status}`);
  const data = (await res.json()) as { results: TmdbMovieResult[]; total_pages: number };
  return { results: data.results, totalPages: data.total_pages };
}

/** Queries TMDb `discover/movie` and returns up to `count` movies, already
 *  filtered against `excludeIds`. May return fewer than `count` (or zero)
 *  if TMDb's result set is thin after filtering — the caller
 *  (functions/api/next-batch.ts) treats that as a failure and falls back
 *  to the fallback pool, so this function does not backfill itself.
 *  `franchiseCap` limits how many Disney/Marvel/Pixar/Lucasfilm titles may
 *  be among the results — 0 to exclude entirely, matching the old hard
 *  `without_companies` behavior this replaced. `voteCountFloor` defaults to
 *  the standard recognizability guardrail; see sanitizeParams's doc comment
 *  for when a caller passes a lower one. */
export async function discoverMovies(
  params: DiscoverParams,
  accessToken: string,
  excludeIds: number[],
  count: number,
  franchiseCap: number,
  voteCountFloor: number = MIN_VOTE_COUNT_GUARDRAIL,
): Promise<QuestionMovie[]> {
  const clean = sanitizeParams(params, voteCountFloor);

  // First page also tells us how many pages exist, so we know the real
  // range to pick a random page from.
  const first = await fetchDiscoverPage(clean, accessToken, 1);
  const pagePool = Math.min(first.totalPages, MAX_PAGE_POOL);
  const page = pagePool > 1 ? 1 + Math.floor(Math.random() * pagePool) : 1;
  let { results } = page === 1 ? first : await fetchDiscoverPage(clean, accessToken, page);
  // Trailing pages are often sparse (the last page of a narrow query might
  // have only a handful of results) — if the random page came back too
  // thin to fill the batch, fall back to page 1, which TMDb always fills
  // to 20 whenever total_results allows it.
  if (page !== 1 && results.length < count) {
    results = first.results;
  }

  const genreMap = await getGenreMap(accessToken);
  const excluded = new Set(excludeIds);
  const candidates = shuffle(results).filter(
    (m) => !excluded.has(m.id) && m.release_date && m.poster_path,
  );
  const picked = await capFranchiseMovies(candidates, accessToken, count, franchiseCap);
  return picked.map(({ movie: m, isFranchise }) => ({
    tmdbId: m.id,
    title: m.title,
    year: Number(m.release_date.slice(0, 4)),
    posterPath: m.poster_path,
    genres: m.genre_ids.map((id) => genreMap.get(id)).filter((g): g is string => !!g),
    voteCount: m.vote_count,
    voteAverage: Math.round(m.vote_average * 10) / 10,
    originalLanguage: m.original_language,
    isFranchise,
  }));
}

/** Queries TMDb `/movie/{id}/recommendations` for each seed id and merges
 *  the results, deduped. Used by functions/api/recommend-similar.ts
 *  (docs/adr/0006) — unlike discoverMovies(), this endpoint takes no
 *  query-parameter filters at all (it's "movies like this one", not a
 *  search), so vote_count/language guardrails can't be requested from TMDb
 *  directly; the vote_count floor and poster/release_date completeness are
 *  enforced by filtering the response instead. Franchise presence is
 *  capped the same way as discoverMovies() (see capFranchiseMovies()),
 *  just via a per-candidate detail lookup instead of a query param, since
 *  this endpoint has no `without_companies`-equivalent filter at all. */
export async function getMovieRecommendations(
  seedTmdbIds: number[],
  accessToken: string,
  excludeIds: number[],
  count: number,
  franchiseCap: number,
): Promise<QuestionMovie[]> {
  const genreMap = await getGenreMap(accessToken);
  const excluded = new Set(excludeIds);
  const seenIds = new Set<number>();
  const merged: TmdbMovieResult[] = [];

  for (const seedId of seedTmdbIds) {
    const res = await fetch(
      `${TMDB_BASE_URL}/movie/${seedId}/recommendations?language=en-US&page=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    // One bad/unrecognized seed id shouldn't sink the whole call — the
    // other seed (if any) may still produce usable results.
    if (!res.ok) continue;
    const data = (await res.json()) as { results: TmdbMovieResult[] };
    for (const m of data.results) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      merged.push(m);
    }
  }

  const candidates = shuffle(merged).filter(
    (m) =>
      !excluded.has(m.id) &&
      m.release_date &&
      m.poster_path &&
      m.vote_count >= MIN_VOTE_COUNT_GUARDRAIL,
  );
  const picked = await capFranchiseMovies(candidates, accessToken, count, franchiseCap);
  return picked.map(({ movie: m, isFranchise }) => ({
    tmdbId: m.id,
    title: m.title,
    year: Number(m.release_date.slice(0, 4)),
    posterPath: m.poster_path,
    genres: m.genre_ids.map((id) => genreMap.get(id)).filter((g): g is string => !!g),
    voteCount: m.vote_count,
    voteAverage: Math.round(m.vote_average * 10) / 10,
    originalLanguage: m.original_language,
    isFranchise,
  }));
}
