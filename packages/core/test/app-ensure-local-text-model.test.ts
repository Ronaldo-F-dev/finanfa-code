import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfiguredLocalTextModel, ensureLocalTextModelForSwitch } from "../src/app.js";
import { stopManagedLocalModel } from "../src/core/local-model-manager.js";

const FAKE_LLAMA_SERVER = fileURLToPath(new URL("fixtures/fake-llama-server.mjs", import.meta.url));

let nextPort = 58180;
function freshPort(): number {
  return nextPort++;
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

const ENV_KEYS = [
  "TEXT_MODEL_PROVIDER",
  "TEXT_MODEL_BASE_URL",
  "TEXT_MODEL_NAME",
  "TEXT_MODEL_PATH",
  "TEXT_MODEL_BINARY",
  "FINANFA_PROVIDER",
  "FINANFA_BASE_URL",
  "FINANFA_MODEL",
] as const;

describe("ensureConfiguredLocalTextModel / ensureLocalTextModelForSwitch (real subprocess, fake llama-server stand-in)", () => {
  let modelsDir: string;

  beforeAll(async () => {
    await chmod(FAKE_LLAMA_SERVER, 0o755);
  });

  beforeEach(async () => {
    modelsDir = await mkdtemp(path.join(tmpdir(), "finanfa-ensure-local-model-"));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    await rm(modelsDir, { recursive: true, force: true });
  });

  it("is a no-op (nothing spawned, no message) when the provider isn't local", async () => {
    const ui = fakeUi();
    await ensureConfiguredLocalTextModel({ provider: "anthropic", textModelPath: "/whatever.gguf" }, ui);
    expect(ui.system).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

  it("is a no-op when local but textModelPath isn't set", async () => {
    const port = freshPort();
    const ui = fakeUi();
    await ensureConfiguredLocalTextModel(
      { provider: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "whatever" },
      ui,
    );
    expect(ui.system).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

  it("starts the configured local model and reports it", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const modelPath = path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
    await writeFile(modelPath, "placeholder");
    const ui = fakeUi();

    await ensureConfiguredLocalTextModel(
      {
        provider: "openai-compatible",
        baseUrl,
        model: "Ternary-Bonsai-1.7B-Q2_0_g64",
        textModelPath: modelPath,
        textModelBinary: FAKE_LLAMA_SERVER,
      },
      ui,
    );

    expect(ui.system.some((s) => s.includes("Started llama-server"))).toBe(true);
    expect(ui.errors).toEqual([]);
    await stopManagedLocalModel(baseUrl);
  }, 10_000);

  it("prints a real `hf download` command when the file is missing and textModelHfRepo/textModelHfFile are configured", async () => {
    const port = freshPort();
    const ui = fakeUi();

    await ensureConfiguredLocalTextModel(
      {
        provider: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "Ternary-Bonsai-1.7B-Q2_0_g64",
        textModelPath: path.join(modelsDir, "missing.gguf"),
        textModelBinary: FAKE_LLAMA_SERVER,
        textModelHfRepo: "prism-ml/Ternary-Bonsai-1.7B-gguf",
        textModelHfFile: "Ternary-Bonsai-1.7B-Q2_0_g64.gguf",
      },
      ui,
    );

    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0]).toContain("hf download prism-ml/Ternary-Bonsai-1.7B-gguf Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
  });

  it("ensureLocalTextModelForSwitch is a no-op (handled: false, ok: true) when the newly-picked model isn't in localTextModelPaths", async () => {
    const ui = fakeUi();
    const result = await ensureLocalTextModelForSwitch(
      { provider: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" },
      "claude-opus-5",
      ui,
    );
    expect(result).toEqual({ handled: false, ok: true });
    expect(ui.system).toEqual([]);
    expect(ui.errors).toEqual([]);
  });

  it("ensureLocalTextModelForSwitch restarts the local server with the newly-picked model", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const fourB = path.join(modelsDir, "Ternary-Bonsai-4B-Q2_0_g64.gguf");
    const oneSevenB = path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
    await writeFile(fourB, "placeholder");
    await writeFile(oneSevenB, "placeholder");
    const ui = fakeUi();

    const config = {
      provider: "openai-compatible" as const,
      baseUrl,
      model: "Ternary-Bonsai-4B-Q2_0_g64",
      textModelBinary: FAKE_LLAMA_SERVER,
      localTextModelPaths: {
        "Ternary-Bonsai-4B-Q2_0_g64": fourB,
        "Ternary-Bonsai-1.7B-Q2_0_g64": oneSevenB,
      },
    };

    // Load the 4B first (simulating whatever was already configured/started).
    await ensureConfiguredLocalTextModel({ ...config, textModelPath: fourB }, ui);
    expect(ui.system.some((s) => s.includes("Started"))).toBe(true);

    // Now switch to the 1.7B.
    const result = await ensureLocalTextModelForSwitch(config, "Ternary-Bonsai-1.7B-Q2_0_g64", ui);
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.status?.state).toBe("restarted");
    expect(ui.system.some((s) => s.includes("Switched the local model server"))).toBe(true);

    await stopManagedLocalModel(baseUrl);
  }, 15_000);

  it("ensureLocalTextModelForSwitch reports ok: false when a different local model is already running and refuses to be killed", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const fourB = path.join(modelsDir, "Ternary-Bonsai-4B-Q2_0_g64.gguf");
    const oneSevenB = path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
    await writeFile(fourB, "placeholder");
    await writeFile(oneSevenB, "placeholder");
    const ui = fakeUi();

    const config = {
      provider: "openai-compatible" as const,
      baseUrl,
      model: "Ternary-Bonsai-4B-Q2_0_g64",
      textModelBinary: FAKE_LLAMA_SERVER,
      localTextModelPaths: {
        "Ternary-Bonsai-4B-Q2_0_g64": fourB,
        "Ternary-Bonsai-1.7B-Q2_0_g64": oneSevenB,
      },
    };

    // Start the 4B directly (NOT through ensureConfiguredLocalTextModel/
    // ensureLocalTextModelForSwitch), simulating a server this project never
    // started itself and therefore refuses to kill.
    const { spawn } = await import("node:child_process");
    const child = spawn(FAKE_LLAMA_SERVER, ["-m", fourB, "--port", String(port)], { stdio: "ignore" });
    try {
      // Give the fake server a moment to start listening.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const result = await ensureLocalTextModelForSwitch(config, "Ternary-Bonsai-1.7B-Q2_0_g64", ui);
      expect(result.handled).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.status?.state).toBe("already-running-different-model");
      expect(ui.errors.some((e) => e.includes("stop that server yourself"))).toBe(true);
    } finally {
      child.kill();
    }
  }, 15_000);
});
