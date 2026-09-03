export interface RetryOptions {
  /** Total attempts including the first — default 3. */
  attempts?: number;
  /** Delay before the 2nd attempt; doubles each subsequent attempt — default 500ms. */
  baseDelayMs?: number;
  /** Whether a given failure is worth retrying — default: retry everything. */
  shouldRetry?: (err: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` with exponential backoff on failure. Only meant for
 * operations that are safe to redo from scratch (a fresh connection
 * attempt, a request that hasn't started streaming yet) — never wrap
 * something that may have already had a partial, user-visible side effect,
 * since retrying that would repeat it.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
