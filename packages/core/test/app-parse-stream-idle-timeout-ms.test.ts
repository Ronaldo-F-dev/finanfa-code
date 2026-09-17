import { describe, expect, it } from "vitest";
import { parseStreamIdleTimeoutMs } from "../src/app.js";

describe("parseStreamIdleTimeoutMs (FINANFA_STREAM_IDLE_TIMEOUT_MS parsing)", () => {
  it("parses a valid positive number", () => {
    expect(parseStreamIdleTimeoutMs("600000")).toBe(600_000);
  });

  it("returns undefined for unset input, so the provider's own default applies", () => {
    expect(parseStreamIdleTimeoutMs(undefined)).toBeUndefined();
  });

  it("returns undefined for a non-numeric, zero, or negative value instead of a broken timeout", () => {
    expect(parseStreamIdleTimeoutMs("not-a-number")).toBeUndefined();
    expect(parseStreamIdleTimeoutMs("0")).toBeUndefined();
    expect(parseStreamIdleTimeoutMs("-5000")).toBeUndefined();
  });
});
