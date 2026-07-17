import { useCallback, useEffect, useState } from "react";
import type {
  AxisId,
  FlourishRequest,
  FlourishResponse,
  QuestionMovie,
  RatedMovie,
  RecommendHorizonRequest,
  RecommendSimilarRequest,
} from "./api-types";
import { STORAGE_KEY } from "./hooks/useQuizState";
import { useRecommendations, type RecommendListState } from "./hooks/useRecommendations";
import { getTypeEntry, renderTypeDescription } from "./lib/typeDescriptions";
import { pickCoverageTallies, pickRecommendSeeds } from "./lib/recommendations";
import { computeScores, SCORING_CONSTANTS } from "./scoring";
import type { Answer } from "./types/answer";

function handleRestart() {
  localStorage.removeItem(STORAGE_KEY);
  window.location.reload();
}

/** name + [negative-leaning label, positive-leaning label] — matches the
 *  sign convention computeScores() uses when deriving typeCode
 *  (scoring.ts): a positive score leans toward the *second* label/letter. */
const AXIS_META: Record<AxisId, { name: string; labels: [string, string] }> = {
  volume: { name: "Volume", labels: ["Light", "Heavy"] },
  era: { name: "Era", labels: ["Old", "New"] },
  mainstream: { name: "Mainstream", labels: ["Underground", "Mainstream"] },
  genreWidth: { name: "Genre width", labels: ["Focused", "Wide"] },
};
const AXIS_ORDER: AxisId[] = ["volume", "era", "mainstream", "genreWidth"];

function toRatedMovie(item: { movie: Answer["movie"]; rating: number }): RatedMovie {
  return {
    title: item.movie.title,
    year: item.movie.year,
    genres: item.movie.genres,
    voteCount: item.movie.voteCount,
    rating: item.rating,
    tmdbVoteAverage: item.movie.voteAverage,
    originalLanguage: item.movie.originalLanguage,
  };
}

/** One of the two new result-screen lists (docs/adr/0006). `movies` follows
 *  useRecommendations.ts's tri-state: undefined shows a spinner, null omits
 *  the section entirely (fetch failed or was skipped for lack of data), an
 *  array renders the posters. Deliberately no "try again" affordance on
 *  failure, unlike the flourish text below — these are bonus sections on an
 *  already-complete result page, not its core content. */
function RecommendSection({ heading, movies }: { heading: string; movies: RecommendListState }) {
  if (movies === null) return null;
  return (
    <div className="recommend-section">
      <h2 className="script-heading">{heading}</h2>
      {movies === undefined ? (
        <div className="recommend-spinner" role="status" aria-label="Loading recommendations" />
      ) : (
        <div className="recommend-row">
          {movies.map((m) => (
            <img
              key={m.tmdbId}
              className="recommend-poster"
              src={m.posterPath ? `https://image.tmdb.org/t/p/w185${m.posterPath}` : undefined}
              alt={m.title}
              title={m.title}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function topGenreOf(answers: Answer[]): string {
  const counts = new Map<string, number>();
  for (const a of answers) {
    if (!a.seen || (a.rating ?? 0) < SCORING_CONSTANTS.HIGH_RATING_THRESHOLD) continue;
    for (const genre of a.movie.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  let best = "movies";
  let bestCount = -1;
  for (const [genre, count] of counts) {
    if (count > bestCount) {
      best = genre;
      bestCount = count;
    }
  }
  return best;
}

interface ResultScreenProps {
  answers: Answer[];
  tasteHypothesis?: string;
  earlyTasteHypothesis?: string;
  /** Present (including null) iff already fetched in an earlier visit to
   *  this result — see useRecommendations.ts for the caching contract. */
  cachedRecommendSimilar?: QuestionMovie[] | null;
  cachedRecommendHorizon?: QuestionMovie[] | null;
  onRecommendSimilarResolved: (movies: QuestionMovie[] | null) => void;
  onRecommendHorizonResolved: (movies: QuestionMovie[] | null) => void;
}

export function ResultScreen({
  answers,
  tasteHypothesis,
  earlyTasteHypothesis,
  cachedRecommendSimilar,
  cachedRecommendHorizon,
  onRecommendSimilarResolved,
  onRecommendHorizonResolved,
}: ResultScreenProps) {
  const result = computeScores(answers, { final: true });
  // Only one body of text is ever shown (2026-07-15 — showing the static
  // template *and* the live flourish stacked together read as redundant).
  // The live flourish is the primary content; the static
  // type_descriptions.json body is the fallback shown while it's loading
  // and if it fails, not a permanent second block.
  const [flourishText, setFlourishText] = useState<string | null>(null);
  const [flourishFailed, setFlourishFailed] = useState(false);

  const ratedSeen = answers.filter(
    (a): a is Answer & { rating: number } => a.seen && a.rating !== undefined,
  );
  const topRated = [...ratedSeen].sort((a, b) => b.rating - a.rating).slice(0, 5);
  const topRatedMovies = topRated.map(toRatedMovie);

  const typeCode = result.typeCode;
  const signature = result.signatureMovie;

  const fetchFlourish = useCallback(() => {
    if (!typeCode || !signature) return () => {};
    setFlourishFailed(false);
    const request: FlourishRequest = {
      typeCode,
      axisScores: result.axisScores,
      topRatedMovies,
      signatureMovie: { ...toRatedMovie(signature), deviation: signature.deviation },
      tasteHypothesis,
      earlyTasteHypothesis,
    };
    let cancelled = false;
    fetch("/api/flourish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    })
      .then((res) => res.json())
      .then((data: FlourishResponse) => {
        if (cancelled) return;
        if (data.comment) {
          setFlourishText(data.comment);
        } else {
          setFlourishFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFlourishFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Only re-run on typeCode change (mount); topRatedMovies/signature/
    // tasteHypothesis all come from the same final `answers`/persisted-quiz
    // snapshot as typeCode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeCode]);

  useEffect(() => fetchFlourish(), [fetchFlourish]);

  // Both requests are built unconditionally (hooks below can't be called
  // conditionally) — null means "not enough data," which useRecommendations
  // treats the same as a failed fetch (section stays omitted, no wasted
  // round-trip). See src/lib/recommendations.ts for why these are weighted
  // toward deep-dive-phase answers.
  const shownMovieIds = answers.map((a) => a.movie.tmdbId);
  const candidateSeeds = pickRecommendSeeds(answers);
  const { genreCoverage, languageCoverage } = pickCoverageTallies(answers);

  const similarRequest: RecommendSimilarRequest | null =
    candidateSeeds.length > 0 ? { candidateSeeds, tasteHypothesis, shownMovieIds } : null;
  const horizonRequest: RecommendHorizonRequest | null = typeCode
    ? { axisScores: result.axisScores, genreCoverage, languageCoverage, shownMovieIds }
    : null;

  const { similar: recommendSimilar, horizon: recommendHorizon } = useRecommendations({
    cachedSimilar: cachedRecommendSimilar,
    cachedHorizon: cachedRecommendHorizon,
    similarRequest,
    horizonRequest,
    onSimilarResolved: onRecommendSimilarResolved,
    onHorizonResolved: onRecommendHorizonResolved,
  });

  if (!typeCode || !signature) {
    return (
      <main className="screen">
        <h1>No verdict yet</h1>
        <p>You didn&apos;t rate any movies, so there&apos;s nothing to diagnose.</p>
        <button className="restart-button" onClick={handleRestart}>
          Retake the quiz
        </button>
      </main>
    );
  }

  const entry = getTypeEntry(typeCode);
  const rendered = renderTypeDescription(entry, {
    signatureMovie: { ...toRatedMovie(signature), deviation: signature.deviation },
    topRatedMovies,
    ratedCount: ratedSeen.length,
    topGenre: topGenreOf(answers),
  });

  return (
    <main className="screen result-screen">
      <p className="type-badge">{typeCode}</p>
      <h1>{rendered.name}</h1>
      {rendered.tagline && <p className="tagline">{rendered.tagline}</p>}
      {result.lowSignal && (
        <p className="tagline">
          You marked very few movies as seen, so this reads as a reference value rather than a
          confident type.
        </p>
      )}

      <div className="axis-panel">
        {AXIS_ORDER.map((id) => {
          const { name, labels } = AXIS_META[id];
          const fillPercent = ((result.axisScores[id].score + 1) / 2) * 100;
          return (
            <div className="axis-row" key={id}>
              <p className="axis-caption">
                {name} · {labels[0]} — {labels[1]}
              </p>
              <div className="axis-bar-line">
                <span className="axis-letter">{labels[0][0]}</span>
                <div className="axis-track">
                  <div className="axis-fill" style={{ width: `${fillPercent}%` }} />
                </div>
                <span className="axis-letter">{labels[1][0]}</span>
              </div>
            </div>
          );
        })}
      </div>

      <RecommendSection
        heading="Movies you super liked"
        movies={topRated.length > 0 ? topRated.map((a) => a.movie) : null}
      />

      <RecommendSection heading="You might like these movies" movies={recommendSimilar} />
      <RecommendSection
        heading="Movies that could broaden your horizon"
        movies={recommendHorizon}
      />

      <h2 className="script-heading">What kind of movies do I like?</h2>
      <p className="result-body">{flourishText ?? rendered.body}</p>
      {flourishFailed && !flourishText && (
        <button className="retry-flourish-button" onClick={fetchFlourish}>
          Try again
        </button>
      )}

      <button className="restart-button" onClick={handleRestart}>
        Retake the quiz
      </button>
    </main>
  );
}
