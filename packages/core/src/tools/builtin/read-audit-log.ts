import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "../../core/types.js";
import { auditFilePath, type AuditEvent } from "../../observability/audit-log.js";

function parseLines(raw: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      continue;
    }
  }
  return events;
}

function summarize(events: AuditEvent[]): string {
  if (events.length === 0) return "No permission decisions recorded for that date.";

  const lines: string[] = [`${events.length} permission decision(s) recorded.`];
  const denies = events.filter((e) => e.decision === "deny");
  lines.push(`${denies.length} denied.`);
  if (denies.length > 0) {
    lines.push("", "Denied:");
    for (const e of denies) lines.push(`  ${e.ts} ${e.tool} (${e.riskKey}) — source: ${e.source}, session ${e.sessionId}`);
  }
  return lines.join("\n");
}

interface ReadAuditLogInput {
  date?: string;
  raw?: boolean;
}

export const readAuditLogTool: ToolDefinition<ReadAuditLogInput> = {
  name: "read_audit_log",
  description:
    "Read this agent's own structured audit trail of permission decisions (every tool call allow/deny, which " +
    "code path decided it — a hook, yolo, an allowlist, a config rule, or a direct user answer) recorded so far " +
    "today (or a given date). Independent of the OpenTelemetry trace file (read_traces): a denied call never " +
    "reaches that one, since the tool is never actually invoked. Use this for a security/compliance review of " +
    "what this agent was allowed or refused to do. Pass raw:true to get the unsummarized JSONL instead.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date to read the audit log for, YYYY-MM-DD (defaults to today)" },
      raw: { type: "boolean", description: "Return the raw JSONL events instead of a summary" },
    },
  },
  describeCall: (input) => `read audit log${input.date ? ` for ${input.date}` : ""}`,
  async handler(input) {
    const date = input.date ? new Date(input.date) : new Date();
    if (Number.isNaN(date.getTime())) return { content: `"${input.date}" is not a valid date (expected YYYY-MM-DD).`, isError: true };

    let raw: string;
    try {
      raw = await readFile(auditFilePath(date), "utf-8");
    } catch {
      return { content: "No audit log file for that date — no permission decisions have been recorded yet.", isError: false };
    }

    if (input.raw) return { content: raw, isError: false };
    return { content: summarize(parseLines(raw)), isError: false };
  },
};
