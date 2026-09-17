import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";

describe("AgentSession.persist", () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-session-persist-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("warns and resolves instead of throwing when the sessions directory can't be created", async () => {
    // Real fs failure, not a mock: pre-create ~/.finanfa-code/sessions as a
    // plain FILE, so mkdir(recursive) for the project subdirectory genuinely
    // fails with ENOTDIR — the same shape of error a disk-full or
    // permission-denied condition would produce.
    await mkdir(path.join(homeDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(homeDir, ".finanfa-code", "sessions"), "not a directory");

    const session = new AgentSession({ cwd: "/some/project", model: "m", systemPrompt: "s" });
    session.messages = [{ role: "user", content: "hi" }];

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(session.persist()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to save session state"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("still persists normally when the directory is writable", async () => {
    const session = new AgentSession({ cwd: "/some/project", model: "m", systemPrompt: "s" });
    session.messages = [{ role: "user", content: "hi" }];

    await expect(session.persist()).resolves.toBeUndefined();

    const resumed = await AgentSession.resume("/some/project", session.id, "s");
    expect(resumed.messages).toEqual(session.messages);
  });

  it("redacts a configured secret env var's value out of messages/errorLog before writing to disk", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-real-secret-0123456789";
    try {
      const session = new AgentSession({ cwd: "/some/project", model: "m", systemPrompt: "s" });
      session.messages = [
        { role: "tool", results: [{ toolCallId: "1", content: "your key is sk-ant-real-secret-0123456789", isError: false }] },
      ];
      session.errorLog = [{ text: "auth failed with key sk-ant-real-secret-0123456789", afterMessageIndex: 0 }];

      await session.persist();

      const projectHash = createHash("sha256").update("/some/project").digest("hex").slice(0, 12);
      const raw = await readFile(path.join(homeDir, ".finanfa-code", "sessions", projectHash, `${session.id}.json`), "utf-8");
      expect(raw).not.toContain("sk-ant-real-secret-0123456789");

      const resumed = await AgentSession.resume("/some/project", session.id, "s");
      expect(JSON.stringify(resumed.messages)).not.toContain("sk-ant-real-secret-0123456789");
      expect(resumed.errorLog?.[0].text).not.toContain("sk-ant-real-secret-0123456789");
    } finally {
      // Real bug found here: `process.env.X = undefined` does NOT unset X —
      // Node coerces it to the literal string "undefined", which then
      // leaked into every later test's denylist (collectEnvSecretValues)
      // since ANTHROPIC_API_KEY isn't unset in this shell to begin with.
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it("persists providerKind/providerBaseUrl and restores them on resume — the real fix for a resumed session reconstructing the wrong provider for its model", async () => {
    const session = new AgentSession({ cwd: "/some/project", model: "local-only-model", systemPrompt: "s" });
    session.providerKind = "openai-compatible";
    session.providerBaseUrl = "http://localhost:11434/v1";

    await session.persist();

    const resumed = await AgentSession.resume("/some/project", session.id, "s");
    expect(resumed.model).toBe("local-only-model");
    expect(resumed.providerKind).toBe("openai-compatible");
    expect(resumed.providerBaseUrl).toBe("http://localhost:11434/v1");
  });

  it("persists thinkingBudgetTokens and restores it on resume", async () => {
    const session = new AgentSession({ cwd: "/some/project", model: "claude-sonnet-5", systemPrompt: "s" });
    session.thinkingBudgetTokens = 4096;

    await session.persist();

    const resumed = await AgentSession.resume("/some/project", session.id, "s");
    expect(resumed.thinkingBudgetTokens).toBe(4096);
  });

  it("leaves providerKind/providerBaseUrl undefined on resume for a session that never switched providers", async () => {
    const session = new AgentSession({ cwd: "/some/project", model: "claude-sonnet-5", systemPrompt: "s" });
    await session.persist();

    const resumed = await AgentSession.resume("/some/project", session.id, "s");
    expect(resumed.providerKind).toBeUndefined();
    expect(resumed.providerBaseUrl).toBeUndefined();
  });

  it("persists the current todo_write checklist and restores it into a fresh TodoStore on resume", async () => {
    const session = new AgentSession({ cwd: "/some/project", model: "m", systemPrompt: "s" });
    session.todos.set([
      { content: "Write the plan", status: "completed" },
      { content: "Ship it", status: "pending" },
    ]);

    await session.persist();

    const resumed = await AgentSession.resume("/some/project", session.id, "s");
    expect(resumed.todos.list()).toEqual([
      { content: "Write the plan", status: "completed" },
      { content: "Ship it", status: "pending" },
    ]);
  });

  it("redacts a configured secret env var's value out of todo content before writing to disk", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-real-secret-0123456789";
    try {
      const session = new AgentSession({ cwd: "/some/project", model: "m", systemPrompt: "s" });
      session.todos.set([{ content: "rotate the leaked key sk-ant-real-secret-0123456789", status: "pending" }]);

      await session.persist();

      const projectHash = createHash("sha256").update("/some/project").digest("hex").slice(0, 12);
      const raw = await readFile(path.join(homeDir, ".finanfa-code", "sessions", projectHash, `${session.id}.json`), "utf-8");
      expect(raw).not.toContain("sk-ant-real-secret-0123456789");

      const resumed = await AgentSession.resume("/some/project", session.id, "s");
      expect(JSON.stringify(resumed.todos.list())).not.toContain("sk-ant-real-secret-0123456789");
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it("resuming a session with no persisted todos leaves a fresh, empty TodoStore", async () => {
    const session = new AgentSession({ cwd: "/some/project", model: "m", systemPrompt: "s" });
    await session.persist();

    const resumed = await AgentSession.resume("/some/project", session.id, "s");
    expect(resumed.todos.list()).toEqual([]);
  });
});

describe("AgentSession.list", () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-session-list-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns each session's title alongside its id, undefined when none was set", async () => {
    const titled = new AgentSession({ cwd: "/proj", model: "m", systemPrompt: "s" });
    titled.title = "Real title";
    await titled.persist();
    const untitled = new AgentSession({ cwd: "/proj", model: "m", systemPrompt: "s" });
    await untitled.persist();

    const sessions = await AgentSession.list("/proj");
    const byId = new Map(sessions.map((s) => [s.id, s.title]));
    expect(byId.get(titled.id)).toBe("Real title");
    expect(byId.get(untitled.id)).toBeUndefined();
  });

  it("doesn't crash on a corrupted session file — reports title: undefined for that entry instead", async () => {
    const good = new AgentSession({ cwd: "/proj", model: "m", systemPrompt: "s" });
    good.title = "Fine";
    await good.persist();

    const sessionDir = path.join(homeDir, ".finanfa-code", "sessions");
    const projectDirs = await import("node:fs/promises").then((fs) => fs.readdir(sessionDir));
    await writeFile(path.join(sessionDir, projectDirs[0], "corrupted.json"), "{ not valid json");

    const sessions = await AgentSession.list("/proj");
    expect(sessions.find((s) => s.id === "corrupted")?.title).toBeUndefined();
    expect(sessions.find((s) => s.id === good.id)?.title).toBe("Fine");
  });
});
