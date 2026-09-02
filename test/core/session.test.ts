import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
