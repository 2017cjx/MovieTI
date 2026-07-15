import type { QuestionMovie } from "../api-types";

/**
 * One quiz question's outcome. `rating` is present iff `seen` — a "seen"
 * answer always requires a star rating (CONTEXT.md "回答フロー", no skip).
 */
export interface Answer {
  movie: QuestionMovie;
  seen: boolean;
  /** 1-5, present iff seen. */
  rating?: number;
}
