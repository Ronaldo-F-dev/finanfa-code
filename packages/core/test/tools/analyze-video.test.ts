import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAnalyzeVideoTool, analyzeVideoConfigFromEnv, analyzeVideoWithGemini, videoMimeTypeForPath } from "../../src/tools/builtin/analyze-video.js";

const execFileAsync = promisify(execFile);
const ctx = (dir: string) => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

describe("videoMimeTypeForPath", () => {
  it("maps known video extensions", () => {
    expect(videoMimeTypeForPath("clip.mp4")).toBe("video/mp4");
    expect(videoMimeTypeForPath("clip.MOV")).toBe("video/quicktime");
    expect(videoMimeTypeForPath("clip.webm")).toBe("video/webm");
  });

  it("returns undefined for an unknown extension", () => {
    expect(videoMimeTypeForPath("clip.txt")).toBeUndefined();
  });
});

describe("analyze_video tool — not configured", () => {
  it("reports a clear error instead of throwing", async () => {
    const tool = createAnalyzeVideoTool(undefined);
    const result = await tool.handler({ path: "clip.mp4", prompt: "what happens?" }, ctx("/tmp"));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("GEMINI_API_KEY");
  });
});

describe("analyze_video tool (real local HTTP server speaking Gemini's generateContent shape, real ffmpeg-generated video)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequestBody: string | undefined;
  let lastUrl: string | undefined;
  let responseOverride: { status: number; body: unknown } | undefined;
  let dir: string;
  let videoPath: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequestBody = body;
        lastUrl = req.url;
        const r = responseOverride ?? { status: 200, body: { candidates: [{ content: { parts: [{ text: "A red square appears and moves." }] } }] } };
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    dir = await mkdtemp(path.join(tmpdir(), "finanfa-analyze-video-"));
    videoPath = path.join(dir, "clip.mp4");
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=32x32:rate=5", "-pix_fmt", "yuv420p", videoPath]);
  }, 30_000);

  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("analyzeVideoWithGemini posts real inline_data and returns Gemini's real text", async () => {
    const result = await analyzeVideoWithGemini({ apiKey: "real-looking-key" }, "ZmFrZQ==", "video/mp4", "what happens?", undefined, baseUrl);
    expect(result).toEqual({ ok: true, text: "A red square appears and moves." });
    expect(lastUrl).toContain("key=real-looking-key");
    expect(lastUrl).toContain(":generateContent");
    const sent = JSON.parse(lastRequestBody!);
    expect(sent.contents[0].parts[0].text).toBe("what happens?");
    expect(sent.contents[0].parts[1].inline_data).toEqual({ mime_type: "video/mp4", data: "ZmFrZQ==" });
  });

  it("analyze_video tool reads a real video file and reports Gemini's real answer", async () => {
    const tool = createAnalyzeVideoTool({ apiKey: "k" }, baseUrl);
    const result = await tool.handler({ path: "clip.mp4", prompt: "what happens?" }, ctx(dir));
    expect(result.isError).toBe(false);
    expect(result.content).toBe("A red square appears and moves.");
  });

  it("reports a real Gemini API error instead of throwing", async () => {
    responseOverride = { status: 400, body: { error: { message: "Invalid inline data" } } };
    const tool = createAnalyzeVideoTool({ apiKey: "k" }, baseUrl);
    const result = await tool.handler({ path: "clip.mp4", prompt: "what happens?" }, ctx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid inline data");
    responseOverride = undefined;
  });

  it("rejects an unsupported file extension before making any request", async () => {
    const tool = createAnalyzeVideoTool({ apiKey: "k" }, baseUrl);
    const result = await tool.handler({ path: "notes.txt", prompt: "what happens?" }, ctx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported video type");
  });

  it("rejects a path escaping the project root", async () => {
    const tool = createAnalyzeVideoTool({ apiKey: "k" }, baseUrl);
    await expect(tool.handler({ path: "../outside.mp4", prompt: "x" }, ctx(dir))).rejects.toThrow(/outside the project root/);
  });

  it("has 'safe' risk level", () => {
    expect(createAnalyzeVideoTool({ apiKey: "k" }, baseUrl).riskLevel).toBe("safe");
  });
});

describe("analyzeVideoConfigFromEnv", () => {
  it("returns undefined when GEMINI_API_KEY is not set", () => {
    expect(analyzeVideoConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(analyzeVideoConfigFromEnv({ GEMINI_API_KEY: "g-abc" } as NodeJS.ProcessEnv)).toEqual({ apiKey: "g-abc" });
  });
});
