import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendAuditEvent, auditFilePath } from "../../src/observability/audit-log.js";
import { readAuditLogTool } from "../../src/tools/builtin/read-audit-log.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("audit log (real JSONL file on disk)", () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-audit-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("appendAuditEvent records one JSON line per event, with a timestamp added", async () => {
    appendAuditEvent({ sessionId: "s1", cwd: "/tmp/project", tool: "bash", riskLevel: "dangerous", riskKey: "bash:rm -rf /", decision: "deny", source: "user_prompt" });

    const raw = await readFile(auditFilePath(), "utf-8");
    const events = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe("bash");
    expect(events[0].decision).toBe("deny");
    expect(events[0].source).toBe("user_prompt");
    expect(typeof events[0].ts).toBe("string");
  });

  it("read_audit_log tool summarizes recorded decisions, listing denials with their source", async () => {
    appendAuditEvent({ sessionId: "s1", cwd: "/tmp", tool: "bash", riskLevel: "dangerous", riskKey: "bash:ls", decision: "allow", source: "session_allowlist" });
    appendAuditEvent({ sessionId: "s1", cwd: "/tmp", tool: "bash", riskLevel: "dangerous", riskKey: "bash:rm -rf /", decision: "deny", source: "user_prompt" });

    const result = await readAuditLogTool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2 permission decision(s) recorded");
    expect(result.content).toContain("1 denied");
    expect(result.content).toContain("bash (bash:rm -rf /) — source: user_prompt");
  });

  it("read_audit_log reports no file for a date nothing was recorded on", async () => {
    const result = await readAuditLogTool.handler({ date: "2001-01-01" }, ctx);
    expect(result.content).toContain("No audit log file for that date");
  });

  it("read_audit_log with raw:true returns the unsummarized JSONL", async () => {
    appendAuditEvent({ sessionId: "s1", cwd: "/tmp", tool: "grep", riskLevel: "safe", riskKey: "grep", decision: "allow", source: "default_for_risk_level" });
    const result = await readAuditLogTool.handler({ raw: true }, ctx);
    const lines = result.content.trim().split("\n");
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it("read_audit_log rejects an invalid date", async () => {
    const result = await readAuditLogTool.handler({ date: "not-a-date" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("has 'safe' risk level (read-only)", () => {
    expect(readAuditLogTool.riskLevel).toBe("safe");
  });
});
