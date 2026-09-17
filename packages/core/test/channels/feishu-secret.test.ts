import { describe, expect, it } from "vitest";
import { verifyFeishuToken } from "../../src/channels/feishu-secret.js";

describe("verifyFeishuToken", () => {
  it("accepts a matching token", () => {
    expect(verifyFeishuToken("my-verification-token", "my-verification-token")).toBe(true);
  });

  it("rejects a non-matching token", () => {
    expect(verifyFeishuToken("my-verification-token", "wrong-token")).toBe(false);
  });

  it("rejects a missing token instead of throwing", () => {
    expect(verifyFeishuToken("my-verification-token", undefined)).toBe(false);
  });

  it("rejects a token of a different length instead of throwing (timingSafeEqual would otherwise throw)", () => {
    expect(verifyFeishuToken("my-verification-token", "short")).toBe(false);
  });
});
