import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initTracing, shutdownTracing, withSpan } from "../../src/observability/tracing.js";
import { traceFilePath } from "../../src/observability/jsonl-exporter.js";
import { readTracesTool } from "../../src/tools/builtin/read-traces.js";

describe("OpenTelemetry tracing (real spans, real JSONL file on disk)", () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-tracing-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    await initTracing();
  });

  afterEach(async () => {
    await shutdownTracing();
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("withSpan records a real span with the given attributes to the JSONL trace file", async () => {
    const result = await withSpan("tool.call", { "tool.name": "bash", "tool.risk_level": "dangerous" }, async (span) => {
      span.setAttribute("tool.is_error", false);
      return 42;
    });
    expect(result).toBe(42);

    const raw = await readFile(traceFilePath(), "utf-8");
    const spans = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("tool.call");
    expect(spans[0].attributes["tool.name"]).toBe("bash");
    expect(spans[0].attributes["tool.risk_level"]).toBe("dangerous");
    expect(spans[0].attributes["tool.is_error"]).toBe(false);
    expect(spans[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records an error attribute and rethrows when the wrapped function throws", async () => {
    await expect(
      withSpan("tool.call", { "tool.name": "broken_tool" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const raw = await readFile(traceFilePath(), "utf-8");
    const spans = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(spans[0].attributes.error).toBe(true);
  });

  it("read_traces tool summarizes real recorded spans by tool name, with call counts and error counts", async () => {
    await withSpan("tool.call", { "tool.name": "bash", "tool.risk_level": "dangerous" }, async (span) => {
      span.setAttribute("tool.is_error", false);
    });
    await withSpan("tool.call", { "tool.name": "bash", "tool.risk_level": "dangerous" }, async (span) => {
      span.setAttribute("tool.is_error", true);
    });
    await withSpan("llm.turn", { "llm.model": "test-model" }, async (span) => {
      span.setAttribute("llm.input_tokens", 100);
      span.setAttribute("llm.output_tokens", 50);
      span.setAttribute("llm.stop_reason", "end_turn");
    });

    const result = await readTracesTool.handler({}, { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("tool.call:");
    expect(result.content).toContain("bash: 2 call(s)");
    expect(result.content).toContain("1 error(s)");
    expect(result.content).toContain("llm.turn:");
    expect(result.content).toContain("test-model: 1 call(s)");
  });

  it("read_traces reports no trace file for a date nothing was recorded on", async () => {
    const result = await readTracesTool.handler({ date: "2001-01-01" }, { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal });
    expect(result.content).toContain("No trace file for that date");
  });

  it("read_traces with raw:true returns the unsummarized JSONL", async () => {
    await withSpan("tool.call", { "tool.name": "grep" }, async () => {});
    const result = await readTracesTool.handler({ raw: true }, { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal });
    const lines = result.content.trim().split("\n");
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it("read_traces rejects an invalid date", async () => {
    const result = await readTracesTool.handler({ date: "not-a-date" }, { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal });
    expect(result.isError).toBe(true);
  });

  it("has 'safe' risk level (read-only)", () => {
    expect(readTracesTool.riskLevel).toBe("safe");
  });
});
