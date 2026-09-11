import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionRunner } from "../../src/engine/session-runner.js";
import type { UIAdapter } from "@finanfa/core/src/ui/adapter.js";

// Real end-to-end test of the engine wiring the VS Code extension will
// drive (step 2 of the plan — see ~/.claude/plans/concurrent-foraging-sprout.md):
// createSessionRunner() must produce a working session against a real
// project directory and a real local HTTP server speaking the
// OpenAI-compatible SSE protocol, with no VS Code process involved at all —
// this is exactly what makes it independently testable before any webview
// exists.
function makeStubUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

const ENV_KEYS_TO_CLEAR = ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_API_KEY", "FINANFA_API_KEYS", "ANTHROPIC_API_KEY"] as const;

describe("createSessionRunner (real local SSE server, no VS Code involved)", () => {
  let server: http.Server;
  let baseUrl: string;
  let receivedRequests: string[] = [];
  let projectDir: string;
  let homeDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedRequests.push(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          JSON.stringify({ choices: [{ delta: { content: "Hello from the fake model." } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
        ];
        for (const e of events) res.write(`data: ${e}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-vscode-session-runner-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-vscode-session-runner-home-"));
    process.env.HOME = homeDir;
    // This real dev shell exports FINANFA_* for manual testing against a
    // real inference endpoint (see cli-prompt-mode.test.ts) — cleared here
    // for the same reason, so this test hits the fake local server, not a
    // real paid one.
    originalEnv = Object.fromEntries(ENV_KEYS_TO_CLEAR.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS_TO_CLEAR) delete process.env[k];
    receivedRequests = [];

    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "config.json"),
      JSON.stringify({ provider: "openai-compatible", baseUrl, model: "fake-model", apiKey: "test-key" }),
    );
  });

  afterEach(async () => {
    for (const k of ENV_KEYS_TO_CLEAR) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it(
    "wires a real session against a real project config and completes a real turn against the fake server",
    async () => {
      const ui = makeStubUi();
      const runner = await createSessionRunner(projectDir, ui);

      expect(runner.session.model).toBe("fake-model");
      expect(runner.providerKind).toBe("openai-compatible");
      expect(runner.tools.list().length).toBeGreaterThan(50);

      await runner.sendMessage("say hi");

      expect(receivedRequests.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(receivedRequests[0]!).messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "user", content: "say hi" })]),
      );
      expect(runner.session.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "say hi" }),
          expect.objectContaining({ role: "assistant", content: "Hello from the fake model." }),
        ]),
      );

      await runner.dispose();
    },
    20_000,
  );

  it(
    "resumes an existing session by id instead of starting a fresh one",
    async () => {
      const ui = makeStubUi();
      const first = await createSessionRunner(projectDir, ui);
      await first.sendMessage("first turn");
      await first.dispose();
      const sessionId = first.session.id;

      const resumed = await createSessionRunner(projectDir, ui, { resumeSessionId: sessionId });
      expect(resumed.session.id).toBe(sessionId);
      expect(resumed.session.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "user", content: "first turn" })]),
      );
      await resumed.dispose();
    },
    20_000,
  );

  it("falls back to a fresh session and warns when asked to resume an unknown id", async () => {
    const ui = makeStubUi();
    const runner = await createSessionRunner(projectDir, ui, { resumeSessionId: "does-not-exist" });
    // ENOENT (never-persisted/unknown id) is an expected, harmless fallback
    // — a quiet system note, not a red error (see session-runner.ts).
    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("does-not-exist"));
    expect(ui.writeError).not.toHaveBeenCalled();
    expect(runner.session.id).not.toBe("does-not-exist");
    await runner.dispose();
  });
});
