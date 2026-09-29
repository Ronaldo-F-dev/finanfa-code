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

  it("rejects a --script dos request before ever spawning nmap", async () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: MISSING_BIN }); // even with a missing binary, the guard fires first
    const result = await tool.handler({ target: "10.0.0.5", args: ["--script", "dos"] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Blocked");
    expect(result.content).not.toMatch(/nmap not available/i);
  });

  it("rejects a --script dos request expressed as a boolean expression and via --script=", async () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: MISSING_BIN });
    const r1 = await tool.handler({ target: "10.0.0.5", args: ["--script", "dos and safe"] }, ctx);
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain("Blocked");

    const r2 = await tool.handler({ target: "10.0.0.5", args: ["--script=dos,vuln"] }, ctx);
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain("Blocked");
  });

  it("does not block a script category that merely contains 'dos' as a substring or an unrelated category", async () => {
    const tool = createSecurityRunNmapTool({ nmapBinary: FAKE_NMAP });
    const result = await tool.handler({ target: "10.0.0.5", args: ["--script", "vuln,safe"] }, ctx);
    expect(result.isError).toBe(false);
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
