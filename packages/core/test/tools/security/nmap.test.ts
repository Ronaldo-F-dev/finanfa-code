import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createSecurityRunNmapTool } from "../../../src/tools/builtin/security/nmap.js";

const ctx = { cwd: "/tmp", sessionId: "test", signal: new AbortController().signal };
const FAKE_NMAP = fileURLToPath(new URL("../../fixtures/fake-nmap.mjs", import.meta.url));
const MISSING_BIN = "/nonexistent/definitely-not-a-real-binary-xyz";

describe("security_run_nmap (real subprocess, fake nmap stand-in)", () => {
  it("has 'ask' risk level", () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: FAKE_NMAP });
    expect(tool.riskLevel).toBe("ask");
  });

  it("builds correct argv (flags then target appended) and returns real output from the fake", async () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: FAKE_NMAP });
    const result = await tool.handler({ target: "10.0.0.5", args: ["-sV", "-p", "1-1000"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('real args received: ["-sV","-p","1-1000","10.0.0.5"]');
    expect(result.content).toContain("Nmap done: scan complete");
  });

  it("reports nmap as unavailable, rather than crashing, when it's missing", async () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: MISSING_BIN });
    const result = await tool.handler({ target: "10.0.0.5" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/nmap not available/i);
  });

  it("runs a --script dos request like any other scan — real DoS confirmation is the permission prompt's job, not a code-level block", async () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: FAKE_NMAP });
    const result = await tool.handler({ target: "10.0.0.5", args: ["--script", "dos"] }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"--script","dos"');
  });

  it("gives a dos-script request a distinct riskKey (so a stricter permission rule can target it) while a normal scan keeps the plain tool-name key", () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: FAKE_NMAP });
    expect(tool.riskKey?.({ target: "10.0.0.5", args: ["--script", "dos and safe"] })).toBe("security_run_nmap:dos-script");
    expect(tool.riskKey?.({ target: "10.0.0.5", args: ["--script=dos,vuln"] })).toBe("security_run_nmap:dos-script");
    expect(tool.riskKey?.({ target: "10.0.0.5", args: ["--script", "vuln,safe"] })).toBe("security_run_nmap");
  });

  it("describeCall flags a dos-script request as requiring confirmation", () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: FAKE_NMAP });
    expect(tool.describeCall?.({ target: "10.0.0.5", args: ["--script", "dos"] })).toContain("requires confirmation");
    expect(tool.describeCall?.({ target: "10.0.0.5", args: ["-sV"] })).not.toContain("requires confirmation");
  });

  it("reports a real nmap failure as a tool error with the real stderr", async () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: FAKE_NMAP });
    const result = await tool.handler({ target: "10.0.0.5", args: ["--fail"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("something went wrong");
  });

  it("respects a configured timeout against a long-running fake scan", async () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: FAKE_NMAP });
    const start = Date.now();
    const result = await tool.handler({ target: "10.0.0.5", args: ["--sleep-forever"], timeoutMs: 500 }, ctx);
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
    expect(elapsed).toBeLessThan(4_000);
  }, 8_000);
});
