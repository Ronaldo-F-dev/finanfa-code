import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "../../core/types.js";
import { traceFilePath } from "../../observability/jsonl-exporter.js";

interface TraceSpan {
  name: string;
  durationMs: number;
  attributes: Record<string, unknown>;
  statusCode: number;
}

function parseLines(raw: string): TraceSpan[] {
  const spans: TraceSpan[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      spans.push(JSON.parse(line) as TraceSpan);
    } catch {
      continue;
    }
  }
  return spans;
}

function summarize(spans: TraceSpan[]): string {
  if (spans.length === 0) return "No trace spans recorded for that date.";

  const byName = new Map<string, { count: number; totalMs: number; errors: number; key: string }[]>();
  for (const span of spans) {
    const key = span.name === "tool.call" ? String(span.attributes["tool.name"] ?? "?") : span.name === "llm.turn" ? String(span.attributes["llm.model"] ?? "?") : span.name;
    const group = byName.get(span.name) ?? [];
    const existing = group.find((g) => g.key === key);
    const isError = span.statusCode === 2 || span.attributes["tool.is_error"] === true || span.attributes.error === true;
    if (existing) {
      existing.count++;
      existing.totalMs += span.durationMs;
      if (isError) existing.errors++;
    } else {
      group.push({ key, count: 1, totalMs: span.durationMs, errors: isError ? 1 : 0 });
    }
    byName.set(span.name, group);
  }

  const lines: string[] = [`${spans.length} span(s) recorded.`];
  for (const [spanName, groups] of byName) {
    lines.push("", `${spanName}:`);
    groups.sort((a, b) => b.count - a.count);
    for (const g of groups) {
      const avgMs = Math.round(g.totalMs / g.count);
      const errorNote = g.errors > 0 ? `, ${g.errors} error(s)` : "";
      lines.push(`  ${g.key}: ${g.count} call(s), avg ${avgMs}ms${errorNote}`);
    }
  }
  return lines.join("\n");
}

interface ReadTracesInput {
  date?: string;
  raw?: boolean;
}

export const readTracesTool: ToolDefinition<ReadTracesInput> = {
  name: "read_traces",
  description:
    "Read this agent's own OpenTelemetry trace spans (tool calls and LLM turns, with durations/error status) " +
    "recorded so far today (or a given date), and report a summary: call counts, average duration, and error " +
    "counts per tool/model. Use this to check whether a particular tool or model call is slow or failing more " +
    "than expected. Pass raw:true to get the unsummarized JSONL instead.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      date: { type: "string", description: "Date to read traces for, YYYY-MM-DD (defaults to today)" },
      raw: { type: "boolean", description: "Return the raw JSONL spans instead of a summary" },
    },
  },
  describeCall: (input) => `read traces${input.date ? ` for ${input.date}` : ""}`,
  async handler(input) {
    const date = input.date ? new Date(input.date) : new Date();
    if (Number.isNaN(date.getTime())) return { content: `"${input.date}" is not a valid date (expected YYYY-MM-DD).`, isError: true };

    let raw: string;
    try {
      raw = await readFile(traceFilePath(date), "utf-8");
    } catch {
      return { content: "No trace file for that date — no spans have been recorded yet.", isError: false };
    }

    if (input.raw) return { content: raw, isError: false };
    return { content: summarize(parseLines(raw)), isError: false };
  },
};
