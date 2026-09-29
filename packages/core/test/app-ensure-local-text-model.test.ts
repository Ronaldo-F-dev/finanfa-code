import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureConfiguredLocalTextModel, ensureLocalTextModelForSwitch } from "../src/app.js";
import { stopLocalService, type LocalServiceConfig } from "../src/core/local-model-manager.js";

// A real, standalone process standing in for whatever the user actually
// configured — generic and runtime-agnostic, same fixture used by
// core/local-model-manager.test.ts.
const FAKE_SERVICE = fileURLToPath(new URL("fixtures/fake-llama-server.mjs", import.meta.url));

let nextPort = 58380;
function freshPort(): number {
  return nextPort++;
}

function serviceFor(port: number): LocalServiceConfig {
  return { command: FAKE_SERVICE, args: ["--port", String(port)], readyTimeoutMs: 5000 };
}

function fakeUi() {
  const system: string[] = [];
  const errors: string[] = [];
  return {
    writeSystem: (s: string) => system.push(s),
    writeError: (s: string) => errors.push(s),
    system,
    errors,
  };
}

const ENV_KEYS = ["TEXT_MODEL_PROVIDER", "TEXT_MODEL_BASE_URL", "TEXT_MODEL_NAME", "FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL"] as const;

describe("ensureConfiguredLocalTextModel / ensureLocalTextModelForSwitch (generic localService, real subprocess fake service)", () => {
  beforeAll(async () => {
    await chmod(FAKE_SERVICE, 0o755);
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("is a no-op (nothing spawned, no message) when the provider isn't local", async () => {
    const ui = fakeUi();
    await ensureConfiguredLocalTextModel({ provider: "anthropic" }, ui);
    expect(ui.system).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

  it("is a genuine no-op (no probe, no message) when local but no localService is configured", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const ui = fakeUi();

    // Nothing is listening on this port at all — if this made any probe
    // request, it still wouldn't throw, but the point of this test is that
    // it makes zero attempt (no message either way).
    await ensureConfiguredLocalTextModel({ provider: "openai-compatible", baseUrl, model: "whatever" }, ui);
    expect(ui.system).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

  it("starts the configured localService and reports it", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const service = serviceFor(port);
    const ui = fakeUi();

    await ensureConfiguredLocalTextModel({ provider: "openai-compatible", baseUrl, model: "some-model", localService: service }, ui);

    expect(ui.system.some((s) => s.includes("Started the local service for some-model"))).toBe(true);
    expect(ui.errors).toEqual([]);
    await stopLocalService({ baseUrl }, service);
  }, 10_000);

  it("ensureLocalTextModelForSwitch is a no-op (handled: false, ok: true) when the newly-picked model isn't in localServices", async () => {
    const ui = fakeUi();
    const result = await ensureLocalTextModelForSwitch({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" }, "claude-opus-5", ui);
    expect(result).toEqual({ handled: false, ok: true });
    expect(ui.system).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

  it("ensureLocalTextModelForSwitch starts the newly-picked model's service and reports success", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const service = serviceFor(port);
    const ui = fakeUi();

    const config = {
      provider: "openai-compatible" as const,
      baseUrl,
      model: "model-a",
      localServices: { "model-b": service },
    };

    const result = await ensureLocalTextModelForSwitch(config, "model-b", ui);
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.status?.state).toBe("started");
    expect(ui.system.some((s) => s.includes("Started the local service for model-b"))).toBe(true);
    await stopLocalService({ baseUrl }, service);
  }, 10_000);

  it("ensureLocalTextModelForSwitch reports ok: false when the service fails to start", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const ui = fakeUi();

    const config = {
      provider: "openai-compatible" as const,
      baseUrl,
      model: "model-a",
      localServices: {
        "model-b": { command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], readyTimeoutMs: 300 },
      },
    };

    const result = await ensureLocalTextModelForSwitch(config, "model-b", ui);
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.status?.state).toBe("start-failed");
    expect(ui.errors.some((e) => e.includes("Failed to start the local service"))).toBe(true);
  }, 5000);
});
