import { useCallback, useEffect, useState } from "react";
import type { AxisId, FlourishRequest, FlourishResponse, RatedMovie } from "./api-types";
import { STORAGE_KEY } from "./hooks/useQuizState";
import { getTypeEntry, renderTypeDescription } from "./lib/typeDescriptions";
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

export function ResultScreen({ answers }: { answers: Answer[] }) {
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
    // Only re-run on typeCode change (mount); topRatedMovies/signature come
    // from the same final `answers` snapshot as typeCode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeCode]);

  useEffect(() => fetchFlourish(), [fetchFlourish]);

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

      {topRated.length > 0 && (
        <div className="favorites-row">
          {topRated.map((a) => (
            <img
              key={a.movie.tmdbId}
              className="favorite-poster"
              src={
                a.movie.posterPath
                  ? `https://image.tmdb.org/t/p/w92${a.movie.posterPath}`
                  : undefined
              }
              alt={a.movie.title}
              title={a.movie.title}
            />
          ))}
        </div>
      )}

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
