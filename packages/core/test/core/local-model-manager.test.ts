import { describe, expect, it, beforeAll } from "vitest";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureLocalService, withLocalService, stopLocalService, checkRunningModel, type LocalServiceConfig } from "../../src/core/local-model-manager.js";

// A real, standalone process standing in for whatever the user actually
// configured (llama-server, mlx_lm.server, or anything else) — this module
// no longer knows or cares what it's launching, only that --port serves an
// OpenAI-compatible /models once ready. Reused as-is: it already takes
// --port and serves /models without requiring -m at all.
const FAKE_SERVICE = fileURLToPath(new URL("../fixtures/fake-llama-server.mjs", import.meta.url));

let nextPort = 58280;
function freshPort(): number {
  return nextPort++;
}

function serviceFor(port: number): LocalServiceConfig {
  return { command: FAKE_SERVICE, args: ["--port", String(port)], readyTimeoutMs: 5000 };
}

describe("local-model-manager (generic supervisor, real subprocess fake service)", () => {
  beforeAll(async () => {
    await chmod(FAKE_SERVICE, 0o755);
  });

  it("checkRunningModel resolves undefined when nothing is listening", async () => {
    expect(await checkRunningModel(`http://127.0.0.1:${freshPort()}/v1`)).toBeUndefined();
  });

  it("starts the service when nothing is answering yet, and reports 'started'", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const service = serviceFor(port);
    const result = await ensureLocalService({ baseUrl }, service);
    expect(result).toEqual({ state: "started" });
    expect(await checkRunningModel(baseUrl)).toBeTruthy();
    await stopLocalService({ baseUrl }, service);
  }, 10_000);

  it("is a no-op (no spawn) when something is already answering there", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const service = serviceFor(port);
    const first = await ensureLocalService({ baseUrl }, service);
    expect(first).toEqual({ state: "started" });

    const second = await ensureLocalService({ baseUrl }, service);
    expect(second).toEqual({ state: "already-running" });
    await stopLocalService({ baseUrl }, service);
  }, 10_000);

  it("two concurrent callers for the same service only spawn once", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const service = serviceFor(port);

    const [a, b] = await Promise.all([ensureLocalService({ baseUrl }, service), ensureLocalService({ baseUrl }, service)]);
    // Both calls share the same in-flight startup promise, so both resolve
    // to the exact same result from the single real spawn — a second real
    // spawn racing the first would instead fail to bind the port.
    expect(a).toEqual({ state: "started" });
    expect(b).toEqual({ state: "started" });
    expect(await checkRunningModel(baseUrl)).toBeTruthy();
    await stopLocalService({ baseUrl }, service);
  }, 10_000);

  it("reports start-failed when the health check never comes up", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const result = await ensureLocalService(
      { baseUrl },
      { command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], readyTimeoutMs: 300 },
    );
    expect(result.state).toBe("start-failed");
  }, 5000);

  it("reports start-failed at once, without crashing the host, when the command doesn't exist", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const started = Date.now();
    const result = await ensureLocalService({ baseUrl }, { command: "/nonexistent/mlx_lm.server", args: ["--port", String(port)], readyTimeoutMs: 20_000 });
    expect(result.state).toBe("start-failed");
    expect(result).toMatchObject({ message: expect.stringContaining("could not start /nonexistent/mlx_lm.server") });
    expect(Date.now() - started).toBeLessThan(5000); // it did not sit out the 20s ready timeout
    // ...and nothing is left registered, so a later attempt (after the user installs it) starts clean.
    expect((await ensureLocalService({ baseUrl }, { command: "/nonexistent/mlx_lm.server", readyTimeoutMs: 20_000 })).state).toBe("start-failed");
  }, 15_000);

  it("idle-stop actually stops the process after the configured delay", async () => {
    const port = freshPort();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const service: LocalServiceConfig = { ...serviceFor(port), idleStopMs: 300 };

    await withLocalService({ baseUrl }, service, async () => {
      expect(await checkRunningModel(baseUrl)).toBeTruthy();
    });

    // Right after release it should still be up (idle timer just started).
    expect(await checkRunningModel(baseUrl)).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await checkRunningModel(baseUrl)).toBeUndefined();
  }, 10_000);
});
