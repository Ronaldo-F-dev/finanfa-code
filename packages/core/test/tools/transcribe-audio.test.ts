import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTranscribeAudioTool, transcribeAudioConfigFromEnv } from "../../src/tools/builtin/transcribe-audio.js";

describe("transcribe_audio tool (real local HTTP server speaking Whisper's transcription shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let dir: string;
  let audioPath: string;
  let lastRequest: { headers: http.IncomingHttpHeaders; body: Buffer } | undefined;
  let shouldError = false;

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-transcribe-"));
    audioPath = path.join(dir, "clip.mp3");
    await writeFile(audioPath, Buffer.from("not real audio bytes, the fake server never decodes it"));

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        lastRequest = { headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(shouldError ? 401 : 200, { "content-type": "application/json" });
        if (shouldError) {
          res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
        } else {
          res.end(JSON.stringify({ text: "hello from the transcript" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("posts the real audio bytes as multipart form data and returns the transcript", async () => {
    const tool = createTranscribeAudioTool({ apiKey: "sk-real-looking-key" }, apiBaseUrl);
    const result = await tool.handler({ audioPath: "clip.mp3" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toBe("hello from the transcript");

    expect(lastRequest?.headers.authorization).toBe("Bearer sk-real-looking-key");
    expect(lastRequest?.headers["content-type"]).toMatch(/^multipart\/form-data/);
    expect(lastRequest?.body.includes("not real audio bytes")).toBe(true);
    expect(lastRequest?.body.includes("whisper-1")).toBe(true);
  });

  it("reports an API-level rejection as a tool error with the real message", async () => {
    shouldError = true;
    const tool = createTranscribeAudioTool({ apiKey: "bad-key" }, apiBaseUrl);
    const result = await tool.handler({ audioPath: "clip.mp3" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Incorrect API key provided");
    shouldError = false;
  });

  it("reports a clear error when not configured, instead of throwing", async () => {
    const tool = createTranscribeAudioTool(undefined, apiBaseUrl);
    const result = await tool.handler({ audioPath: "clip.mp3" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("reports a clear error for an unsupported audio extension", async () => {
    const tool = createTranscribeAudioTool({ apiKey: "x" }, apiBaseUrl);
    const result = await tool.handler({ audioPath: "clip.txt" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported audio format");
  });

  it("reports a clear error when the file doesn't exist", async () => {
    const tool = createTranscribeAudioTool({ apiKey: "x" }, apiBaseUrl);
    const result = await tool.handler({ audioPath: "missing.mp3" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No such file");
  });

  it("has 'safe' risk level — it only reads a file and calls a transcription API, no side effects", () => {
    expect(createTranscribeAudioTool({ apiKey: "x" }, apiBaseUrl).riskLevel).toBe("safe");
  });
});

describe("transcribeAudioConfigFromEnv", () => {
  it("returns undefined when OPENAI_API_KEY is not set", () => {
    expect(transcribeAudioConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(transcribeAudioConfigFromEnv({ OPENAI_API_KEY: "sk-abc" } as NodeJS.ProcessEnv)).toEqual({ apiKey: "sk-abc" });
  });
});
