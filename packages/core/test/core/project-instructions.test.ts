import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProjectInstructions, formatProjectInstructions } from "../../src/core/project-instructions.js";

describe("loadProjectInstructions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-project-instructions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined, silently, when finanfa.md doesn't exist", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await loadProjectInstructions(dir)).toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns the trimmed content of a real finanfa.md", async () => {
    await writeFile(path.join(dir, "finanfa.md"), "\n\n  Always use pnpm, never npm.  \n\n");
    expect(await loadProjectInstructions(dir)).toBe("Always use pnpm, never npm.");
  });

  it("treats a whitespace-only file the same as missing", async () => {
    await writeFile(path.join(dir, "finanfa.md"), "   \n\n  ");
    expect(await loadProjectInstructions(dir)).toBeUndefined();
  });

  it("warns (but doesn't throw) on a real permission error, distinct from a missing file", async () => {
    const file = path.join(dir, "finanfa.md");
    await writeFile(file, "secret conventions");
    await chmod(file, 0o000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await loadProjectInstructions(dir);
      expect(result).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("finanfa.md"));
    } finally {
      await chmod(file, 0o644);
      errorSpy.mockRestore();
    }
  });
});

describe("formatProjectInstructions", () => {
  it("returns an empty string for undefined, adding nothing to the prompt", () => {
    expect(formatProjectInstructions(undefined)).toBe("");
  });

  it("wraps real instructions in a clearly labeled section", () => {
    const formatted = formatProjectInstructions("Always use pnpm.");
    expect(formatted).toContain("# Project instructions (finanfa.md)");
    expect(formatted).toContain("Always use pnpm.");
  });
});
