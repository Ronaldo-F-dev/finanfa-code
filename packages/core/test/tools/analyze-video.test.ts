import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAnalyzeVideoTool, analyzeVideoConfigFromEnv, analyzeVideoInline, analyzeVideoViaFilesApi, videoMimeTypeForPath } from "../../src/tools/builtin/analyze-video.js";

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

  it("analyzeVideoInline posts real inline_data and returns Gemini's real text", async () => {
    const result = await analyzeVideoInline({ apiKey: "real-looking-key" }, "ZmFrZQ==", "video/mp4", "what happens?", undefined, baseUrl);
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

describe("analyzeVideoViaFilesApi (real local HTTP server implementing Google's documented resumable-upload protocol)", () => {
  let server: http.Server;
  let baseUrl: string;
  let requests: { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders; body: Buffer }[];
  let fileStateSequence: string[];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });

        if (req.url?.startsWith("/upload/v1beta/files")) {
          // Step 1: announce the upload, hand back a one-time upload URL via a real response HEADER (not the JSON body).
          res.writeHead(200, { "x-goog-upload-url": `${baseUrl}/upload-session/abc123`, "content-type": "application/json" });
          res.end("{}");
          return;
        }
        if (req.url === "/upload-session/abc123") {
          // Step 2: the real bytes, finalized in one shot.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ file: { uri: `${baseUrl}/v1beta/files/abc123:download`, name: "files/abc123" } }));
          return;
        }
        if (req.url?.startsWith("/v1beta/files/abc123") && req.method === "GET") {
          // Step 3: processing-state polling — PROCESSING once, then ACTIVE.
          const state = fileStateSequence.shift() ?? "ACTIVE";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ state }));
          return;
        }
        if (req.url?.startsWith("/v1beta/files/abc123") && req.method === "DELETE") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        // Step 4: the actual analysis call, referencing the uploaded file by file_uri.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A large uploaded video, analyzed via the real File API." }] } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("drives the full real upload -> poll -> analyze -> delete flow, in order, with the real bytes", async () => {
    requests = [];
    fileStateSequence = ["PROCESSING", "ACTIVE"];
    const buffer = Buffer.from("fake video bytes for the upload path");

    const result = await analyzeVideoViaFilesApi({ apiKey: "real-looking-key" }, buffer, "video/mp4", "what happens?", "clip.mp4", undefined, baseUrl);
    expect(result).toEqual({ ok: true, text: "A large uploaded video, analyzed via the real File API." });

    // The cleanup delete is fire-and-forget (doesn't delay the real answer
    // above) — give it a moment to actually land before checking for it.
    await new Promise((r) => setTimeout(r, 200));

    const urls = requests.map((r) => `${r.method} ${r.url}`);
    expect(urls[0]).toMatch(/^POST \/upload\/v1beta\/files\?key=real-looking-key$/);
    expect(urls[1]).toBe("POST /upload-session/abc123");
    expect(urls.some((u) => u.startsWith("GET /v1beta/files/abc123"))).toBe(true); // polled at least once (PROCESSING then ACTIVE)
    expect(urls.some((u) => u.startsWith("DELETE /v1beta/files/abc123"))).toBe(true); // best-effort cleanup, after the real answer was already returned
    expect(urls.some((u) => /^POST \/v1beta\/models\/.*:generateContent/.test(u))).toBe(true);

    // The real start-upload request carries the real size/mime-type headers Google's protocol requires.
    const startReq = requests[0]!;
    expect(startReq.headers["x-goog-upload-protocol"]).toBe("resumable");
    expect(startReq.headers["x-goog-upload-command"]).toBe("start");
    expect(startReq.headers["x-goog-upload-header-content-length"]).toBe(String(buffer.length));
    expect(startReq.headers["x-goog-upload-header-content-type"]).toBe("video/mp4");

    // The real upload request carries the real file bytes.
    const uploadReq = requests[1]!;
    expect(uploadReq.headers["x-goog-upload-command"]).toBe("upload, finalize");
    expect(uploadReq.body.equals(buffer)).toBe(true);
  }, 15_000);

  it("reports a real error from the upload-start step instead of throwing", async () => {
    // A separate, local server that never sends the required
    // X-Goog-Upload-URL header — a real, malformed response this client
    // must handle — kept fully separate from the shared server/baseUrl
    // above so this test can't affect the others' teardown.
    const badServer = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("File size quota exceeded");
      });
    });
    await new Promise<void>((resolve) => badServer.listen(0, "127.0.0.1", resolve));
    const badBaseUrl = `http://127.0.0.1:${(badServer.address() as AddressInfo).port}`;

    try {
      const result = await analyzeVideoViaFilesApi({ apiKey: "k" }, Buffer.from("x"), "video/mp4", "what happens?", "clip.mp4", undefined, badBaseUrl);
      expect(result).toEqual({ ok: false, error: "File size quota exceeded" });
    } finally {
      badServer.close();
    }
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
