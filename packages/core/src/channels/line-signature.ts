import { createHmac, timingSafeEqual } from "node:crypto";

// LINE's webhook signature scheme (https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/):
// every inbound POST carries an X-Line-Signature header — base64(HMAC-
// SHA256(channel secret, raw request body)) — a real signature over the
// body (unlike Telegram's plain shared-secret header), same shape as
// Slack's own v0 scheme but without a timestamp/replay-window component
// (LINE's own spec doesn't define one).
export function verifyLineSignature(channelSecret: string, signatureHeader: string | undefined, rawBody: string): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", channelSecret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signatureHeader, "base64");
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, which a differently-sized forged signature would trigger.
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
