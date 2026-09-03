import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { grepTool } from "../../src/tools/builtin/grep.js";

describe("grep tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-grep-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("finds matching lines with file:line:content", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello\nworld\nhello again");
    const result = await grepTool.handler({ pattern: "hello" }, ctx());
    expect(result.content).toContain("a.txt:1:hello");
    expect(result.content).toContain("a.txt:3:hello again");
    expect(result.content).not.toContain("world");
  });

  it("returns '(no matches)' when nothing matches", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello");
    const result = await grepTool.handler({ pattern: "zzz_not_present" }, ctx());
    expect(result.content).toBe("(no matches)");
  });

  it("respects caseInsensitive", async () => {
    await writeFile(path.join(dir, "a.txt"), "HELLO");
    const result = await grepTool.handler({ pattern: "hello", caseInsensitive: true }, ctx());
    expect(result.content).toContain("HELLO");
  });

  it("truncates output past 500 matching lines, with a note", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `match line ${i}`);
    await writeFile(path.join(dir, "big.txt"), lines.join("\n"));

    const result = await grepTool.handler({ pattern: "match line" }, ctx());

    const matchLines = result.content.split("\n").filter((l) => l.startsWith("big.txt:"));
    expect(matchLines).toHaveLength(500);
    expect(result.content).toContain("... (truncated, showing first 500 of 600 matching lines");
  });

  it("truncates a huge single match line (a minified-file style case) by character count too", async () => {
    const hugeLine = "needle".repeat(10_000);
    await writeFile(path.join(dir, "min.js"), hugeLine);

    const result = await grepTool.handler({ pattern: "needle" }, ctx());

    expect(result.content.length).toBeLessThan(hugeLine.length);
    expect(result.content).toContain("... (truncated");
  });
});
