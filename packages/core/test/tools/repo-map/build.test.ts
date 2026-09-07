import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRepoMap, formatRepoMap } from "../../../src/tools/builtin/repo-map/build.js";
import { repoMapTool } from "../../../src/tools/builtin/repo-map.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };

describe("buildRepoMap (real files on disk, real tree-sitter parsing, real PageRank)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-repo-map-"));
    // A small real dependency graph: both routeA.ts and routeB.ts call into
    // shared/db.ts's `query` function — db.ts should out-rank the two
    // routes, and both routes should out-rank an isolated, unreferenced
    // util file.
    await mkdir(path.join(dir, "shared"), { recursive: true });
    await writeFile(
      path.join(dir, "shared", "db.ts"),
      `export function query(sql: string): unknown[] {\n  return [];\n}\nexport class Database {\n  connect(): void {}\n}\n`,
    );
    await writeFile(
      path.join(dir, "routeA.ts"),
      `import { query } from "./shared/db.js";\nexport function handleA(): unknown[] {\n  return query("select 1");\n}\n`,
    );
    await writeFile(
      path.join(dir, "routeB.ts"),
      `import { query } from "./shared/db.js";\nexport function handleB(): unknown[] {\n  return query("select 2");\n}\n`,
    );
    await writeFile(path.join(dir, "isolated.ts"), `export function unreferencedUtil(): number {\n  return 42;\n}\n`);
    await writeFile(path.join(dir, "README.md"), "# not a supported language, must be excluded");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ranks the file referenced by multiple others (db.ts) above an isolated, unreferenced file", async () => {
    const result = await buildRepoMap(dir);
    const rankOf = (file: string) => result.entries.find((e) => e.file.endsWith(file))?.rank ?? -1;
    expect(rankOf("shared/db.ts")).toBeGreaterThan(rankOf("isolated.ts"));
  });

  it("excludes files in unsupported languages (README.md) from the map entirely", async () => {
    const result = await buildRepoMap(dir);
    expect(result.entries.some((e) => e.file.endsWith(".md"))).toBe(false);
    // README.md is excluded at the glob stage itself (SUPPORTED_GLOB_PATTERNS
    // only matches supported extensions) — so filesScanned/filesParsed are
    // both exactly the 4 real .ts fixture files, not just "parsed <= scanned".
    expect(result.filesScanned).toBe(4);
    expect(result.filesParsed).toBe(4);
  });

  it("captures real definitions per file (query/Database in db.ts, handleA in routeA.ts)", async () => {
    const result = await buildRepoMap(dir);
    const db = result.entries.find((e) => e.file.endsWith("shared/db.ts"));
    expect(db?.definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "query", kind: "function" }), expect.objectContaining({ name: "Database", kind: "class" })]),
    );
    const routeA = result.entries.find((e) => e.file.endsWith("routeA.ts"));
    expect(routeA?.definitions).toEqual(expect.arrayContaining([expect.objectContaining({ name: "handleA", kind: "function" })]));
  });

  it("formatRepoMap renders a readable map with file paths and definition lines", async () => {
    const result = await buildRepoMap(dir);
    const text = formatRepoMap(result);
    expect(text).toContain("shared/db.ts");
    expect(text).toContain("function query");
    expect(text).toContain("line ");
  });

  it("personalization (focusFiles) can change the ranking order", async () => {
    const plain = await buildRepoMap(dir);
    const focused = await buildRepoMap(dir, { focusFiles: ["isolated.ts"] });
    const rankOf = (result: typeof plain, file: string) => result.entries.find((e) => e.file.endsWith(file))?.rank ?? -1;
    // isolated.ts's own rank should increase when it's the focus file, relative to its plain-PageRank rank.
    expect(rankOf(focused, "isolated.ts")).toBeGreaterThan(rankOf(plain, "isolated.ts"));
  });

  it("respects maxChars by truncating to a smaller map", async () => {
    const full = await buildRepoMap(dir, { maxChars: 100_000 });
    const truncated = await buildRepoMap(dir, { maxChars: 10 });
    expect(truncated.entries.length).toBeLessThanOrEqual(full.entries.length);
    expect(truncated.truncated).toBe(true);
  });

  it("the repo_map tool end-to-end reports 'safe' risk and produces the same map via its handler", async () => {
    expect(repoMapTool.riskLevel).toBe("safe");
    const result = await repoMapTool.handler({}, { ...ctx, cwd: dir });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("shared/db.ts");
  });
});

describe("buildRepoMap against an empty/no-supported-files directory", () => {
  it("reports zero entries and a clear message instead of erroring", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-repo-map-empty-"));
    try {
      await writeFile(path.join(dir, "notes.txt"), "just some notes");
      const result = await buildRepoMap(dir);
      expect(result.entries).toHaveLength(0);
      expect(formatRepoMap(result)).toContain("No source files in a supported language");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
