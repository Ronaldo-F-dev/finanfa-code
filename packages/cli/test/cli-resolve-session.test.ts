import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { resolveSession, type CliOptions } from "../src/cli.js";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import type { UIAdapter } from "@finanfa/core/src/ui/adapter.js";

function makeUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

function baseOpts(): CliOptions {
  return { ui: "readline" };
}

function sessionFilePath(cwd: string, id: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return path.join(os.homedir(), ".finanfa-code", "sessions", hash, `${id}.json`);
}

describe("resolveSession", () => {
  let cwd: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "finanfa-resolve-cwd-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-resolve-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(cwd, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("starts a fresh session when neither --resume nor --continue is given", async () => {
    const ui = makeUi();
    const session = await resolveSession(cwd, baseOpts(), "model", "sys", ui);
    expect(session.messages).toEqual([]);
    expect(ui.writeError).not.toHaveBeenCalled();
  });

  it("resumes an existing session by id with --resume", async () => {
    const ui = makeUi();
    const original = new AgentSession({ cwd, model: "m", systemPrompt: "sys" });
    original.messages = [{ role: "user", content: "hello" }];
    await original.persist();

    const resumed = await resolveSession(cwd, { ...baseOpts(), resume: original.id }, "model", "sys", ui);
    expect(resumed.id).toBe(original.id);
    expect(resumed.messages).toEqual(original.messages);
    expect(ui.writeError).not.toHaveBeenCalled();
  });

  it("falls back to a fresh session and warns, instead of crashing, when --resume names a nonexistent id", async () => {
    const ui = makeUi();
    const session = await resolveSession(cwd, { ...baseOpts(), resume: "does-not-exist" }, "model", "sys", ui);

    expect(session.messages).toEqual([]);
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("does-not-exist"));
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("Starting a new session instead"));
  });

  it("falls back to a fresh session and warns, instead of crashing, when the session file is corrupted", async () => {
    const ui = makeUi();
    const id = "corrupted-session-id";
    const file = sessionFilePath(cwd, id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not valid json", "utf-8");

    const session = await resolveSession(cwd, { ...baseOpts(), resume: id }, "model", "sys", ui);

    expect(session.messages).toEqual([]);
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining(id));
  });

  it("--continue picks the most recently modified session, falling back gracefully if none exist", async () => {
    const ui = makeUi();
    const noneYet = await resolveSession(cwd, { ...baseOpts(), continue: true }, "model", "sys", ui);
    expect(noneYet.messages).toEqual([]);
    expect(ui.writeError).not.toHaveBeenCalled();

    const older = new AgentSession({ cwd, model: "m", systemPrompt: "sys" });
    older.messages = [{ role: "user", content: "older" }];
    await older.persist();
    await new Promise((r) => setTimeout(r, 10));
    const newer = new AgentSession({ cwd, model: "m", systemPrompt: "sys" });
    newer.messages = [{ role: "user", content: "newer" }];
    await newer.persist();

    const resumed = await resolveSession(cwd, { ...baseOpts(), continue: true }, "model", "sys", ui);
    expect(resumed.id).toBe(newer.id);
  });
});
