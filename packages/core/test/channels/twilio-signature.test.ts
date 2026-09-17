import { describe, expect, it } from "vitest";
import { verifyTwilioSignature } from "../../src/channels/twilio-signature.js";

// The exact auth token/URL/params/signature quadruple from Twilio's own
// published documentation on validating requests — confirms this
// implementation matches Twilio's real algorithm bit-for-bit, not just an
// internally-consistent reimplementation of it.
// https://www.twilio.com/docs/usage/security#validating-requests
const OFFICIAL_AUTH_TOKEN = "12345";
const OFFICIAL_URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const OFFICIAL_PARAMS = { CallSid: "CA1234567890ABCDE", Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212" };
const OFFICIAL_SIGNATURE = "RSOYDt4T1cUTdK1PDd93/VVr8B8=";

describe("verifyTwilioSignature (matches Twilio's own published test vector)", () => {
  it("accepts Twilio's own documented example signature", () => {
    expect(
      verifyTwilioSignature({ authToken: OFFICIAL_AUTH_TOKEN, url: OFFICIAL_URL, params: OFFICIAL_PARAMS, signatureHeader: OFFICIAL_SIGNATURE }),
    ).toBe(true);
  });

  it("rejects the same signature computed with a different auth token", () => {
    expect(
      verifyTwilioSignature({ authToken: "wrong-token", url: OFFICIAL_URL, params: OFFICIAL_PARAMS, signatureHeader: OFFICIAL_SIGNATURE }),
    ).toBe(false);
  });

  it("rejects the signature when the URL doesn't match what was actually signed", () => {
    expect(
      verifyTwilioSignature({ authToken: OFFICIAL_AUTH_TOKEN, url: "https://mycompany.com/other.php?foo=1&bar=2", params: OFFICIAL_PARAMS, signatureHeader: OFFICIAL_SIGNATURE }),
    ).toBe(false);
  });

  it("rejects the signature when a param value was tampered with", () => {
    const tamperedParams = { ...OFFICIAL_PARAMS, Digits: "9999" };
    expect(
      verifyTwilioSignature({ authToken: OFFICIAL_AUTH_TOKEN, url: OFFICIAL_URL, params: tamperedParams, signatureHeader: OFFICIAL_SIGNATURE }),
    ).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyTwilioSignature({ authToken: OFFICIAL_AUTH_TOKEN, url: OFFICIAL_URL, params: OFFICIAL_PARAMS, signatureHeader: undefined })).toBe(false);
  });

  it("rejects a forged signature of a different length instead of throwing", () => {
    expect(verifyTwilioSignature({ authToken: OFFICIAL_AUTH_TOKEN, url: OFFICIAL_URL, params: OFFICIAL_PARAMS, signatureHeader: "short" })).toBe(false);
  });
});
