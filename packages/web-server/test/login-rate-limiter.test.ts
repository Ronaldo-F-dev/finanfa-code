import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "../src/login-rate-limiter.js";

describe("LoginRateLimiter", () => {
  it("allows attempts under the threshold", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) {
      expect(limiter.retryAfterMs("1.2.3.4", "alice", now)).toBe(0);
      limiter.recordFailure("1.2.3.4", "alice", now);
    }
    expect(limiter.retryAfterMs("1.2.3.4", "alice", now)).toBe(0);
  });

  it("locks out after 5 failures within the window and reports a positive retry-after", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("1.2.3.4", "alice", now);

    const retryAfter = limiter.retryAfterMs("1.2.3.4", "alice", now);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60_000);
  });

  it("lifts the lockout once it expires", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("1.2.3.4", "alice", now);
    expect(limiter.retryAfterMs("1.2.3.4", "alice", now + 15 * 60_000 + 1)).toBe(0);
  });

  it("keeps separate counters per IP+username pair — one attacker on a shared IP can't lock out another user's own login", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("1.2.3.4", "alice", now);
    expect(limiter.retryAfterMs("1.2.3.4", "bob", now)).toBe(0);
  });

  it("keeps separate counters per IP for the same username — a distributed attacker can't be fully stopped by this alone, but each source IP is independently throttled", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.recordFailure("1.2.3.4", "alice", now);
    expect(limiter.retryAfterMs("5.6.7.8", "alice", now)).toBe(0);
  });

  it("resets the counter on success", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) limiter.recordFailure("1.2.3.4", "alice", now);
    limiter.recordSuccess("1.2.3.4", "alice");
    expect(limiter.retryAfterMs("1.2.3.4", "alice", now)).toBe(0);
    // A fresh run of failures after a reset should take another 5 to lock out, not 1.
    limiter.recordFailure("1.2.3.4", "alice", now);
    expect(limiter.retryAfterMs("1.2.3.4", "alice", now)).toBe(0);
  });

  it("starts a fresh window once the previous one has elapsed, instead of accumulating forever", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 4; i++) limiter.recordFailure("1.2.3.4", "alice", now);
    // Past the 60s window — the 5th failure here should start a new window, not push the old count to 5.
    limiter.recordFailure("1.2.3.4", "alice", now + 61_000);
    expect(limiter.retryAfterMs("1.2.3.4", "alice", now + 61_000)).toBe(0);
  });
});
