import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";

// A real OpenTelemetry SpanExporter (implements the standard interface —
// this project's tracing setup can add a real OTLP exporter alongside
// this one, see tracing.ts) that writes each span as one JSON line to a
// local file, so tracing is genuinely useful out of the box with zero
// external collector required. One file per calendar day, append-only.
function tracesDir(): string {
  return path.join(os.homedir(), ".finanfa-code", "traces");
}

export function traceFilePath(date = new Date()): string {
  const iso = date.toISOString().slice(0, 10);
  return path.join(tracesDir(), `${iso}.jsonl`);
}

interface SerializedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  statusCode: number;
  statusMessage?: string;
}

function serialize(span: ReadableSpan): SerializedSpan {
  const ctx = span.spanContext();
  return {
    name: span.name,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    startTimeMs: hrTimeToMilliseconds(span.startTime),
    endTimeMs: hrTimeToMilliseconds(span.endTime),
    durationMs: hrTimeToMilliseconds(span.duration),
    attributes: { ...span.attributes },
    statusCode: span.status.code,
    statusMessage: span.status.message,
  };
}

export class JsonlFileSpanExporter implements SpanExporter {
  // Synchronous I/O, deliberately: SimpleSpanProcessor's onEnd() calls
  // export() and moves on without awaiting resultCallback, so an async
  // write here would be a real race against whatever runs right after the
  // span ends (a test asserting on the file, or process exit) — trace
  // writes are small, infrequent appends, not a hot path, so the
  // sync-I/O cost is negligible and it removes that whole class of bug.
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      mkdirSync(tracesDir(), { recursive: true });
      const lines = spans.map((s) => JSON.stringify(serialize(s))).join("\n") + "\n";
      appendFileSync(traceFilePath(), lines, "utf-8");
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      // A tracing failure must never surface as a real error to the rest
      // of the app — same defensive convention as session.ts's persist()
      // warning-and-continuing on a disk-full/permission error.
      console.error(`Warning: failed to write trace spans: ${err instanceof Error ? err.message : String(err)}`);
      resultCallback({ code: ExportResultCode.FAILED });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
