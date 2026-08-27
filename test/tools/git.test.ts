import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gitStatus,
  gitDiff,
  gitLog,
  gitBranch,
  gitAdd,
  gitCommit,
  gitCheckout,
} from "../../src/tools/builtin/git.js";

const execFileAsync = promisify(execFile);

describe("git tools (real git repo)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-git-test-"));
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(path.join(dir, "a.txt"), "hello\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  it("git_status reports a clean tree, then an untracked file", async () => {
    const clean = await gitStatus.handler({}, ctx());
    expect(clean.isError).toBe(false);
    expect(clean.content).toContain("clean");

    await writeFile(path.join(dir, "b.txt"), "new\n");
    const dirty = await gitStatus.handler({}, ctx());
    expect(dirty.content).toContain("b.txt");
  });

  it("git_diff shows unstaged changes, and none once staged with --staged unset", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello\nworld\n");
    const diff = await gitDiff.handler({}, ctx());
    expect(diff.isError).toBe(false);
    expect(diff.content).toContain("+world");
  });

  it("git_diff --staged only shows staged changes", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello\nworld\n");
    const beforeStage = await gitDiff.handler({ staged: true }, ctx());
    expect(beforeStage.content).toBe("(no output)");

    await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
    const afterStage = await gitDiff.handler({ staged: true }, ctx());
    expect(afterStage.content).toContain("+world");
  });

  it("git_log shows the initial commit", async () => {
    const log = await gitLog.handler({}, ctx());
    expect(log.isError).toBe(false);
    expect(log.content).toContain("initial");
  });

  it("git_branch lists the current branch", async () => {
    const branches = await gitBranch.handler({}, ctx());
    expect(branches.isError).toBe(false);
    expect(branches.content).toContain("initial");
  });

  it("git_add stages a file, visible in a subsequent git_status", async () => {
    await writeFile(path.join(dir, "b.txt"), "new\n");
    const add = await gitAdd.handler({ paths: ["b.txt"] }, ctx());
    expect(add.isError).toBe(false);

    const status = await gitStatus.handler({}, ctx());
    expect(status.content).toContain("b.txt");
  });

  it("git_add rejects a path escaping the project root", async () => {
    await expect(gitAdd.handler({ paths: ["../outside.txt"] }, ctx())).rejects.toThrow(/outside the project root/);
  });

  it("git_commit commits staged changes, then fails with nothing staged", async () => {
    await writeFile(path.join(dir, "b.txt"), "new\n");
    await gitAdd.handler({ paths: ["b.txt"] }, ctx());
    const commit = await gitCommit.handler({ message: "add b.txt" }, ctx());
    expect(commit.isError).toBe(false);

    const log = await gitLog.handler({}, ctx());
    expect(log.content).toContain("add b.txt");

    const nothingToCommit = await gitCommit.handler({ message: "empty" }, ctx());
    expect(nothingToCommit.isError).toBe(true);
  });

  it("git_commit rejects an empty message without shelling out", async () => {
    const result = await gitCommit.handler({ message: "   " }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("empty");
  });

  it("git_checkout creates and switches to a new branch, visible in git_branch", async () => {
    const checkout = await gitCheckout.handler({ branch: "feature-x", create: true }, ctx());
    expect(checkout.isError).toBe(false);

    const branches = await gitBranch.handler({}, ctx());
    expect(branches.content).toContain("* feature-x");
  });

  it("git_checkout fails cleanly for a branch that doesn't exist", async () => {
    const result = await gitCheckout.handler({ branch: "does-not-exist" }, ctx());
    expect(result.isError).toBe(true);
  });
});
