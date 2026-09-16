import { describe, expect, it } from "vitest";
import { verifyTelegramSecret } from "../../src/channels/telegram-secret.js";

describe("verifyTelegramSecret", () => {
  it("accepts a matching token", () => {
    expect(verifyTelegramSecret("my-secret-token", "my-secret-token")).toBe(true);
  });

  it("rejects a non-matching token", () => {
    expect(verifyTelegramSecret("my-secret-token", "wrong-token")).toBe(false);
  });

  it("rejects a missing token instead of throwing", () => {
    expect(verifyTelegramSecret("my-secret-token", undefined)).toBe(false);
  });

  it("rejects a token of a different length instead of throwing (timingSafeEqual would otherwise throw)", () => {
    expect(verifyTelegramSecret("my-secret-token", "short")).toBe(false);
  });
});
