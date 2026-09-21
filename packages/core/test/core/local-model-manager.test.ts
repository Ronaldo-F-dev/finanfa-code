import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureLocalTextModelServer,
  stopManagedLocalModel,
  checkRunningModel,
  wasStartedByUs,
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
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const modelPath = path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
    await writeFile(modelPath, "not a real gguf, just needs to exist");

    const result = await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });

    expect(result).toEqual({ state: "started", modelId: "Ternary-Bonsai-1.7B-Q2_0_g64" });

    // A pidfile (keyed by port) should exist so a later call recognizes
    // this instance and stopManagedLocalModel can find it.
    expect(await wasStartedByUs(baseUrl)).toEqual({ modelName: "Ternary-Bonsai-1.7B-Q2_0_g64", pid: expect.any(Number) });
    expect(await stopManagedLocalModel(baseUrl)).toBe(true);
  }, 10_000);

  it("reports already-running-correct without spawning anything when the right model is already up", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const modelPath = path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
    await writeFile(modelPath, "placeholder");

    const first = await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });
    expect(first.state).toBe("started");

    const second = await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
    });
    expect(second).toEqual({ state: "already-running-correct", modelId: "Ternary-Bonsai-1.7B-Q2_0_g64" });

    await stopManagedLocalModel(baseUrl);
  }, 10_000);

  it("reports already-running-different-model instead of killing an unrelated server on the same port", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const wrongModelPath = path.join(modelsDir, "Ternary-Bonsai-4B-Q2_0_g64.gguf");
    await writeFile(wrongModelPath, "placeholder");

    const started = await ensureLocalTextModelServer({
      baseUrl,
      modelPath: wrongModelPath,
      modelName: "Ternary-Bonsai-4B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });
    expect(started.state).toBe("started");

    // Now ask for the 1.7B on that same port, WITHOUT restartIfDifferent —
    // the 4B is already there and this must not touch it.
    const result = await ensureLocalTextModelServer({
      baseUrl,
      modelPath: path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf"),
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
    });
    expect(result).toEqual({
      state: "already-running-different-model",
      runningModelId: "Ternary-Bonsai-4B-Q2_0_g64",
      expected: "Ternary-Bonsai-1.7B-Q2_0_g64",
    });

    await stopManagedLocalModel(baseUrl);
  }, 10_000);

  it("restartIfDifferent stops a mismatched server it started itself and loads the requested model instead", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const fourBPath = path.join(modelsDir, "Ternary-Bonsai-4B-Q2_0_g64.gguf");
    const oneSevenBPath = path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf");
    await writeFile(fourBPath, "placeholder");
    await writeFile(oneSevenBPath, "placeholder");

    const started = await ensureLocalTextModelServer({
      baseUrl,
      modelPath: fourBPath,
      modelName: "Ternary-Bonsai-4B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });
    expect(started.state).toBe("started");

    const switched = await ensureLocalTextModelServer({
      baseUrl,
      modelPath: oneSevenBPath,
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
      restartIfDifferent: true,
    });
    expect(switched).toEqual({
      state: "restarted",
      modelId: "Ternary-Bonsai-1.7B-Q2_0_g64",
      previousModelId: "Ternary-Bonsai-4B-Q2_0_g64",
    });

    await stopManagedLocalModel(baseUrl);
  }, 15_000);

  it("restartIfDifferent still refuses to touch a server it didn't start itself", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const wrongModelPath = path.join(modelsDir, "someone-elses-model.gguf");
    await writeFile(wrongModelPath, "placeholder");

    // Simulate "someone else started it" by starting the fake server
    // directly, bypassing ensureLocalTextModelServer entirely — no pidfile
    // gets written for this one.
    const { spawn } = await import("node:child_process");
    const child = spawn(FAKE_LLAMA_SERVER, ["-m", wrongModelPath, "--host", "127.0.0.1", "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // Wait for it to actually come up.
    for (let i = 0; i < 20 && !(await checkRunningModel(baseUrl)); i++) await new Promise((r) => setTimeout(r, 200));

    expect(await wasStartedByUs(baseUrl)).toBeUndefined();

    const result = await ensureLocalTextModelServer({
      baseUrl,
      modelPath: path.join(modelsDir, "Ternary-Bonsai-1.7B-Q2_0_g64.gguf"),
      modelName: "Ternary-Bonsai-1.7B-Q2_0_g64",
      binary: FAKE_LLAMA_SERVER,
      restartIfDifferent: true,
    });
    expect(result).toEqual({
      state: "already-running-different-model",
      runningModelId: "someone-elses-model",
      expected: "Ternary-Bonsai-1.7B-Q2_0_g64",
    });

    if (child.pid) process.kill(child.pid, "SIGTERM");
  }, 10_000);

  it("stopManagedLocalModel is a harmless no-op when nothing was ever started", async () => {
    expect(await stopManagedLocalModel("http://127.0.0.1:1/v1")).toBe(false);
  });

  it("writes a port-keyed pidfile under ~/.finanfa-code/local-models/ for a started server", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const modelPath = path.join(modelsDir, "some-model.gguf");
    await writeFile(modelPath, "placeholder");

    await ensureLocalTextModelServer({
      baseUrl,
      modelPath,
      modelName: "some-model",
      binary: FAKE_LLAMA_SERVER,
      startupTimeoutMs: 5000,
    });

    const pidFile = path.join(homeDir, ".finanfa-code", "local-models", `port-${port}.pid`);
    const record = JSON.parse(await readFile(pidFile, "utf-8"));
    expect(record.modelName).toBe("some-model");
    expect(Number.isInteger(record.pid)).toBe(true);
    expect(record.pid).toBeGreaterThan(0);

    await stopManagedLocalModel(baseUrl);
  }, 10_000);
});
