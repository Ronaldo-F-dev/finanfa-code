import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// A durable, append-only, security-focused audit trail of permission
// decisions — closing a real gap relative to a comparable project we
// audited against, which keeps a structured audit log of every
// allow/deny decision. The existing `~/.finanfa-code/traces/*.jsonl`
// (see jsonl-exporter.ts) is a perf/observability trace of tool-call
// durations — it has no permission semantics, and a DENIED call never
// even reaches it (loop.ts returns before the span starts). This is a
// separate, independent log, one JSON line per decision, so a compliance
// review or `jq`/`grep` query doesn't need to reconstruct decisions from
// tool-call spans or dig through a session transcript's tool_result
// blocks.
function auditDir(): string {
  return path.join(os.homedir(), ".finanfa-code", "audit");
}

export function auditFilePath(date = new Date()): string {
  const iso = date.toISOString().slice(0, 10);
  return path.join(auditDir(), `${iso}.jsonl`);
}

/** Which code path in PermissionManager.check() produced the decision — lets a reviewer tell "the user typed 'n'" apart from "a PreToolUse hook blocked it" or "config already allows this by default". */
export type AuditDecisionSource = "pre_tool_use_hook" | "yolo" | "session_allowlist" | "rule" | "default_for_risk_level" | "non_interactive" | "prepare_error" | "user_prompt";

export interface AuditEvent {
  ts: string;
  sessionId: string;
  cwd: string;
  tool: string;
  riskLevel: string;
  riskKey: string;
  decision: "allow" | "deny";
  source: AuditDecisionSource;
}

export function appendAuditEvent(event: Omit<AuditEvent, "ts">): void {
  try {
    mkdirSync(auditDir(), { recursive: true });
    // Sync I/O, same reasoning as JsonlFileSpanExporter: a permission
    // decision is infrequent (at most one per tool call, gated by a human
    // prompt on the "ask" path) and must be durable before check()
    // returns, not raced against whatever the caller does immediately
    // after — not a hot path where sync cost would matter.
    appendFileSync(auditFilePath(), JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf-8");
  } catch (err) {
    // An audit-log write failure must never block or fail the actual
    // permission decision it's recording — same defensive convention as
    // session.ts's persist() and JsonlFileSpanExporter's export().
    console.error(`Warning: failed to write audit log event: ${err instanceof Error ? err.message : String(err)}`);
  }
}
