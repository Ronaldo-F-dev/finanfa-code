import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureLocalTextModelServer,
  stopManagedLocalModel,
  checkRunningModel,
} from "../../src/core/local-model-manager.js";

const FAKE_LLAMA_SERVER = fileURLToPath(new URL("../fixtures/fake-llama-server.mjs", import.meta.url));

// Ports unlikely to collide with a real llama-server/Ollama/etc a developer
// might actually have running while these tests execute.
let nextPort = 58080;
function freshPort(): number {
  return nextPort++;
}

describe("local-model-manager (real subprocess, fake llama-server binary stand-in)", () => {
  let homeDir: string;
  let modelsDir: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    await chmod(FAKE_LLAMA_SERVER, 0o755);
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-local-model-home-"));
    modelsDir = await mkdtemp(path.join(tmpdir(), "finanfa-local-model-files-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(modelsDir, { recursive: true, force: true });
  });

  it("checkRunningModel resolves undefined when nothing is listening", async () => {
    const modelId = await checkRunningModel(`http://127.0.0.1:${freshPort()}/v1`);
    expect(modelId).toBeUndefined();
  });

  it("reports missing-binary for a binary that doesn't exist", async () => {
    const port = freshPort();
    const result = await ensureLocalTextModelServer({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPath: path.join(modelsDir, "whatever.gguf"),
      modelName: "whatever",
      binary: "/definitely/not/a/real/binary/xyz",
    });
    expect(result).toEqual({ state: "missing-binary", binary: "/definitely/not/a/real/binary/xyz" });
  });

  it("reports missing-model-file when the binary exists but the .gguf path doesn't", async () => {
    const port = freshPort();
    const result = await ensureLocalTextModelServer({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPath: path.join(modelsDir, "does-not-exist.gguf"),
      modelName: "does-not-exist",
      binary: FAKE_LLAMA_SERVER,
    });
    expect(result).toEqual({
      state: "missing-model-file",
      path: path.join(modelsDir, "does-not-exist.gguf"),
    });
  });

  it("spawns the fake server and reports 'started' once it's really answering", async () => {
    const port = freshPort();
    const modelPath = path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
    await writeFile(modelPath, "not a real gguf, just needs to exist");

    const result = await ensureLocalTextModelServer({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPath,
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });

    expect(result).toEqual({ state: "started", modelId: "Ternary-Bonsai-1.7B-Q2_0_g64" });

    // A pidfile should exist so a later call recognizes this instance and
    // stopManagedLocalModel can find it.
    const stopped = await stopManagedLocalModel("Ternary-Bonsai-1.7B-Q2_0_g64");
    expect(stopped).toBe(true);
  }, 10_000);

  it("reports already-running-correct without spawning anything when the right model is already up", async () => {
    const port = freshPort();
    const modelPath = path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
    await writeFile(modelPath, "placeholder");

    // Start the fake server directly (simulating a server the user already
    // launched by hand), independent of ensureLocalTextModelServer.
    const first = await ensureLocalTextModelServer({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPath,
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });
    expect(first.state).toBe("started");

    const second = await ensureLocalTextModelServer({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPath,
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
    });
    expect(second).toEqual({ state: "already-running-correct", modelId: "Ternary-Bonsai-1.7B-Q2_0_g64" });

    await stopManagedLocalModel("Ternary-Bonsai-1.7B-Q2_0_g64");
  }, 10_000);

  it("reports already-running-different-model instead of killing an unrelated server on the same port", async () => {
    const port = freshPort();
    const wrongModelPath = path.join(modelsDir, "Ternary-Bonsai-4B-Q2_0_g64.gguf");
    await writeFile(wrongModelPath, "placeholder");

    const started = await ensureLocalTextModelServer({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPath: wrongModelPath,
      modelName: "Ternary-Bonsai-4B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });
    expect(started.state).toBe("started");

    // Now ask for the 1.7B on that same port — the 4B is already there.
    const result = await ensureLocalTextModelServer({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPath: path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf"),
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
    });
    expect(result).toEqual({
      state: "already-running-different-model",
      runningModelId: "Ternary-Bonsai-4B-Q2_0_g64",
      expected: "Ternary-Bonsai-1.7B-Q2_0_g64",
    });

    await stopManagedLocalModel("Ternary-Bonsai-4B-Q2_0_g64");
  }, 10_000);

  it("stopManagedLocalModel is a harmless no-op when nothing was ever started", async () => {
    expect(await stopManagedLocalModel("never-started-anything")).toBe(false);
  });

  it("writes a pidfile under ~/.finanfa-code/local-models/ for a started server", async () => {
    const port = freshPort();
    const modelPath = path.join(modelsDir, "some-model.gguf");
    await writeFile(modelPath, "placeholder");

    await ensureLocalTextModelServer({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPath,
      modelName: "some-model",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });

    const pidFile = path.join(homeDir, ".finanfa-code", "local-models", "some-model.pid");
    const pid = Number((await readFile(pidFile, "utf-8")).trim());
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);

    await stopManagedLocalModel("some-model");
  }, 10_000);
});
