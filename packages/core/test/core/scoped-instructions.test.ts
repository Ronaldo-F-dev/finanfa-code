import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadScopedInstructions, formatScopedInstructions, projectInstructionsDir } from "../../src/core/scoped-instructions.js";

describe("loadScopedInstructions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-scoped-instructions-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty list, silently, when .finanfa-code/instructions doesn't exist", async () => {
    expect(await loadScopedInstructions(dir)).toEqual([]);
  });

  it("loads a real instructions file with a single applyTo glob", async () => {
    await mkdir(projectInstructionsDir(dir), { recursive: true });
    await writeFile(
      path.join(projectInstructionsDir(dir), "frontend.md"),
      '---\ndescription: "Frontend conventions"\napplyTo: "packages/web-client/**/*.tsx"\n---\n\nUse function components only, never class components.\n',
    );

    const result = await loadScopedInstructions(dir);
    expect(result).toEqual([
      { name: "frontend", description: "Frontend conventions", applyTo: ["packages/web-client/**/*.tsx"], content: "Use function components only, never class components." },
    ]);
  });

  it("loads a real instructions file with a list of applyTo globs", async () => {
    await mkdir(projectInstructionsDir(dir), { recursive: true });
    await writeFile(
      path.join(projectInstructionsDir(dir), "tests.md"),
      '---\napplyTo:\n  - "**/*.test.ts"\n  - "**/*.spec.ts"\n---\n\nNever mock — use real subprocesses and real local servers.\n',
    );

    const result = await loadScopedInstructions(dir);
    expect(result[0].applyTo).toEqual(["**/*.test.ts", "**/*.spec.ts"]);
  });

  it("treats a missing applyTo as 'applies everywhere' (undefined, not an empty array)", async () => {
    await mkdir(projectInstructionsDir(dir), { recursive: true });
    await writeFile(path.join(projectInstructionsDir(dir), "general.md"), "---\n---\n\nAlways use pnpm.\n");

    const result = await loadScopedInstructions(dir);
    expect(result[0].applyTo).toBeUndefined();
  });

  it("skips a whitespace-only instructions file", async () => {
    await mkdir(projectInstructionsDir(dir), { recursive: true });
    await writeFile(path.join(projectInstructionsDir(dir), "empty.md"), "---\napplyTo: \"*.ts\"\n---\n\n   \n");

    expect(await loadScopedInstructions(dir)).toEqual([]);
  });

  it("loads every file in the directory, not just one", async () => {
    await mkdir(projectInstructionsDir(dir), { recursive: true });
    await writeFile(path.join(projectInstructionsDir(dir), "a.md"), "---\n---\n\nRule A");
    await writeFile(path.join(projectInstructionsDir(dir), "b.md"), "---\n---\n\nRule B");

    const result = await loadScopedInstructions(dir);
    expect(result.map((r) => r.content).sort()).toEqual(["Rule A", "Rule B"]);
  });

  it("warns (but doesn't throw) on a real malformed-YAML frontmatter file, and still loads the rest", async () => {
    await mkdir(projectInstructionsDir(dir), { recursive: true });
    await writeFile(path.join(projectInstructionsDir(dir), "broken.md"), "---\napplyTo: [unterminated\n---\n\nbroken");
    await writeFile(path.join(projectInstructionsDir(dir), "fine.md"), "---\n---\n\nfine content");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await loadScopedInstructions(dir);
      expect(result).toEqual([{ name: "fine", description: undefined, applyTo: undefined, content: "fine content" }]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("broken.md"));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("formatScopedInstructions", () => {
  it("returns an empty string for an empty list, adding nothing to the prompt", () => {
    expect(formatScopedInstructions([])).toBe("");
  });

  it("labels each section with its own applyTo globs", () => {
    const formatted = formatScopedInstructions([
      { name: "frontend", applyTo: ["packages/web-client/**"], content: "Use function components." },
    ]);
    expect(formatted).toContain("## frontend (applies to: packages/web-client/**)");
    expect(formatted).toContain("Use function components.");
  });

  it("omits the applyTo label for an instruction with no scoping (applies everywhere)", () => {
    const formatted = formatScopedInstructions([{ name: "general", content: "Always use pnpm." }]);
    expect(formatted).toContain("## general\n");
    expect(formatted).not.toContain("applies to:");
  });

  it("includes the description when present", () => {
    const formatted = formatScopedInstructions([{ name: "tests", description: "How to write tests here", content: "Never mock." }]);
    expect(formatted).toContain("How to write tests here");
  });
});
