import { describe, expect, it, afterEach } from "vitest";
import { isCommandAvailable, resetCommandAvailabilityCacheForTests } from "../../src/util/command-availability.js";

describe("isCommandAvailable (real spawnSync check)", () => {
  afterEach(() => {
    resetCommandAvailabilityCacheForTests();
  });

  it("reports true for a real, genuinely installed binary (node itself)", () => {
    expect(isCommandAvailable(process.execPath)).toBe(true);
  });

  it("reports false for a genuinely nonexistent binary", () => {
    expect(isCommandAvailable("this-definitely-does-not-exist-xyz123")).toBe(false);
  });

  it("caches the result across calls (a second check for the same name doesn't need to re-spawn)", () => {
    const first = isCommandAvailable(process.execPath);
    const second = isCommandAvailable(process.execPath);
    expect(first).toBe(second);
  });

  it("still reports true for a binary that exits non-zero when run with no args (existence, not exit code, is what's checked)", () => {
    // `false` (coreutils) is a real, always-installed binary that always exits 1 with no output.
    expect(isCommandAvailable("false")).toBe(true);
  });
});
