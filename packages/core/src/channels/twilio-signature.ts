import { createHmac, timingSafeEqual } from "node:crypto";

// Twilio's own request-validation scheme:
// https://www.twilio.com/docs/usage/security#validating-requests
// Unlike every other channel here (which signs the raw request body),
// Twilio signs the exact webhook URL Twilio was configured to call PLUS
// every POST parameter (sorted by key, key+value concatenated with no
// delimiter, appended directly to the URL) — HMAC-SHA1 with the account's
// auth token, base64-encoded. Without this, this project's SMS webhook
// would run a real agent turn for anyone who could POST to its URL, not
// just Twilio.

export interface VerifyTwilioSignatureInput {
  authToken: string;
  /** The exact URL Twilio was configured to POST to — must match byte-for-byte what Twilio itself signed, including scheme/host/path/query. */
  url: string;
  /** The parsed (already form-urlencoded-decoded) POST parameters. */
  params: Record<string, string>;
  signatureHeader: string | undefined;
}

export function verifyTwilioSignature(input: VerifyTwilioSignatureInput): boolean {
  const { authToken, url, params, signatureHeader } = input;
  if (!signatureHeader) return false;

  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", authToken).update(data, "utf-8").digest("base64");

  const expectedBuf = Buffer.from(expected, "utf-8");
  const actualBuf = Buffer.from(signatureHeader, "utf-8");
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, which a differently-sized forged signature would trigger.
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
