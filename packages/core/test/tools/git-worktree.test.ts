import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitWorktree } from "../../src/tools/builtin/git-worktree.js";

const execFileAsync = promisify(execFile);

describe("git_worktree (real git repo)", () => {
  let dir: string;
  const ctx = () => ({ cwd: dir, sessionId: "test", signal: new AbortController().signal });

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "finanfa-worktree-")));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(path.join(dir, "a.txt"), "hello\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("adds a worktree on a new branch, lists it, and removes it", async () => {
    const wt = path.join(dir, "wt-feature");
    const added = await gitWorktree.handler({ action: "add", branch: "feature/x", create: true, path: wt }, ctx());
    expect(added.isError).toBe(false);
    expect(added.content).toContain(`Created worktree at ${wt}`);
    expect(await readFile(path.join(wt, "a.txt"), "utf-8")).toBe("hello\n");
    expect((await execFileAsync("git", ["branch", "--show-current"], { cwd: wt })).stdout.trim()).toBe("feature/x");

    const listed = await gitWorktree.handler({ action: "list" }, ctx());
    expect(listed.content).toContain(wt);

    const removed = await gitWorktree.handler({ action: "remove", path: wt }, ctx());
    expect(removed.isError).toBe(false);
    await expect(stat(wt)).rejects.toThrow();
  });

  it("checks out an existing branch when create is not set", async () => {
    await execFileAsync("git", ["branch", "existing"], { cwd: dir });
    const wt = path.join(dir, "wt-existing");
    const added = await gitWorktree.handler({ action: "add", branch: "existing", path: wt }, ctx());
    expect(added.isError).toBe(false);
    expect((await execFileAsync("git", ["branch", "--show-current"], { cwd: wt })).stdout.trim()).toBe("existing");
  });

  it("refuses to remove a worktree with uncommitted changes unless forced", async () => {
    const wt = path.join(dir, "wt-dirty");
    await gitWorktree.handler({ action: "add", branch: "dirty", create: true, path: wt }, ctx());
    await writeFile(path.join(wt, "new.txt"), "uncommitted\n");
    const refused = await gitWorktree.handler({ action: "remove", path: wt }, ctx());
    expect(refused.isError).toBe(true);
    const forced = await gitWorktree.handler({ action: "remove", path: wt, force: true }, ctx());
    expect(forced.isError).toBe(false);
  });

  it("rejects a branch name that git would parse as an option, and missing arguments", async () => {
    expect((await gitWorktree.handler({ action: "add", branch: "--detach", path: path.join(dir, "x") }, ctx())).isError).toBe(true);
    expect((await gitWorktree.handler({ action: "add" }, ctx())).isError).toBe(true);
    expect((await gitWorktree.handler({ action: "remove" }, ctx())).isError).toBe(true);
  });

  it("rejects a path outside the project and the home directory", async () => {
    await expect(gitWorktree.handler({ action: "add", branch: "b", create: true, path: "/etc/finanfa-wt" }, ctx())).rejects.toThrow(/outside the project root/);
  });

  it("is registered with the other git tools", async () => {
    const { ToolRegistry } = await import("../../src/tools/registry.js");
    const { registerBuiltins } = await import("../../src/tools/builtin/index.js");
    const registry = new ToolRegistry();
    registerBuiltins(registry, {});
    expect(registry.get("git_worktree")?.riskLevel).toBe("ask");
  }, 30_000); // importing every builtin tool is slow on a cold cache
});
