import { trace, type Tracer, type Span } from "@opentelemetry/api";
import { NodeTracerProvider, SimpleSpanProcessor, BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { JsonlFileSpanExporter } from "./jsonl-exporter.js";

// Real OpenTelemetry tracing (standard @opentelemetry/api spans, not a
// home-grown log format) for tool calls and LLM turns — closing the
// "no observability" gap this project had relative to agent-framework's
// OpenTelemetry integration and deer-flow's Langfuse/LangSmith tracing.
//
// Always writes spans to a local JSONL file (JsonlFileSpanExporter) so
// tracing is useful with zero setup — no collector required. If the
// standard OTEL_EXPORTER_OTLP_ENDPOINT (or _TRACES_ENDPOINT) env var is
// set, ALSO exports real OTLP/HTTP to that collector (Jaeger, Honeycomb,
// any OTLP-compatible backend) via the real, standard
// @opentelemetry/exporter-trace-otlp-http exporter — this project adds no
// custom endpoint-configuration surface of its own, just honors the
// standard OTel env vars every other OTel SDK already does.
//
// Disclosed scope reduction: spans are flat (tool-call and llm-turn spans
// are siblings, not nested under a per-conversation-turn parent span) —
// wiring real parent/child context propagation through the tool registry
// would need a bigger plumbing change (ToolContext doesn't carry an
// active OTel context today) for a mostly-cosmetic improvement (this
// still gives real per-tool/per-model durations and error rates); revisit
// if trace-viewer-style waterfall visualization is wanted later.
let provider: NodeTracerProvider | undefined;

export async function initTracing(): Promise<void> {
  if (provider) return; // idempotent — cli.ts/web-server each call this once at startup, tests may call it more than once

  const spanProcessors: SpanProcessor[] = [new SimpleSpanProcessor(new JsonlFileSpanExporter())];

  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    // Deferred import so the (optional-in-practice) OTLP HTTP dependency
    // and its network setup are only touched when actually configured.
    try {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
    } catch (err) {
      console.error(`Warning: OTEL_EXPORTER_OTLP_ENDPOINT is set but the OTLP exporter failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "finanfa-code" }),
    spanProcessors,
  });
  provider.register();
}

// Prefers the locally-held provider over the global @opentelemetry/api
// registry: OTel's global tracer provider can only be REGISTERED once per
// process (a later provider.register() call is silently ignored) — fine
// for a real run (initTracing() is only ever called once at startup), but
// it means trace.getTracer() alone would keep routing to a stale, already-
// shut-down provider across more than one init/shutdown cycle in the same
// process (exactly what this file's own tests do). Falls back to the
// global tracer (a real no-op tracer if nothing was ever registered) when
// tracing was never initialized, so every withSpan call site works
// unconditionally whether or not initTracing() ran.
export function getTracer(): Tracer {
  return provider ? provider.getTracer("finanfa-code") : trace.getTracer("finanfa-code");
}

export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown().catch(() => {});
  provider = undefined;
}

/** Runs `fn` inside a span named `name`, recording `attributes`, ending the span, and recording any thrown error onto it before rethrowing — the pattern every call site below uses so error/duration recording can't accidentally be forgotten at one of them. */
export async function withSpan<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = getTracer().startSpan(name, { attributes });
  try {
    return await fn(span);
  } catch (err) {
    span.recordException(err instanceof Error ? err : String(err));
    span.setAttribute("error", true);
    throw err;
  } finally {
    span.end();
  }
}
