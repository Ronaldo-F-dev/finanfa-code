import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDesignContract } from "../../src/core/design-contract.js";

describe("loadDesignContract", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-design-contract-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to the built-in default when finanfa-design.md doesn't exist", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await loadDesignContract(dir);
      expect(result.isUserProvided).toBe(false);
      expect(result.content.length).toBeGreaterThan(0);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a user-provided finanfa-design.md completely replaces the default — nothing from it survives", async () => {
    await writeFile(path.join(dir, "finanfa-design.md"), "Only use Comic Sans and neon green.");

    const result = await loadDesignContract(dir);

    expect(result.isUserProvided).toBe(true);
    expect(result.content).toBe("Only use Comic Sans and neon green.");
    // none of the built-in default's own wording should leak through
    expect(result.content).not.toContain("indigo-600");
    expect(result.content).not.toContain("Tailwind");
  });

  it("treats a whitespace-only finanfa-design.md as if it weren't provided", async () => {
    await writeFile(path.join(dir, "finanfa-design.md"), "   \n\n  ");

    const result = await loadDesignContract(dir);

    expect(result.isUserProvided).toBe(false);
  });

  it("warns (but still falls back to the default) on a real read error, distinct from a missing file", async () => {
    const file = path.join(dir, "finanfa-design.md");
    await writeFile(file, "custom contract");
    await chmod(file, 0o000);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await loadDesignContract(dir);
      expect(result.isUserProvided).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("finanfa-design.md"));
    } finally {
      await chmod(file, 0o644);
      errorSpy.mockRestore();
    }
  });
});
