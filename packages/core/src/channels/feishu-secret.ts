import { timingSafeEqual } from "node:crypto";

// Feishu/Lark's event-subscription auth
// (https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscriptions-configure-):
// a Verification Token, embedded in the event body itself (not a header
// — see feishu-event.ts's extractFeishuToken) rather than an HMAC
// signature over the raw bytes. Feishu also supports an optional
// "Encrypt Key" that AES-encrypts the whole event payload — deliberately
// not implemented here (a real, meaningfully bigger feature: symmetric
// decryption of every inbound event before it can even be parsed), same
// "documented, honest scope boundary" convention as this project's own
// OIDC userinfo-trust simplification. Verification-Token-only is itself
// a real, fully supported Feishu auth mode, not a workaround.
export function verifyFeishuToken(expected: string, received: string | undefined): boolean {
  if (!received) return false;
  const expectedBuf = Buffer.from(expected, "utf-8");
  const receivedBuf = Buffer.from(received, "utf-8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}
