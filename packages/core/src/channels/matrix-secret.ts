import { timingSafeEqual } from "node:crypto";

// Matrix Application Service auth (https://spec.matrix.org/latest/application-service-api/#authorization):
// the homeserver authenticates ITS OWN pushes to us with a Bearer token
// (the AS's own `hs_token`, set when the AS is registered on the
// homeserver) — same plain shared-secret-over-HTTPS shape as Telegram's
// X-Telegram-Bot-Api-Secret-Token (see telegram-secret.ts), not an
// HMAC-over-body signature like Slack's.
export function verifyMatrixHsToken(expected: string, authorizationHeader: string | undefined): boolean {
  if (!authorizationHeader?.startsWith("Bearer ")) return false;
  const received = authorizationHeader.slice("Bearer ".length);
  const expectedBuf = Buffer.from(expected, "utf-8");
  const receivedBuf = Buffer.from(received, "utf-8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}
