import { createHmac, timingSafeEqual } from "node:crypto";

// Slack's request-signing scheme (v0): https://api.slack.com/authentication/verifying-requests-from-slack
// Every inbound Events API POST carries X-Slack-Signature and
// X-Slack-Request-Timestamp headers; without verifying these, this
// project's webhook endpoint would run an agent turn (with tool access)
// for literally anyone who can guess or find its URL, not just Slack.

const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export interface VerifySlackSignatureInput {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  /** The raw (unparsed) request body — the signature covers these exact bytes, not a re-serialized JSON.parse/stringify round trip. */
  rawBody: string;
  /** Injectable for tests; defaults to the real current time. */
  now?: () => number;
}

/**
 * Verifies both the signature itself and the timestamp's freshness
 * (replay protection — a captured, valid request replayed later must not
 * still be accepted).
 */
export function verifySlackSignature(input: VerifySlackSignatureInput): boolean {
  const { signingSecret, timestamp, signature, rawBody, now = () => Date.now() } = input;
  if (!timestamp || !signature) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(now() / 1000 - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf-8");
  const actualBuf = Buffer.from(signature, "utf-8");
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, which a differently-sized forged signature would trigger.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
