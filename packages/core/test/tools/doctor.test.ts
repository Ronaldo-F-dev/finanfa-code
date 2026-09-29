import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, chmod, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDoctorTools } from "../../src/tools/builtin/doctor.js";

const execFileAsync = promisify(execFile);
const ctx = (dir: string) => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function findingIds(content: string): string[] {
  return [...content.matchAll(/^\s*id: (.+)$/gm)].map((m) => m[1]);
}

describe("doctor tools (real temp dirs, real git/npm subprocesses)", () => {
  let dir: string;
  let doctorCheck: ReturnType<typeof createDoctorTools>[0];
  let doctorFix: ReturnType<typeof createDoctorTools>[1];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-doctor-"));
    [doctorCheck, doctorFix] = createDoctorTools();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("has the expected risk levels", () => {
    expect(doctorCheck.riskLevel).toBe("safe");
    expect(doctorFix.riskLevel).toBe("ask");
  });

  it("flags a .env file that isn't gitignored, and passes once it is", async () => {
    await initGitRepo(dir);
    await writeFile(path.join(dir, ".env"), "SECRET=1\n", "utf-8");

    let result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("[FAIL] Secret-bearing files gitignored");
    expect(result.content).toContain("gitignore-missing-entry:.env");

    await writeFile(path.join(dir, ".gitignore"), ".env\n", "utf-8");
    result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("[PASS] Secret-bearing files gitignored");
  });

  it("skips the gitignore checks gracefully when the directory isn't a git repo", async () => {
    const result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("[SKIPPED] Secret-bearing files gitignored");
    expect(result.content).toContain("[SKIPPED] .gitignore exists");
  });

  it("flags a missing .gitignore in a git repo, and passes once one exists", async () => {
    await initGitRepo(dir);
    let result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("[FAIL] .gitignore exists");
    expect(result.content).toContain("gitignore-file-missing");

    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf-8");
    result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("[PASS] .gitignore exists");
  });

  it("flags no-lockfile and lockfile-conflict, and passes with exactly one", async () => {
    await writeFile(path.join(dir, "package.json"), '{"name":"t","version":"1.0.0"}', "utf-8");

    let result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("lockfile-missing");

    await writeFile(path.join(dir, "package-lock.json"), "{}", "utf-8");
    await writeFile(path.join(dir, "yarn.lock"), "", "utf-8");
    result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("lockfile-conflict");
    expect(result.content).toContain("package-lock.json");
    expect(result.content).toContain("yarn.lock");

    await rm(path.join(dir, "yarn.lock"));
    result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("[PASS] Lockfile presence matches package manager");
  });

  it("skips the lockfile check gracefully when there's no package.json", async () => {
    const result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("[SKIPPED] Lockfile presence matches package manager");
    expect(result.content).toContain("no package.json");
  });

  it("flags world-readable permissions on a secret file, and passes once chmod'd to 600", async () => {
    const envPath = path.join(dir, ".env");
    await writeFile(envPath, "SECRET=1\n", "utf-8");
    await chmod(envPath, 0o644);

    let result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("[FAIL] Sensitive file permissions");
    expect(result.content).toContain("file-permissions:.env");

    await chmod(envPath, 0o600);
    result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("[PASS] Sensitive file permissions");
  });

  it("runs a real npm audit against a minimal offline-safe package.json and parses real JSON counts", async () => {
    await writeFile(path.join(dir, "package.json"), '{"name":"t","version":"1.0.0","dependencies":{}}', "utf-8");
    await writeFile(path.join(dir, "package-lock.json"), "{}", "utf-8");

    const result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.isError).toBe(false);
    // With zero dependencies there's nothing to be vulnerable, so the
    // section should pass cleanly rather than fail or report a failed run.
    expect(result.content).toContain("[PASS] Dependency vulnerabilities (npm audit)");
    expect(result.content).not.toContain("npm-audit-failed");
  }, 30_000);

  it("skips the npm audit check gracefully when there's no package.json", async () => {
    const result = await doctorCheck.handler({ directory: dir }, ctx(dir));
    expect(result.content).toContain("[SKIPPED] Dependency vulnerabilities (npm audit)");
  });

  it("reports npm as unavailable gracefully instead of crashing", async () => {
    await writeFile(path.join(dir, "package.json"), '{"name":"t","version":"1.0.0"}', "utf-8");
    const [check] = createDoctorTools({ npmBinary: "this-binary-does-not-exist-xyz" });
    const result = await check.handler({ directory: dir }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("npm-audit-unavailable");
    expect(result.content).toContain("npm is not on PATH");
  });

  it("defaults directory to ctx.cwd when omitted", async () => {
    await initGitRepo(dir);
    const result = await doctorCheck.handler({}, ctx(dir));
    expect(result.content).toContain(`Doctor report for ${dir}`);
  });

  describe("doctor_fix_project", () => {
    it("appends a missing gitignore entry, creating .gitignore if needed", async () => {
      const result = await doctorFix.handler({ directory: dir, findingIds: ["gitignore-missing-entry:.env"] }, ctx(dir));
      expect(result.isError).toBe(false);
      expect(result.content).toContain('added ".env" to .gitignore');
      expect(await readFile(path.join(dir, ".gitignore"), "utf-8")).toBe(".env\n");
    });

    it("appends to an existing .gitignore without disturbing its other lines", async () => {
      await writeFile(path.join(dir, ".gitignore"), "node_modules/\n", "utf-8");
      await doctorFix.handler({ directory: dir, findingIds: ["gitignore-missing-entry:.env"] }, ctx(dir));
      expect(await readFile(path.join(dir, ".gitignore"), "utf-8")).toBe("node_modules/\n.env\n");
    });

    it("is idempotent — doesn't duplicate an entry that's already there", async () => {
      await writeFile(path.join(dir, ".gitignore"), ".env\n", "utf-8");
      const result = await doctorFix.handler({ directory: dir, findingIds: ["gitignore-missing-entry:.env"] }, ctx(dir));
      expect(result.content).toContain("skipped");
      expect(await readFile(path.join(dir, ".gitignore"), "utf-8")).toBe(".env\n");
    });

    it("chmods an insecure secret file to 600", async () => {
      const envPath = path.join(dir, ".env");
      await writeFile(envPath, "SECRET=1\n", "utf-8");
      await chmod(envPath, 0o644);

      const result = await doctorFix.handler({ directory: dir, findingIds: ["file-permissions:.env"] }, ctx(dir));
      expect(result.isError).toBe(false);
      expect(result.content).toContain("chmod'd to 600");
      const info = await stat(envPath);
      expect(info.mode & 0o777).toBe(0o600);
    });

    it("refuses to auto-fix lockfile/npm-audit findings with a clear manual-fix message", async () => {
      const result = await doctorFix.handler(
        { directory: dir, findingIds: ["lockfile-missing", "lockfile-conflict", "npm-audit-vulnerabilities"] },
        ctx(dir),
      );
      expect(result.isError).toBe(false);
      for (const id of ["lockfile-missing", "lockfile-conflict", "npm-audit-vulnerabilities"]) {
        expect(result.content).toContain(`${id}: not auto-fixed`);
      }
    });

    it("fixes real findings from a real doctor_check_project report end to end", async () => {
      await initGitRepo(dir);
      const envPath = path.join(dir, ".env");
      await writeFile(envPath, "SECRET=1\n", "utf-8");
      await chmod(envPath, 0o644);

      const checkResult = await doctorCheck.handler({ directory: dir }, ctx(dir));
      const ids = findingIds(checkResult.content);
      expect(ids).toContain("gitignore-missing-entry:.env");
      expect(ids).toContain("file-permissions:.env");

      const fixResult = await doctorFix.handler({ directory: dir, findingIds: ids }, ctx(dir));
      expect(fixResult.isError).toBe(false);

      const recheck = await doctorCheck.handler({ directory: dir }, ctx(dir));
      expect(recheck.content).toContain("[PASS] Secret-bearing files gitignored");
      expect(recheck.content).toContain("[PASS] Sensitive file permissions");
    });
  });
});
