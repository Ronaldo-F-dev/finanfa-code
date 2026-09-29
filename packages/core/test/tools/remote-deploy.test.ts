import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, chmod, writeFile, readFile, readlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteDeployTools } from "../../src/tools/builtin/remote-deploy.js";

const FAKE_SSH = fileURLToPath(new URL("../fixtures/fake-ssh.mjs", import.meta.url));
const FAKE_RSYNC = fileURLToPath(new URL("../fixtures/fake-rsync.mjs", import.meta.url));
const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

// fake-ssh.mjs/fake-rsync.mjs treat "host"/"user" as inert (they never
// actually connect anywhere) and operate on real local paths — so
// releasesDir/currentSymlink/localArtifactPath below are real temp
// directories on THIS machine standing in for "the remote host",
// letting these tests exercise the real symlink/directory mechanics
// (mkdir/rsync-copy/ln -sfn+mv -Tf/ls/readlink/rm) end to end.
const HOST = "example.test";
const USER = "deploy";

function tools() {
  return createRemoteDeployTools({ sshBinary: FAKE_SSH, rsyncBinary: FAKE_RSYNC });
}

describe("remote deploy tools (real subprocess, fake ssh/rsync stand-ins operating on real local dirs)", () => {
  let workDir: string;

  beforeAll(async () => {
    await chmod(FAKE_SSH, 0o755);
    await chmod(FAKE_RSYNC, 0o755);
  });

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "finanfa-remote-deploy-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function makeArtifact(content: string): Promise<string> {
    const dir = await mkdtemp(path.join(workDir, "artifact-"));
    await writeFile(path.join(dir, "hello.txt"), content, "utf-8");
    return dir;
  }

  it("has the expected tool names and risk levels/keys", () => {
    const [deploy, rollback, list] = tools();
    expect(deploy.name).toBe("remote_deploy_release");
    expect(deploy.riskLevel).toBe("ask");
    expect(deploy.riskKey?.({ host: HOST } as never)).toBe(`remote_deploy_release:${HOST}`);
    expect(rollback.name).toBe("remote_rollback_release");
    expect(rollback.riskLevel).toBe("ask");
    expect(rollback.riskKey?.({} as never)).toBe("remote_rollback_release");
    expect(list.name).toBe("remote_list_releases");
    expect(list.riskLevel).toBe("safe");
  });

  it("builds the real rsync argv (-az, -e ssh with BatchMode, trailing-slash source/dest)", async () => {
    const [deploy] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");
    const localArtifactPath = await makeArtifact("v1");

    const result = await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath }, ctx);
    expect(result.isError).toBe(false);
    // fake-rsync.mjs prints its own real received argv.
    expect(result).toBeTruthy();
  });

  it("builds the real ssh argv (-o BatchMode=yes, user@host, command last)", async () => {
    const [deploy] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");
    const localArtifactPath = await makeArtifact("v1");
    const argvLog = path.join(workDir, "ssh-argv.log");

    const originalLogFile = process.env.FAKE_SSH_ARGV_LOG_FILE;
    process.env.FAKE_SSH_ARGV_LOG_FILE = argvLog;
    try {
      const result = await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath }, ctx);
      expect(result.isError).toBe(false);
    } finally {
      if (originalLogFile === undefined) delete process.env.FAKE_SSH_ARGV_LOG_FILE;
      else process.env.FAKE_SSH_ARGV_LOG_FILE = originalLogFile;
    }

    const lines = (await readFile(argvLog, "utf-8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(lines.length).toBeGreaterThan(0);
    for (const args of lines) {
      expect(args[0]).toBe("-o");
      expect(args[1]).toBe("BatchMode=yes");
      expect(args[2]).toBe(`${USER}@${HOST}`);
      expect(args).toHaveLength(4); // -o BatchMode=yes, target, command
    }
    // The first real ssh call reads any existing "previous" release (for
    // rollback), then mkdir -p prepares releasesDir before rsync.
    expect(lines[0]?.[3]).toBe(`readlink ${currentSymlink} 2>/dev/null || true`);
    expect(lines[1]?.[3]).toBe(`mkdir -p ${releasesDir}`);
  });

  it("deploy happy path: health check passes, symlink flips to the new release, artifact contents land for real", async () => {
    const [deploy] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");
    const localArtifactPath = await makeArtifact("v1-content");

    const result = await deploy.handler(
      { host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath, healthCheckCommand: "test -f hello.txt" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Deployed and switched");

    const target = await readlink(currentSymlink);
    expect(existsSync(target)).toBe(true);
    expect(await readFile(path.join(target, "hello.txt"), "utf-8")).toBe("v1-content");
  });

  it("deploy runs startCommand from inside the new release directory", async () => {
    const [deploy] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");
    const localArtifactPath = await makeArtifact("v1");

    const result = await deploy.handler(
      { host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath, startCommand: "test -f hello.txt && echo started > started.marker" },
      ctx,
    );
    expect(result.isError).toBe(false);
    const target = await readlink(currentSymlink);
    expect(existsSync(path.join(target, "started.marker"))).toBe(true);
  });

  it("failure path: a failing health check automatically rolls the symlink back to the previous release and reports isError", async () => {
    const [deploy] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");

    const first = await deploy.handler(
      { host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v1"), healthCheckCommand: "true" },
      ctx,
    );
    expect(first.isError).toBe(false);
    const firstTarget = await readlink(currentSymlink);

    const second = await deploy.handler(
      { host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v2"), healthCheckCommand: "false" },
      ctx,
    );
    expect(second.isError).toBe(true);
    expect(second.content).toContain("health check failed");
    expect(second.content).toContain("rolled back to");
    expect(second.content).toContain(firstTarget);

    // The symlink must be back on the first (healthy) release, not the
    // second (unhealthy) one that failed its health check.
    const targetAfterRollback = await readlink(currentSymlink);
    expect(targetAfterRollback).toBe(firstTarget);
    expect(await readFile(path.join(targetAfterRollback, "hello.txt"), "utf-8")).toBe("v1");
  });

  it("first-ever deploy with a failing health check reports isError and explicitly says there is no previous release", async () => {
    const [deploy] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");

    const result = await deploy.handler(
      { host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v1"), healthCheckCommand: "false" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no previous release");
  });

  it("remote_rollback_release re-points the symlink to the release immediately before the current one", async () => {
    const [deploy, rollback] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");

    await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v1") }, ctx);
    const firstTarget = await readlink(currentSymlink);
    await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v2") }, ctx);
    const secondTarget = await readlink(currentSymlink);
    expect(secondTarget).not.toBe(firstTarget);

    const result = await rollback.handler({ host: HOST, user: USER, releasesDir, currentSymlink }, ctx);
    expect(result.isError).toBe(false);
    expect(await readlink(currentSymlink)).toBe(firstTarget);
  });

  it("remote_rollback_release fails clearly when there is nothing before the current release", async () => {
    const [deploy, rollback] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");

    await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v1") }, ctx);
    const result = await rollback.handler({ host: HOST, user: USER, releasesDir, currentSymlink }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No release before");
  });

  it("remote_list_releases marks the currently-symlinked release", async () => {
    const [deploy, , list] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");

    await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v1") }, ctx);
    await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v2") }, ctx);

    const result = await list.handler({ host: HOST, user: USER, releasesDir, currentSymlink }, ctx);
    expect(result.isError).toBe(false);
    const lines = result.content.split("\n");
    expect(lines.length).toBe(2);
    const currentLines = lines.filter((l) => l.endsWith("(current)"));
    expect(currentLines).toHaveLength(1);
    const notCurrent = lines.find((l) => !l.endsWith("(current)"))!;
    expect(currentLines[0]).not.toContain(notCurrent.trim());
  });

  it("keepReleases prunes older releases but never the current or previous (rollback target)", async () => {
    const [deploy] = tools();
    const releasesDir = path.join(workDir, "releases");
    const currentSymlink = path.join(workDir, "current");

    await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v1"), keepReleases: 1 }, ctx);
    const releaseA = path.basename(await readlink(currentSymlink));

    await deploy.handler({ host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v2"), keepReleases: 1 }, ctx);
    const releaseB = path.basename(await readlink(currentSymlink));
    // A is "previous" relative to B, so pruning at this point must still keep it.
    expect((await readdir(releasesDir)).sort()).toEqual([releaseA, releaseB].sort());

    const third = await deploy.handler(
      { host: HOST, user: USER, releasesDir, currentSymlink, localArtifactPath: await makeArtifact("v3"), keepReleases: 1 },
      ctx,
    );
    const releaseC = path.basename(await readlink(currentSymlink));
    expect(third.content).toContain("Pruned 1 old release(s)");

    const remaining = (await readdir(releasesDir)).sort();
    // A (no longer current or previous) is pruned; B (previous) and C (current) survive.
    expect(remaining).toEqual([releaseB, releaseC].sort());
    expect(remaining).not.toContain(releaseA);
  });

  it("rejects a host/user/releasesDir/currentSymlink containing shell metacharacters without ever invoking ssh/rsync", async () => {
    const [deploy] = tools();
    const localArtifactPath = await makeArtifact("v1");
    const base = { user: USER, releasesDir: path.join(workDir, "releases"), currentSymlink: path.join(workDir, "current"), localArtifactPath };

    const badHost = await deploy.handler({ ...base, host: "example.test; rm -rf /" }, ctx);
    expect(badHost.isError).toBe(true);
    expect(badHost.content).toMatch(/shell metacharacter/);

    const badUser = await deploy.handler({ ...base, host: HOST, user: "deploy`whoami`" }, ctx);
    expect(badUser.isError).toBe(true);
    expect(badUser.content).toMatch(/shell metacharacter/);

    const badReleasesDir = await deploy.handler({ ...base, host: HOST, releasesDir: "/srv/app$(id)" }, ctx);
    expect(badReleasesDir.isError).toBe(true);
    expect(badReleasesDir.content).toMatch(/shell metacharacter/);

    const badSymlink = await deploy.handler({ ...base, host: HOST, currentSymlink: "/srv/current && curl evil.example" }, ctx);
    expect(badSymlink.isError).toBe(true);
    expect(badSymlink.content).toMatch(/shell metacharacter/);

    // None of the rejected calls should have created anything on disk —
    // proof validation happened before any ssh/rsync subprocess ran.
    expect(existsSync(base.releasesDir)).toBe(false);
  });

  it("reports a real missing-binary error instead of throwing", async () => {
    const [deploy] = createRemoteDeployTools({ sshBinary: "this-binary-does-not-exist-xyz", rsyncBinary: FAKE_RSYNC });
    const result = await deploy.handler(
      { host: HOST, user: USER, releasesDir: path.join(workDir, "releases"), currentSymlink: path.join(workDir, "current"), localArtifactPath: await makeArtifact("v1") },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/ENOENT|failed to start|command not found/i);
  });
});
