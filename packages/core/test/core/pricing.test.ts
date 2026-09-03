import { describe, expect, it } from "vitest";
import { estimateCostUsd, PRICING } from "../../src/core/pricing.js";

describe("estimateCostUsd", () => {
  it("computes cost from a known model's per-million-token rates", () => {
    const cost = estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000);
    expect(cost).toBe(PRICING["claude-sonnet-5"].input + PRICING["claude-sonnet-5"].output);
  });

  it("scales linearly with token count, not just at exactly 1M", () => {
    const cost = estimateCostUsd("claude-sonnet-5", 500_000, 200_000);
    expect(cost).toBeCloseTo(PRICING["claude-sonnet-5"].input * 0.5 + PRICING["claude-sonnet-5"].output * 0.2, 10);
  });

  it("returns exactly 0 for an unknown model id, instead of borrowing another model's pricing", () => {
    // The deliberate fallback this function documents in its own comment —
    // a local/free-provider model id has no business being priced as if it
    // were Anthropic's, which would misreport real dollar cost.
    const cost = estimateCostUsd("poolside/laguna-s-2.1", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it("returns 0 for zero tokens on a known model", () => {
    expect(estimateCostUsd("claude-opus-5", 0, 0)).toBe(0);
  });
});
