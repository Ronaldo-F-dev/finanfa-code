import { describe, expect, it, vi, afterEach } from "vitest";
import { SessionTokenStore } from "../src/session-token-store.js";

describe("SessionTokenStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a real, unique token per call and validates it back to the right user", () => {
    const store = new SessionTokenStore();
    const aliceToken = store.issue("alice");
    const bobToken = store.issue("bob");
    expect(aliceToken).not.toBe(bobToken);
    expect(store.validate(aliceToken)).toBe("alice");
    expect(store.validate(bobToken)).toBe("bob");
  });

  it("returns undefined for a token that was never issued", () => {
    const store = new SessionTokenStore();
    expect(store.validate("not-a-real-token")).toBeUndefined();
  });

  it("revoke makes a previously-valid token invalid", () => {
    const store = new SessionTokenStore();
    const token = store.issue("alice");
    expect(store.validate(token)).toBe("alice");
    store.revoke(token);
    expect(store.validate(token)).toBeUndefined();
  });

  it("a token expires after its real TTL", () => {
    vi.useFakeTimers();
    const store = new SessionTokenStore();
    const token = store.issue("alice");
    expect(store.validate(token)).toBe("alice");

    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000); // 31 days — past the real 30-day TTL
    expect(store.validate(token)).toBeUndefined();
  });
});
