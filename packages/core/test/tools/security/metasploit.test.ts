import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSecurityRunMetasploitTool } from "../../../src/tools/builtin/security/metasploit.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };
const FAKE_MSFCONSOLE = fileURLToPath(new URL("../../fixtures/fake-msfconsole.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

describe("security_run_metasploit (real subprocess, fake msfconsole stand-in)", () => {
  it("has 'dangerous' risk level", () => {
    const tool = createSecurityRunMetasploitTool({ msfconsoleBinary: FAKE_MSFCONSOLE });
    expect(tool.riskLevel).toBe("dangerous");
  });

  it("builds the correct -x command string (commands joined by '; ') and returns real output from the fake", async () => {
    const tool = createSecurityRunMetasploitTool({ msfconsoleBinary: FAKE_MSFCONSOLE });
    const result = await tool.handler({ commands: ["use auxiliary/scanner/portscan/tcp", "set RHOSTS 10.0.0.5", "run"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('real -x command received: "use auxiliary/scanner/portscan/tcp; set RHOSTS 10.0.0.5; run"');
    expect(result.content).toContain('real args received: ["-q","-x","use auxiliary/scanner/portscan/tcp; set RHOSTS 10.0.0.5; run"]');
  });

  it("reports msfconsole as unavailable, rather than crashing, when it's missing", async () => {
    const tool = createSecurityRunMetasploitTool({ msfconsoleBinary: MISSING_BIN });
    const result = await tool.handler({ commands: ["use auxiliary/scanner/portscan/tcp"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/msfconsole not available/i);
  });

  it("reports a real msfconsole failure as a tool error with the real stderr", async () => {
    const tool = createSecurityRunMetasploitTool({ msfconsoleBinary: FAKE_MSFCONSOLE });
    const result = await tool.handler({ commands: ["fail"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("module not found");
  });

  it("respects a configured timeout against a long-running fake console", async () => {
    const tool = createSecurityRunMetasploitTool({ msfconsoleBinary: FAKE_MSFCONSOLE });
    const start = Date.now();
    const result = await tool.handler({ commands: ["sleep-forever"], timeoutMs: 500 }, ctx);
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
    expect(elapsed).toBeLessThan(4_000);
  }, 8_000);
});
