/**
 * Shared "call LLM → validate → retry → fallback" primitive, used
 * internally by all 3 agent wrappers in ./agents.ts. Interface decided via
 * /design-an-interface — see CONTEXT.md "LLM呼び出し＋検証＋リトライ＋
 * フォールバックの共通処理". TAgent/TFallback are intentionally separate
 * type params: the question-agent's fallback (fallback-pool movies) is a
 * different shape than its success case (TMDb discover params).
 */

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface RunLlmTaskOptions<TAgent, TFallback = TAgent> {
  call: () => Promise<string>;
  validate: (raw: string) => ValidationResult<TAgent>;
  fallback: () => TFallback | Promise<TFallback>;
  timeoutMs?: number;
  maxAttempts?: number;
}

export type LlmTaskResult<TAgent, TFallback = TAgent> =
  | { source: "agent"; data: TAgent }
  | { source: "fallback"; data: TFallback };

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_ATTEMPTS = 2;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("llm call timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runLlmTask<TAgent, TFallback = TAgent>(
  opts: RunLlmTaskOptions<TAgent, TFallback>,
): Promise<LlmTaskResult<TAgent, TFallback>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await withTimeout(opts.call(), timeoutMs);
      const result = opts.validate(raw);
      if (result.ok) {
        return { source: "agent", data: result.data };
      }
      // Error visibility (2026-07-16) — was previously silently discarded,
      // which made the E2E-validation fallback-rate investigation
      // impossible to diagnose from live logs. Kept as permanent, low-noise
      // operational visibility (not removed after that investigation) since
      // any future fallback-rate regression will need the same signal;
      // preview trimmed to keep each log line short.
      console.warn(`[llm-task] attempt ${attempt} validation failed: ${result.reason}; raw: ${raw.slice(0, 150)}`);
    } catch (err) {
      console.warn(`[llm-task] attempt ${attempt} threw: ${(err as Error).message}`);
    }
  }
  return { source: "fallback", data: await opts.fallback() };
}
