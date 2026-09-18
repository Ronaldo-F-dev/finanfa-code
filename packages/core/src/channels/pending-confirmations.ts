/**
 * Real remote-confirmation support for a headless channel turn (Telegram
 * first) — the whole point being that a tool needing "ask" confirmation
 * has no interactive terminal/browser to prompt: runHeadlessTurn's own
 * askUser sends the prompt back out through the channel's own send-message
 * callback, then this registry lets that channel's webhook handler
 * resolve it with the user's very next message in the same chat, instead
 * of starting a brand-new, unrelated turn for what's really an answer to
 * a pending question.
 *
 * One pending confirmation per sessionId at a time — runOneToolCall in
 * loop.ts only ever runs "ask"/"dangerous"-risk tool calls one at a time
 * (only "safe" ones run concurrently, and those never reach permission
 * confirmation at all), so a session can never have two live questions.
 */

interface PendingConfirmation {
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingConfirmation>();

// Real remote channels aren't a human staring at a spinner — generous on
// purpose, same reasoning this project already applies to local-model
// timeouts elsewhere: only a truly abandoned question should fail closed
// via this, not someone who stepped away for a few minutes.
const CONFIRMATION_TIMEOUT_MS = 5 * 60_000;

/**
 * Registers a pending confirmation for `sessionId` and returns a promise
 * that resolves with the user's reply text once resolvePendingConfirmation
 * is called for the same id — or with "n" (fail closed, matching every
 * other "couldn't get a real answer" case in PermissionManager) if
 * nothing arrives within CONFIRMATION_TIMEOUT_MS.
 */
export function waitForRemoteConfirmation(sessionId: string): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      resolve("n");
    }, CONFIRMATION_TIMEOUT_MS);
    pending.set(sessionId, { resolve, timer });
  });
}

/**
 * True (and resolves the waiting askUser call with `answer`) if
 * `sessionId` had a pending confirmation — the caller should treat the
 * inbound message as an answer to that question, not a new turn, whenever
 * this returns true.
 */
export function resolvePendingConfirmation(sessionId: string, answer: string): boolean {
  const entry = pending.get(sessionId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(sessionId);
  entry.resolve(answer);
  return true;
}

/** For tests only — whether `sessionId` currently has a pending confirmation. */
export function hasPendingConfirmation(sessionId: string): boolean {
  return pending.has(sessionId);
}
