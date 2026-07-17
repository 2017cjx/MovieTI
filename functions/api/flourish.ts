/**
 * POST /api/flourish — live implementation. Calls the result-writer agent
 * (functions/api/_lib/agents.ts, "cinema therapist" persona) to generate
 * the user-facing LLM paragraph. Falls back to status: "fallback" (the
 * frontend shows the static type_descriptions.json template alone) if the
 * LLM call fails or never produces valid output after retries.
 */

import type { ApiErrorResponse, FlourishRequest, FlourishResponse } from "../../src/api-types";
import { runResultWriter, type Env as AgentEnv } from "./_lib/agents";

type Env = AgentEnv;

function isValidRequest(body: unknown): body is FlourishRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.typeCode === "string" &&
    typeof b.axisScores === "object" &&
    b.axisScores !== null &&
    Array.isArray(b.topRatedMovies) &&
    typeof b.signatureMovie === "object" &&
    b.signatureMovie !== null
  );
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    const error: ApiErrorResponse = {
      error: { code: "invalid_request", message: "Request body must be valid JSON." },
    };
    return Response.json(error, { status: 400 });
  }

  if (!isValidRequest(body)) {
    const error: ApiErrorResponse = {
      error: { code: "invalid_request", message: "Request body does not match FlourishRequest." },
    };
    return Response.json(error, { status: 400 });
  }

  const result = await runResultWriter(
    {
      typeCode: body.typeCode,
      axisScores: body.axisScores,
      topRatedMovies: body.topRatedMovies,
      signatureMovie: body.signatureMovie,
      tasteHypothesis: body.tasteHypothesis,
      earlyTasteHypothesis: body.earlyTasteHypothesis,
    },
    context.env,
  );

  const response: FlourishResponse = result;
  return Response.json(response);
};
