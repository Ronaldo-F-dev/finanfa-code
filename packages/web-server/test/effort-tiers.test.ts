import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { isOllamaAvailable, listOllamaModels } from "@finanfa/core/src/core/ollama-models.js";
import { MINIMAL_TOOL_SET } from "@finanfa/core/src/core/effort-tiers.js";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of "set_effort": picking a tier should switch to
// the right real local model, cap max_tokens, and enforce the tier's tool
// budget — all in one message, against the real Ollama instance actually
// running in this environment. Skips whichever assertions need a specific
// model this environment doesn't have installed, same convention as every
// other real-CLI test in this suite.
interface WsEvent {
  type: string;
  [key: string]: unknown;
}

function waitFor(events: WsEvent[], predicate: (e: WsEvent) => boolean, timeoutMs = 15_000): Promise<WsEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for event: ${JSON.stringify(events)}`));
      setTimeout(check, 50);
    };
    check();
  });
}

async function connect(port: number): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  const events: WsEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as WsEvent));
  await waitFor(events, (e) => e.type === "session_info");
  return { ws, events };
}

describe("web-server set_effort (real subprocess, real Ollama server when present)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let ollamaAvailable = false;
  let installedNames = new Set<string>();

  beforeAll(async () => {
    ollamaAvailable = await isOllamaAvailable();
    if (ollamaAvailable) installedNames = new Set((await listOllamaModels()).map((m) => m.name));

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-effort-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-effort-home-"));
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    // No default provider configured — this test only exercises the local
    // (Ollama) tiers, which never touch the default-provider path.
    await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify({}));

    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "low tier: switches to the real local model with no tools, and a real turn succeeds even though the model has no tool-calling support",
    async () => {
      if (!ollamaAvailable || !installedNames.has("gemma2:2b")) return;
      const { ws, events } = await connect(port);

      ws.send(JSON.stringify({ type: "set_effort", level: "low" }));
      const info = await waitFor(events, (e) => e.type === "session_info" && e.effort === "low");
      expect(info.model).toBe("gemma2:2b");

      const status = await waitFor(events, (e) => e.type === "tools_status");
      const enabled = (status.tools as { name: string; enabled: boolean }[]).filter((t) => t.enabled);
      expect(enabled).toHaveLength(0); // toolBudget "none"

      // The real, reported crash: gemma2:2b doesn't support tool calling at
      // all — sending it a tool list failed outright. With every tool
      // disabled, this turn must actually succeed. Real measured latency
      // for this project's ~14k-char system prompt on this environment's
      // CPU-only small-model inference: on the order of a minute or more
      // (prompt-processing-bound, not generation-bound — see the
      // max_tokens cap's own comment), hence the generous timeout rather
      // than the usual few seconds.
      ws.send(JSON.stringify({ type: "user_message", text: "Reply with just the word OK." }));
      const end = await waitFor(events, (e) => e.type === "assistant_end", 240_000);
      expect(end).toBeTruthy();
      const failed = events.some((e) => e.type === "system" && typeof e.text === "string" && e.text.includes("the model call failed"));
      expect(failed).toBe(false);

      ws.close();
    },
    250_000,
  );

  it(
    "medium tier: switches model and restricts tools to the minimal set",
    async () => {
      if (!ollamaAvailable || !installedNames.has("qwen3:4b-instruct")) return;
      const { ws, events } = await connect(port);

      ws.send(JSON.stringify({ type: "set_effort", level: "medium" }));
      const info = await waitFor(events, (e) => e.type === "session_info" && e.effort === "medium");
      expect(info.model).toBe("qwen3:4b-instruct");

      const status = await waitFor(events, (e) => e.type === "tools_status");
      const enabledNames = (status.tools as { name: string; enabled: boolean }[]).filter((t) => t.enabled).map((t) => t.name);
      expect(new Set(enabledNames)).toEqual(new Set(MINIMAL_TOOL_SET));

      ws.close();
    },
    20_000,
  );

  it(
    "legal tier: switches to SaulLM with no tools (no tool-calling support, same as gemma2:2b/yi-coder)",
    async () => {
      if (!ollamaAvailable || !installedNames.has("hf.co/MaziyarPanahi/Saul-Instruct-v1-GGUF:Q4_K_M")) return;
      const { ws, events } = await connect(port);

      ws.send(JSON.stringify({ type: "set_effort", level: "legal" }));
      const info = await waitFor(events, (e) => e.type === "session_info" && e.effort === "legal");
      expect(info.model).toBe("hf.co/MaziyarPanahi/Saul-Instruct-v1-GGUF:Q4_K_M");

      const status = await waitFor(events, (e) => e.type === "tools_status");
      const enabled = (status.tools as { name: string; enabled: boolean }[]).filter((t) => t.enabled);
      expect(enabled).toHaveLength(0);

      ws.close();
    },
    20_000,
  );

  it(
    "picking a tool-capable local model directly via set_model (not an effort tier) auto-restricts tools to the minimal set",
    async () => {
      if (!ollamaAvailable || !installedNames.has("qwen3:4b-instruct")) return;
      const { ws, events } = await connect(port);

      // Real, reported crash: picking qwen3:4b-instruct directly through
      // the plain model picker (bypassing Effort tiers) left every tool
      // enabled, and its default 4096-token context couldn't hold this
      // project's ~40k-token system-prompt-plus-full-tool-list — the exact
      // "context size exceeded" error reported. Picking it directly must
      // now auto-apply the same protective minimal tool budget the tiers
      // use, derived from Ollama's own real capabilities.
      ws.send(JSON.stringify({ type: "set_model", model: "qwen3:4b-instruct", family: "openai-compatible", baseUrl: "http://localhost:11434/v1" }));
      const info = await waitFor(events, (e) => e.type === "session_info" && e.model === "qwen3:4b-instruct");
      expect(info.effort).toBeUndefined();
      const status = await waitFor(events, (e) => e.type === "tools_status" && e.tools !== undefined);
      const enabledNames = (status.tools as { name: string; enabled: boolean }[]).filter((t) => t.enabled).map((t) => t.name);
      expect(new Set(enabledNames)).toEqual(new Set(MINIMAL_TOOL_SET));

      ws.close();
    },
    20_000,
  );

  it(
    "picking a local model with no tool-calling support directly via set_model auto-disables every tool",
    async () => {
      if (!ollamaAvailable || !installedNames.has("gemma2:2b")) return;
      const { ws, events } = await connect(port);

      // Real, reported crash: picking gemma2:2b directly failed outright
      // with "does not support tools" — it has no tool-calling capability
      // at all (confirmed via Ollama's own /api/tags capabilities field),
      // a hard incompatibility no context-size tuning fixes. Picking it
      // directly must now auto-disable every tool, the only thing that
      // actually makes this model usable through this agent.
      ws.send(JSON.stringify({ type: "set_model", model: "gemma2:2b", family: "openai-compatible", baseUrl: "http://localhost:11434/v1" }));
      await waitFor(events, (e) => e.type === "session_info" && e.model === "gemma2:2b");
      const status = await waitFor(events, (e) => e.type === "tools_status" && e.tools !== undefined);
      expect((status.tools as { enabled: boolean }[]).some((t) => t.enabled)).toBe(false);

      ws.close();
    },
    20_000,
  );

  // The "switch away from a local model back to the project's default
  // remote provider clears the tier's stale tool restriction" case (the
  // `hadEffort` branch in set_model) is covered in switch-model-provider
  // .test.ts, which has a real configured default provider to switch to —
  // this describe block's fixture deliberately has none (see beforeAll).

  it("high tier: reports model_unavailable cleanly when no default provider is configured, instead of crashing", async () => {
    const { ws, events } = await connect(port);
    ws.send(JSON.stringify({ type: "set_effort", level: "high" }));
    const unavailable = await waitFor(events, (e) => e.type === "model_unavailable");
    expect(typeof unavailable.message).toBe("string");
    ws.close();
  });

  it("rejects an unknown effort level with an error event, not a crash", async () => {
    const { ws, events } = await connect(port);
    ws.send(JSON.stringify({ type: "set_effort", level: "ultra-mega" }));
    const err = await waitFor(events, (e) => e.type === "error");
    expect(String(err.text)).toContain("ultra-mega");
    ws.close();
  });
});
