import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "../../src/channels/line-signature.js";

const SECRET = "my-channel-secret";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verifyLineSignature", () => {
  it("accepts a real, correctly-signed body", () => {
    const body = JSON.stringify({ events: [] });
    expect(verifyLineSignature(SECRET, sign(SECRET, body), body)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = JSON.stringify({ events: [] });
    expect(verifyLineSignature(SECRET, sign("wrong-secret", body), body)).toBe(false);
  });

  it("rejects a signature that doesn't match a modified body (tampering)", () => {
    const original = JSON.stringify({ events: [] });
    const signature = sign(SECRET, original);
    const tampered = JSON.stringify({ events: ["injected"] });
    expect(verifyLineSignature(SECRET, signature, tampered)).toBe(false);
  });

  it("rejects a missing signature header instead of throwing", () => {
    expect(verifyLineSignature(SECRET, undefined, "{}")).toBe(false);
  });

  it("rejects a non-base64 signature header instead of throwing", () => {
    expect(verifyLineSignature(SECRET, "not-valid-base64!!!", "{}")).toBe(false);
  });
});
