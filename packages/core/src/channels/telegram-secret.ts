import { timingSafeEqual } from "node:crypto";

// Telegram's webhook auth (https://core.telegram.org/bots/api#setwebhook):
// register a `secret_token` when calling setWebhook, and Telegram echoes it
// back on every update as the X-Telegram-Bot-Api-Secret-Token header — a
// plain shared-secret compare (unlike Slack's HMAC-over-the-body scheme;
// Telegram relies on HTTPS transport security plus this opaque token,
// not a signature over the payload). Without checking it, this project's
// webhook endpoint would run an agent turn for anyone who found its URL.
export function verifyTelegramSecret(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const expectedBuf = Buffer.from(expected, "utf-8");
  const receivedBuf = Buffer.from(received, "utf-8");
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, which a differently-sized forged token would trigger.
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}
