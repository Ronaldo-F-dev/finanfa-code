import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession, sessionsRoot } from "../../src/core/session.js";
import { searchSessionIndex, refreshSessionSearchIndex, resetSessionSearchIndexForTests } from "../../src/core/session-search-index.js";

async function onlySessionFilePath(): Promise<string> {
  const projectDirs = await readdir(sessionsRoot());
  const dir = path.join(sessionsRoot(), projectDirs[0]);
  const [file] = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  return path.join(dir, file);
}

describe("session-search-index (real node:sqlite FTS5 index over real session files)", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  const cwd = "/projects/some-repo";

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-search-index-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    resetSessionSearchIndexForTests();
  });

  afterEach(async () => {
    resetSessionSearchIndexForTests();
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("indexes a persisted session and finds it via FTS5 MATCH", async () => {
    const s = new AgentSession({ cwd, model: "m", systemPrompt: "s" });
    s.title = "Investigating a memory leak";
    s.messages = [{ role: "user", content: "the worker process keeps growing in RSS over time" }];
    await s.persist();

    const hits = await searchSessionIndex("memory RSS", cwd, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("RSS");
    expect(hits[0].title).toBe("Investigating a memory leak");
  });

  it("is idempotent: refreshing again with no file changes leaves the index untouched", async () => {
    const s = new AgentSession({ cwd, model: "m", systemPrompt: "s" });
    s.title = "Original title";
    s.messages = [{ role: "user", content: "some searchable content here" }];
    await s.persist();
    await refreshSessionSearchIndex();
    await refreshSessionSearchIndex(); // second call must not duplicate rows or otherwise change results

    const hits = await searchSessionIndex("searchable", cwd, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Original title");
  });

  it("picks up a real content change once the file's mtime actually advances", async () => {
    const s = new AgentSession({ cwd, model: "m", systemPrompt: "s" });
    s.messages = [{ role: "user", content: "the original wording" }];
    await s.persist();
    await refreshSessionSearchIndex();

    const filePath = await onlySessionFilePath();
    const raw = JSON.parse(await readFile(filePath, "utf-8"));
    raw.messages = [{ role: "user", content: "a completely different wording" }];
    await writeFile(filePath, JSON.stringify(raw), "utf-8");
    const future = new Date(Date.now() + 5000);
    await utimes(filePath, future, future);

    await refreshSessionSearchIndex();
    expect(await searchSessionIndex("original", cwd, 5)).toHaveLength(0);
    expect(await searchSessionIndex("different", cwd, 5)).toHaveLength(1);
  });

  it("scopes results to a given cwd when scopeCwd is provided", async () => {
    const other = "/projects/other-repo";
    const s1 = new AgentSession({ cwd, model: "m", systemPrompt: "s" });
    s1.messages = [{ role: "user", content: "unique-term-alpha appears here" }];
    await s1.persist();

    const s2 = new AgentSession({ cwd: other, model: "m", systemPrompt: "s" });
    s2.messages = [{ role: "user", content: "unique-term-alpha appears here too" }];
    await s2.persist();

    const scoped = await searchSessionIndex("unique-term-alpha", cwd, 10);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].cwd).toBe(cwd);

    const unscoped = await searchSessionIndex("unique-term-alpha", undefined, 10);
    expect(unscoped).toHaveLength(2);
  });

  it("returns no hits for terms that appear nowhere", async () => {
    const s = new AgentSession({ cwd, model: "m", systemPrompt: "s" });
    s.messages = [{ role: "user", content: "hello world" }];
    await s.persist();

    const hits = await searchSessionIndex("nonexistent-keyword-xyz", cwd, 5);
    expect(hits).toHaveLength(0);
  });
});
