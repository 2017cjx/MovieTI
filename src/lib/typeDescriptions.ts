/**
 * Loader/renderer for data/type_descriptions.json. Schema decided via
 * /design-an-interface — see CONTEXT.md "フォールバックプール" (the
 * "スキーマ" addendum covers both fallback_pool.json and this file).
 */

import raw from "../../data/type_descriptions.json";
import type { FlourishRequest } from "../api-types";

export interface TypeEntry {
  name: string;
  tagline?: string;
  /** Plain text with {{token}} placeholders (fixed vocabulary below).
   *  Unknown tokens are left as literal text, never thrown — a typo in
   *  authored copy should degrade visibly, not crash the result screen. */
  body: string;
}

export type TypeDescriptions = Partial<Record<string, TypeEntry>>;

export interface TypeDescriptionData {
  signatureMovie: FlourishRequest["signatureMovie"];
  topRatedMovies: FlourishRequest["topRatedMovies"];
  ratedCount: number;
  topGenre: string;
}

const typeDescriptions = raw as TypeDescriptions;

// Should be unreachable in practice — all 16 type codes are authored in
// type_descriptions.json — but kept as a defensive fallback rather than
// crashing the result screen if a code somehow doesn't match. Written to
// read naturally on its own, not as a visible "this broke" message.
const GENERIC_ENTRY: TypeEntry = {
  name: "The Undiscovered Type",
  body:
    "Across {{ratedCount}} movies, your signature pick was {{signatureMovie}}, " +
    "which you rated {{signatureDirection}} the crowd. Favorites like {{topMovies}} " +
    "round out a taste for {{topGenre}} that doesn't sit neatly in one box.",
};

export function getTypeEntry(code: string): TypeEntry {
  return typeDescriptions[code] ?? GENERIC_ENTRY;
}

function formatMovie(movie: { title: string; year: number }): string {
  return `${movie.title} (${movie.year})`;
}

function formatDirection(deviation: number): string {
  return deviation >= 0 ? "well above" : "well below";
}

const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;

export function renderTypeDescription(
  entry: TypeEntry,
  data: TypeDescriptionData,
): { name: string; tagline?: string; body: string } {
  const values: Record<string, string> = {
    signatureMovie: formatMovie(data.signatureMovie),
    signatureDirection: formatDirection(data.signatureMovie.deviation),
    topMovies: data.topRatedMovies.map(formatMovie).join(", "),
    ratedCount: String(data.ratedCount),
    topGenre: data.topGenre,
  };
  const body = entry.body.replace(TOKEN_PATTERN, (match, token: string) =>
    token in values ? values[token] : match,
  );
  return { name: entry.name, tagline: entry.tagline, body };
}
