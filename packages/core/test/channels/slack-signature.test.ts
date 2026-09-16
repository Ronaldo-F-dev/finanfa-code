import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../../src/channels/slack-signature.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

function sign(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

describe("verifySlackSignature (real HMAC-SHA256, Slack's actual v0 scheme)", () => {
  it("accepts a genuinely valid, fresh signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "token=abc&team_id=T1&type=url_verification";
    const signature = sign(SIGNING_SECRET, timestamp, rawBody);

    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp, signature, rawBody })).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "some=body";
    const signature = sign("wrong-secret", timestamp, rawBody);

    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp, signature, rawBody })).toBe(false);
  });

  it("rejects a signature computed over a different body than what's presented (tamper detection)", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(SIGNING_SECRET, timestamp, "original=body");

    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp, signature, rawBody: "tampered=body" })).toBe(false);
  });

  it("rejects a stale timestamp, even with an otherwise-correct signature (replay protection)", () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60); // 10 minutes old
    const rawBody = "some=body";
    const signature = sign(SIGNING_SECRET, staleTimestamp, rawBody);

    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp: staleTimestamp, signature, rawBody })).toBe(false);
  });

  it("rejects a missing signature or timestamp outright", () => {
    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp: undefined, signature: "v0=abc", rawBody: "x" })).toBe(false);
    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp: "123", signature: undefined, rawBody: "x" })).toBe(false);
  });

  it("rejects a non-numeric timestamp instead of throwing", () => {
    expect(
      verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp: "not-a-number", signature: "v0=abc", rawBody: "x" }),
    ).toBe(false);
  });

  it("rejects a signature of the wrong length instead of throwing (timingSafeEqual would otherwise throw on length mismatch)", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(verifySlackSignature({ signingSecret: SIGNING_SECRET, timestamp, signature: "v0=short", rawBody: "x" })).toBe(false);
  });
});
