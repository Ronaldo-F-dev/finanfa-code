import { createHmac, timingSafeEqual } from "node:crypto";

// Meta's WhatsApp Cloud API webhook signing scheme:
// https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
// Every inbound webhook POST carries an X-Hub-Signature-256 header
// ("sha256=<hex hmac>") computed over the raw body with the app secret —
// unlike Slack's scheme there's no timestamp/replay window here, just the
// one HMAC to check, so without this any request to this project's
// webhook URL would run a real agent turn for anyone who found it.

export interface VerifyWhatsappSignatureInput {
  appSecret: string;
  /** The raw `X-Hub-Signature-256` header value, e.g. "sha256=abc123...". */
  signatureHeader: string | undefined;
  /** The raw (unparsed) request body — the signature covers these exact bytes, not a re-serialized JSON.parse/stringify round trip. */
  rawBody: string;
}

export function verifyWhatsappSignature(input: VerifyWhatsappSignatureInput): boolean {
  const { appSecret, signatureHeader, rawBody } = input;
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expectedHex = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expected = `sha256=${expectedHex}`;

  const expectedBuf = Buffer.from(expected, "utf-8");
  const actualBuf = Buffer.from(signatureHeader, "utf-8");
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, which a differently-sized forged signature would trigger.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
