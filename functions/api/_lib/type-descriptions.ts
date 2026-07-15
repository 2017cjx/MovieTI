import typeDescriptions from "../../../data/type_descriptions.json";

const GENERIC_TYPE_NAME = "The Undiscovered Type";

/** Only what the backend needs from type_descriptions.json: the headline
 *  name, to pass to the result-writer agent as `type_name`
 *  (prompts/result-writer.md). The full template/body rendering stays
 *  client-side only (src/lib/typeDescriptions.ts) — the backend never
 *  needs it. */
export function getTypeName(code: string): string {
  const entry = (typeDescriptions as Record<string, { name: string } | undefined>)[code];
  return entry?.name ?? GENERIC_TYPE_NAME;
}
