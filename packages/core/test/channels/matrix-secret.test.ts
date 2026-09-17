import { describe, expect, it } from "vitest";
import { verifyMatrixHsToken } from "../../src/channels/matrix-secret.js";

describe("verifyMatrixHsToken", () => {
  it("accepts a matching Bearer token", () => {
    expect(verifyMatrixHsToken("my-hs-token", "Bearer my-hs-token")).toBe(true);
  });

  it("rejects a non-matching token", () => {
    expect(verifyMatrixHsToken("my-hs-token", "Bearer wrong-token")).toBe(false);
  });

  it("rejects a missing Authorization header instead of throwing", () => {
    expect(verifyMatrixHsToken("my-hs-token", undefined)).toBe(false);
  });

  it("rejects a header that isn't a Bearer token", () => {
    expect(verifyMatrixHsToken("my-hs-token", "Basic dXNlcjpwYXNz")).toBe(false);
  });

  it("rejects a token of a different length instead of throwing (timingSafeEqual would otherwise throw)", () => {
    expect(verifyMatrixHsToken("my-hs-token", "Bearer short")).toBe(false);
  });
});
