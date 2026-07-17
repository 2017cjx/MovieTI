import { useState } from "react";
import "./App.css";
import { useMovieBuffer } from "./hooks/useMovieBuffer";
import { useQuizState } from "./hooks/useQuizState";
import { IntroScreen } from "./IntroScreen";
import { ResultScreen } from "./ResultScreen";

const TOTAL_QUESTIONS = 80;
// 4-way tap (CONTEXT.md "回答フロー", revised 2026-07-15): a neutral
// "seen it" rating told us nothing about whether the person actually
// liked the movie, so "seen" is split into Disliked/Liked/Super Like.
// SCORING_CONSTANTS.HIGH_RATING_THRESHOLD (4) means both Liked and Super
// Like count as "highly rated" downstream — intentional, both are
// genuine positive signal now, not just the top tier.
const DISLIKED_RATING = 2;
const LIKED_RATING = 4;
const SUPER_LIKE_RATING = 5;

function App() {
  const quiz = useQuizState();
  // Only a fresh session (no restored answers) needs the intro — resuming
  // an in-progress quiz after a reload should never show it again.
  const [hasStarted, setHasStarted] = useState(quiz.answers.length > 0);
  const buffer = useMovieBuffer({
    getContext: () => ({
      axisScores: quiz.axisScores,
      ratedMoviesSoFar: quiz.ratedMoviesSoFar,
      plan: quiz.checkpoint,
      tasteHypothesis: quiz.tasteHypothesis,
    }),
    onCheckpoint: quiz.setCheckpoint,
    onTasteHypothesis: quiz.setTasteHypothesis,
    initialDispatchedCount: quiz.answers.length,
    initialShownMovieIds: quiz.answers.map((a) => a.movie.tmdbId),
    totalQuestionCount: TOTAL_QUESTIONS,
  });

  if (!hasStarted) {
    return <IntroScreen onStart={() => setHasStarted(true)} />;
  }

  if (buffer.isComplete) {
    return (
      <ResultScreen
        answers={quiz.answers}
        tasteHypothesis={quiz.tasteHypothesis}
        cachedRecommendSimilar={quiz.recommendSimilar}
        cachedRecommendHorizon={quiz.recommendHorizon}
        onRecommendSimilarResolved={quiz.setRecommendSimilar}
        onRecommendHorizonResolved={quiz.setRecommendHorizon}
      />
    );
  }

  if (buffer.error) {
    return (
      <main className="screen">
        <p>Something went wrong loading the next movie.</p>
        <button onClick={buffer.retry}>Try again</button>
      </main>
    );
  }

  if (buffer.isLoading || !buffer.currentMovie) {
    return (
      <main className="screen">
        <p>Loading...</p>
      </main>
    );
  }

  const movie = buffer.currentMovie;
  const answeredCount = quiz.answers.length;

  function handleNotSeen() {
    quiz.recordAnswer(movie, false);
    buffer.advance();
  }

  function handleDisliked() {
    quiz.recordAnswer(movie, true, DISLIKED_RATING);
    buffer.advance();
  }

  function handleLiked() {
    quiz.recordAnswer(movie, true, LIKED_RATING);
    buffer.advance();
  }

  function handleSuperLike() {
    quiz.recordAnswer(movie, true, SUPER_LIKE_RATING);
    buffer.advance();
  }

  return (
    <main className="screen">
      <div className="progress-bar">
        <div
          className="progress-bar-fill"
          style={{ width: `${(answeredCount / TOTAL_QUESTIONS) * 100}%` }}
        />
      </div>
      <p className="progress-label">
        {answeredCount}/{TOTAL_QUESTIONS}
      </p>

      <div className="movie-card">
        {movie.posterPath && (
          <img
            className="movie-poster"
            src={`https://image.tmdb.org/t/p/w342${movie.posterPath}`}
            alt={movie.title}
          />
        )}
        <div className="movie-overlay">
          <div className="movie-info">
            <h2>{movie.title}</h2>
            <p className="movie-year">{movie.year}</p>
          </div>

          <div className="tinder-row">
            <button className="not-seen-button" onClick={handleNotSeen} aria-label="Haven't seen it">
              <span className="tinder-icon">✕</span>
            </button>
            <button className="disliked-button" onClick={handleDisliked} aria-label="Didn't like it">
              <span className="tinder-icon">−</span>
            </button>
            <button className="liked-button" onClick={handleLiked} aria-label="Okay">
              <span className="tinder-icon">✓</span>
            </button>
            <button className="super-like-button" onClick={handleSuperLike} aria-label="Super like">
              <span className="tinder-icon">★</span>
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

export default App;
