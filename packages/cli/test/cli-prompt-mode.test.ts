import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/cli.js";

// Real end-to-end test of the --prompt/--cwd single-shot mode
// (schedule_task's payload path): a real local HTTP server plays the
// OpenAI-compatible chat-completions SSE protocol OpenAiCompatibleProvider
// actually speaks (confirmed against openai-compatible-provider-stream.
// test.ts's own fake events), and main() is invoked in-process (no
// subprocess needed — it never calls process.exit() on a normal exit,
// only from the SIGINT/SIGTERM shutdown handler) with real --prompt/--cwd
// flags, verifying it runs exactly one turn and exits instead of hanging
// on repl()'s stdin read.
describe("CLI --prompt/--cwd single-shot mode (real local SSE server, real main())", () => {
  let server: http.Server;
  let baseUrl: string;
  let receivedRequests: string[] = [];

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
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(() => {
    server.close();
  });

  it("runs exactly one turn against the real fake server and exits, persisting the session, instead of hanging on the REPL", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-prompt-mode-"));
    const homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-prompt-mode-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    receivedRequests = [];

    // This real dev shell exports FINANFA_BASE_URL/FINANFA_MODEL/
    // FINANFA_API_KEY/FINANFA_PROVIDER for manual testing against a real
    // inference endpoint — selectProvider() reads those with priority over
    // the project's own .finanfa-code/config.json, so without clearing
    // them here this test would silently make a REAL API call to a real
    // paid endpoint instead of the fake local server (confirmed: this
    // happened on the first real run of this test, before this override
    // was added).
    const ENV_KEYS_TO_CLEAR = ["FINANFA_PROVIDER", "FINANFA_BASE_URL", "FINANFA_MODEL", "FINANFA_API_KEY", "FINANFA_API_KEYS", "ANTHROPIC_API_KEY"] as const;
    const originalEnv = Object.fromEntries(ENV_KEYS_TO_CLEAR.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS_TO_CLEAR) delete process.env[k];

    try {
      await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
      await writeFile(
        path.join(projectDir, ".finanfa-code", "config.json"),
        JSON.stringify({ provider: "openai-compatible", baseUrl, model: "fake-model", apiKey: "test-key" }),
      );

      // A real timeout guard: if --prompt mode regressed into falling
      // through to repl()'s ui.askUser (which reads real stdin and would
      // hang forever in this test process with no TTY), this test must
      // fail loudly instead of hanging the whole suite.
      await Promise.race([
        main(["node", "finanfa", "--prompt", "say hi", "--cwd", projectDir, "--non-interactive", "--ui", "readline"]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("main() did not return — likely fell through to the interactive REPL")), 10_000)),
      ]);

      // 2 real requests: the actual turn, then maybeGenerateTitle's own
      // follow-up call (--prompt mode calls it too, same as the REPL loop
      // does after every turn) — both real calls to the fake server.
      expect(receivedRequests).toHaveLength(2);
      expect(JSON.parse(receivedRequests[0]!).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "say hi" })]));

      const sessionsRootDir = path.join(homeDir, ".finanfa-code", "sessions");
      const projectHashDirs = await readdir(sessionsRootDir);
      expect(projectHashDirs).toHaveLength(1);
      const sessionFiles = await readdir(path.join(sessionsRootDir, projectHashDirs[0]!));
      expect(sessionFiles).toHaveLength(1);
      const sessionData = JSON.parse(await readFile(path.join(sessionsRootDir, projectHashDirs[0]!, sessionFiles[0]!), "utf-8"));
      expect(sessionData.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "say hi" }),
          expect.objectContaining({ role: "assistant", content: "Hello from the fake model." }),
        ]),
      );
    } finally {
      process.env.HOME = originalHome;
      for (const k of ENV_KEYS_TO_CLEAR) {
        if (originalEnv[k] === undefined) delete process.env[k];
        else process.env[k] = originalEnv[k];
      }
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 20_000);
});
