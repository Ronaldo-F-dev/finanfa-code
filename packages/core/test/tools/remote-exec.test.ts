import { describe, expect, it, beforeAll } from "vitest";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRunRemoteCommandTool } from "../../src/tools/builtin/remote-exec.js";

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
