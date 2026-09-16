// Shared outbound-retry policy for the Slack/Telegram/Discord send calls
// (postSlackMessage, postTelegramMessage, postDiscordMessage/
// patchDiscordInteractionResponse) — a real, confirmed gap relative to
// OpenClaw's channel plugins, which all wrap outbound calls in retry/
// backoff with real 429 handling; ours previously had none at all, so a
// single rate-limited or transiently-failed send was just a permanent
// failure. Each platform reports its rate-limit wait differently (a
// plain `Retry-After` header in seconds for Slack/Discord, a
// `retry_after` field in Telegram's JSON error body), so the one thing
// callers customize is how to read that; everything else (attempt
// counting, exponential fallback, which statuses are worth retrying at
// all) is shared here instead of being reimplemented per channel.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchWithRetryOptions {
  /** Total attempts including the first — default 3. */
  maxAttempts?: number;
  /** Base delay for the exponential fallback (no server-specified wait) — default 500ms, doubling each attempt. */
  baseDelayMs?: number;
  /**
   * Reads a server-specified wait (in ms) off a 429 response, given the
   * response and its already-consumed body text (so implementations can
   * check a header OR parse the body without each re-reading the stream).
   * Returning undefined falls back to the generic exponential delay.
   */
  retryAfterMs?: (response: Response, bodyText: string) => number | undefined;
}

export interface FetchWithRetryResult {
  response: Response;
  bodyText: string;
}

/**
 * Retries a POST/PATCH-style call on: a network-level failure (fetch
 * itself throwing), a 429 (honoring the platform's own reported wait
 * when available), or a 5xx (transient server error) — never on another
 * 4xx (400/401/403/404/...), since those won't succeed on retry and
 * should fail immediately instead of wasting the attempt budget.
 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: FetchWithRetryOptions = {}): Promise<FetchWithRetryResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
      continue;
    }

    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
      const bodyText = await response.text();
      const wait = response.status === 429 ? opts.retryAfterMs?.(response, bodyText) : undefined;
      await sleep(wait ?? baseDelayMs * 2 ** (attempt - 1));
      continue;
    }

    return { response, bodyText: await response.text() };
  }
}
