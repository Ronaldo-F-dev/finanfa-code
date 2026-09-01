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
  gitPush,
  gitFetch,
  gitPull,
  gitStash,
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

  describe("git_push (against a real local bare repo acting as the remote)", () => {
    let remoteDir: string;

    beforeEach(async () => {
      remoteDir = await mkdtemp(path.join(tmpdir(), "finanfa-git-remote-"));
      await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
      await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: dir });
    });

    afterEach(async () => {
      await rm(remoteDir, { recursive: true, force: true });
    });

    it("pushes the current branch to origin, verified by cloning the remote afterward", async () => {
      const result = await gitPush.handler({ setUpstream: true }, ctx());
      expect(result.isError).toBe(false);

      const cloneDir = await mkdtemp(path.join(tmpdir(), "finanfa-git-clone-"));
      try {
        await execFileAsync("git", ["clone", "-q", remoteDir, cloneDir]);
        const { stdout } = await execFileAsync("git", ["log", "--oneline"], { cwd: cloneDir });
        expect(stdout).toContain("initial");
      } finally {
        await rm(cloneDir, { recursive: true, force: true });
      }
    });

    it("pushes an explicitly named branch to an explicitly named remote", async () => {
      await gitCheckout.handler({ branch: "feature-x", create: true }, ctx());
      await writeFile(path.join(dir, "b.txt"), "new\n");
      await gitAdd.handler({ paths: ["b.txt"] }, ctx());
      await gitCommit.handler({ message: "add b.txt" }, ctx());

      const result = await gitPush.handler({ remote: "origin", branch: "feature-x", setUpstream: true }, ctx());
      expect(result.isError).toBe(false);

      const { stdout } = await execFileAsync("git", ["branch", "-r"], { cwd: dir });
      expect(stdout).toContain("origin/feature-x");
    });

    it("fails cleanly when the remote doesn't exist", async () => {
      const result = await gitPush.handler({ remote: "does-not-exist" }, ctx());
      expect(result.isError).toBe(true);
    });

    it("has no force option at all — never force-pushes", () => {
      expect(gitPush.inputSchema.properties).not.toHaveProperty("force");
    });

    it("git_fetch downloads new commits into a remote-tracking branch, without touching the working tree", async () => {
      const cloneDir = await mkdtemp(path.join(tmpdir(), "finanfa-git-clone-"));
      try {
        await gitPush.handler({ setUpstream: true }, ctx());
        await execFileAsync("git", ["clone", "-q", remoteDir, cloneDir]);
        await writeFile(path.join(cloneDir, "c.txt"), "from clone\n");
        await execFileAsync("git", ["add", "c.txt"], { cwd: cloneDir });
        await execFileAsync("git", ["commit", "-q", "-m", "add c.txt"], { cwd: cloneDir });
        await execFileAsync("git", ["push", "-q", "origin", "master"], { cwd: cloneDir });

        const result = await gitFetch.handler({}, ctx());
        expect(result.isError).toBe(false);

        const status = await gitStatus.handler({}, ctx());
        expect(status.content).not.toContain("c.txt"); // working tree untouched
        const { stdout } = await execFileAsync("git", ["log", "origin/master", "--oneline"], { cwd: dir });
        expect(stdout).toContain("add c.txt"); // but the remote-tracking ref sees it
      } finally {
        await rm(cloneDir, { recursive: true, force: true });
      }
    });

    it("git_pull fetches and merges the new commit into the current branch", async () => {
      const cloneDir = await mkdtemp(path.join(tmpdir(), "finanfa-git-clone-"));
      try {
        await gitPush.handler({ setUpstream: true }, ctx());
        await execFileAsync("git", ["clone", "-q", remoteDir, cloneDir]);
        await writeFile(path.join(cloneDir, "c.txt"), "from clone\n");
        await execFileAsync("git", ["add", "c.txt"], { cwd: cloneDir });
        await execFileAsync("git", ["commit", "-q", "-m", "add c.txt"], { cwd: cloneDir });
        await execFileAsync("git", ["push", "-q", "origin", "master"], { cwd: cloneDir });

        const result = await gitPull.handler({}, ctx());
        expect(result.isError).toBe(false);

        const log = await gitLog.handler({}, ctx());
        expect(log.content).toContain("add c.txt");
      } finally {
        await rm(cloneDir, { recursive: true, force: true });
      }
    });

    it("fails cleanly on git_pull merge conflict, instead of leaving an unclear result", async () => {
      const cloneDir = await mkdtemp(path.join(tmpdir(), "finanfa-git-clone-"));
      try {
        await gitPush.handler({ setUpstream: true }, ctx());
        await execFileAsync("git", ["clone", "-q", remoteDir, cloneDir]);
        await writeFile(path.join(cloneDir, "a.txt"), "conflicting change\n");
        await execFileAsync("git", ["add", "a.txt"], { cwd: cloneDir });
        await execFileAsync("git", ["commit", "-q", "-m", "conflict"], { cwd: cloneDir });
        await execFileAsync("git", ["push", "-q", "origin", "master"], { cwd: cloneDir });

        await writeFile(path.join(dir, "a.txt"), "local conflicting change\n");
        await gitAdd.handler({ paths: ["a.txt"] }, ctx());
        await gitCommit.handler({ message: "local conflict" }, ctx());

        const result = await gitPull.handler({}, ctx());
        expect(result.isError).toBe(true);
      } finally {
        await rm(cloneDir, { recursive: true, force: true });
      }
    });
  });

  describe("git_stash", () => {
    it("push stashes working-tree changes, restoring a clean status", async () => {
      await writeFile(path.join(dir, "a.txt"), "modified\n");
      const dirty = await gitStatus.handler({}, ctx());
      expect(dirty.content).toContain("a.txt");

      const result = await gitStash.handler({}, ctx());
      expect(result.isError).toBe(false);

      const clean = await gitStatus.handler({}, ctx());
      expect(clean.content).toContain("clean");
    });

    it("pop restores stashed changes", async () => {
      await writeFile(path.join(dir, "a.txt"), "modified\n");
      await gitStash.handler({}, ctx());

      const result = await gitStash.handler({ action: "pop" }, ctx());
      expect(result.isError).toBe(false);

      const status = await gitStatus.handler({}, ctx());
      expect(status.content).toContain("a.txt");
    });

    it("list shows a labeled stash entry", async () => {
      await writeFile(path.join(dir, "a.txt"), "modified\n");
      await gitStash.handler({ message: "my label" }, ctx());

      const result = await gitStash.handler({ action: "list" }, ctx());
      expect(result.isError).toBe(false);
      expect(result.content).toContain("my label");
    });

    it("fails cleanly when popping with nothing stashed", async () => {
      const result = await gitStash.handler({ action: "pop" }, ctx());
      expect(result.isError).toBe(true);
    });
  });
});
