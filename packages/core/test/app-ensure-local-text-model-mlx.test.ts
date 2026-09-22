import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfiguredLocalTextModel } from "../src/app.js";
import { ensureLocalTextModelServer, stopManagedLocalModel } from "../src/core/local-model-manager.js";

const FAKE_MLX_SERVER = fileURLToPath(new URL("fixtures/fake-mlx-server.mjs", import.meta.url));

let nextPort = 58380;
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

describe("local-model-manager MLX runtime (real subprocess, fake mlx_lm.server stand-in)", () => {
  let modelsDir: string;

  beforeAll(async () => {
    await chmod(FAKE_MLX_SERVER, 0o755);
  });

  beforeEach(async () => {
    modelsDir = await mkdtemp(path.join(tmpdir(), "finanfa-ensure-local-model-mlx-"));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    await rm(modelsDir, { recursive: true, force: true });
  });

  it("detects the MLX runtime from the binary name and starts it with --model (no -m/-c)", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    // An HF-repo-id-shaped modelPath — never a real file/dir on this machine.
    const modelPath = "mlx-community/LFM2.5-2.6B-OptiQ-4bit";

    const result = await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName: modelPath,
      binary: FAKE_MLX_SERVER,
    });

    // fake-mlx-server.mjs refuses to start (exits 2) if it sees -m/-c, so a
    // "started" result here (rather than a start-failed timeout) proves the
    // real args were the MLX-shaped ["--model", ..., "--host", ..., "--port", ...].
    expect(result).toEqual({ state: "started", modelId: modelPath });

    await stopManagedLocalModel(baseUrl);
  }, 10_000);

  it("does not reject an HF-repo-id-shaped modelPath as missing-model-file", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const modelPath = "mlx-community/LFM2.5-2.6B-OptiQ-4bit";

    const result = await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName: modelPath,
      binary: FAKE_MLX_SERVER,
    });

    expect(result.state).not.toBe("missing-model-file");
    expect(result.state).toBe("started");

    await stopManagedLocalModel(baseUrl);
  }, 10_000);

  it("still reports missing-model-file for a path-shaped MLX modelPath that doesn't exist", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const modelPath = path.join(modelsDir, "does-not-exist-mlx-model-dir");

    const result = await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName: "does-not-exist-mlx-model-dir",
      binary: FAKE_MLX_SERVER,
    });

    expect(result).toEqual({ state: "missing-model-file", path: modelPath });
  });

  it("wires the MLX runtime through ensureConfiguredLocalTextModel (app.ts) end to end", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const modelPath = "mlx-community/LFM2.5-2.6B-OptiQ-4bit";
    const ui = fakeUi();

    await ensureConfiguredLocalTextModel(
      {
        provider: "openai-compatible",
        baseUrl,
        model: modelPath,
        textModelPath: modelPath,
        textModelBinary: FAKE_MLX_SERVER,
      },
      ui,
    );

    expect(ui.errors).toEqual([]);
    expect(ui.system.some((s) => s.includes(modelPath))).toBe(true);

    await stopManagedLocalModel(baseUrl);
  }, 10_000);
});
