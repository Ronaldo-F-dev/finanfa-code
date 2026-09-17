import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunRemoteCommandTool, runSsh, runSshWithRetry, isRetryableSshFailure } from "../../src/tools/builtin/remote-exec.js";

const FAKE_SSH_SCRIPT = fileURLToPath(new URL("../fixtures/fake-ssh.mjs", import.meta.url));
const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("run_remote_command tool (real subprocess, fake ssh binary stand-in)", () => {
  beforeAll(async () => {
    // Executable bit may not survive a git checkout/CI clone even though
    // it was chmod +x'd when authored — ensure it's really runnable via
    // its shebang before any test relies on that.
    await chmod(FAKE_SSH_SCRIPT, 0o755);
  });

  it("has 'dangerous' risk level", () => {
    expect(createRunRemoteCommandTool({ binary: FAKE_SSH_SCRIPT }).riskLevel).toBe("dangerous");
  });

  it("scopes the permission riskKey by host, not the whole tool", () => {
    const tool = createRunRemoteCommandTool({ binary: FAKE_SSH_SCRIPT });
    expect(tool.riskKey?.({ host: "prod.example.com", command: "whoami" })).toBe("remote:prod.example.com");
  });

  it("always runs BatchMode (non-interactive) and passes the target/command as real argv", async () => {
    const tool = createRunRemoteCommandTool({ binary: FAKE_SSH_SCRIPT });
    const result = await tool.handler({ host: "example.com", command: "whoami" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('args=["-o","BatchMode=yes","example.com","whoami"]');
  });

  it("includes user@host, -p <port>, and -i <identity_file> in the real argv when given", async () => {
    const tool = createRunRemoteCommandTool({ binary: FAKE_SSH_SCRIPT });
    const result = await tool.handler({ host: "example.com", command: "whoami", user: "deploy", port: 2222, identity_file: "/home/me/.ssh/id_ed25519" }, ctx);
    expect(result.content).toContain('args=["-o","BatchMode=yes","-p","2222","-i","/home/me/.ssh/id_ed25519","deploy@example.com","whoami"]');
  });

  it("does not shell-retokenize a command containing shell metacharacters — the remote shell sees it intact, not the local one", async () => {
    // The fake binary just echoes whatever ended up as its own last argv
    // element — if runSubprocess's shell:true+args behavior were used
    // here instead, a command like this would get partially consumed/
    // reinterpreted locally before ssh ever saw it.
    const tool = createRunRemoteCommandTool({ binary: FAKE_SSH_SCRIPT });
    const result = await tool.handler({ host: "example.com", command: 'echo "$(whoami)" && ls -la' }, ctx);
    expect(result.content).toContain('ran: echo "$(whoami)" && ls -la');
  });

  it("reports a real non-zero exit code as isError, with the real stderr content", async () => {
    const tool = createRunRemoteCommandTool({ binary: FAKE_SSH_SCRIPT });
    const result = await tool.handler({ host: "example.com", command: "fail" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied (publickey)");
  });

  it("defaults to the real 'ssh' binary name when no binary override is given", async () => {
    const tool = createRunRemoteCommandTool();
    const result = await tool.handler({ host: "nonexistent.invalid", command: "whoami", timeout_ms: 5_000 }, ctx);
    // Never actually reaches a real remote host in tests — this just
    // confirms the wrapper invokes something named "ssh" and reports back
    // a real (non-throwing) result either way (a real DNS/connection
    // failure here is still ssh's own real exit code, not a crash).
    expect(typeof result.isError).toBe("boolean");
  }, 15_000);
});

describe("runSsh / runSshWithRetry / isRetryableSshFailure (real subprocess, fake ssh binary stand-in)", () => {
  let failCountFile: string;
  let dir: string;
  let originalFailCountFile: string | undefined;

  beforeAll(async () => {
    await chmod(FAKE_SSH_SCRIPT, 0o755);
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-remote-exec-retry-"));
    failCountFile = path.join(dir, "fail-count");
    originalFailCountFile = process.env.FAKE_SSH_FAIL_COUNT_FILE;
    process.env.FAKE_SSH_FAIL_COUNT_FILE = failCountFile;
  });

  afterEach(async () => {
    if (originalFailCountFile === undefined) delete process.env.FAKE_SSH_FAIL_COUNT_FILE;
    else process.env.FAKE_SSH_FAIL_COUNT_FILE = originalFailCountFile;
    await rm(dir, { recursive: true, force: true });
  });

  it("isRetryableSshFailure is true for ssh's own exit 255 (connection-level failure)", async () => {
    const result = await runSsh(FAKE_SSH_SCRIPT, ["fail"], 5_000);
    expect(result.exitCode).toBe(255);
    expect(isRetryableSshFailure(result)).toBe(true);
  });

  it("isRetryableSshFailure is false once the REMOTE command itself ran and returned its own exit code", async () => {
    const result = await runSsh(FAKE_SSH_SCRIPT, ["remote-fail"], 5_000);
    expect(result.exitCode).toBe(7);
    expect(isRetryableSshFailure(result)).toBe(false);
  });

  it("isRetryableSshFailure is false for a clean success", async () => {
    const result = await runSsh(FAKE_SSH_SCRIPT, ["whoami"], 5_000);
    expect(isRetryableSshFailure(result)).toBe(false);
  });

  it("runSshWithRetry succeeds after N transient connection failures, within the given retry budget", async () => {
    await writeFile(failCountFile, "2"); // fails twice (connection-level), then the fixture lets it through

    const result = await runSshWithRetry(FAKE_SSH_SCRIPT, ["whoami"], 5_000, 2, 10);
    expect(result.isError).toBe(false);
    expect(result.stdout).toContain("args=");
  });

  it("runSshWithRetry gives up and reports the real failure once retries are exhausted", async () => {
    await writeFile(failCountFile, "5"); // more failures than the retry budget below

    const result = await runSshWithRetry(FAKE_SSH_SCRIPT, ["whoami"], 5_000, 2, 10);
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(255);
  });

  it("runSshWithRetry never retries a real remote-command failure, even with a nonzero retry budget", async () => {
    const result = await runSshWithRetry(FAKE_SSH_SCRIPT, ["remote-fail"], 5_000, 3, 10);
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(7);
  });

  it("run_remote_command's own retries input plumbs through and recovers from a transient failure", async () => {
    await writeFile(failCountFile, "1");
    const tool = createRunRemoteCommandTool({ binary: FAKE_SSH_SCRIPT });
    const result = await tool.handler({ host: "flaky-host", command: "whoami", retries: 2 }, ctx);
    expect(result.isError).toBe(false);
  });

  it("run_remote_command defaults to retries: 0 — a single transient connection failure is reported immediately, not retried", async () => {
    await writeFile(failCountFile, "1");
    const tool = createRunRemoteCommandTool({ binary: FAKE_SSH_SCRIPT });
    const result = await tool.handler({ host: "flaky-host", command: "whoami" }, ctx);
    expect(result.isError).toBe(true);
  });
});
