import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createGenerateVideoTool, createGenerateMusicTool } from "../../src/tools/builtin/generate-media.js";

describe("generate_video / generate_music tools — not configured", () => {
  it("report a clear error instead of throwing", async () => {
    const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
    const videoResult = await createGenerateVideoTool(undefined).handler({ model: "x/y", input: {}, output_path: "out.mp4" }, ctx);
    expect(videoResult.isError).toBe(true);
    expect(videoResult.content).toContain("REPLICATE_API_TOKEN");

    const musicResult = await createGenerateMusicTool(undefined).handler({ model: "x/y", input: {}, output_path: "out.mp3" }, ctx);
    expect(musicResult.isError).toBe(true);
    expect(musicResult.content).toContain("REPLICATE_API_TOKEN");
  });
});

describe("generate_video / generate_music tools (real local HTTP server speaking Replicate's create/poll/download shape)", () => {
  let server: http.Server;
  let baseUrl: string;
  let dir: string;
  let createRequestBody: string | undefined;
  let outputOverride: unknown;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.startsWith("/v1/models/")) {
          createRequestBody = body;
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "pred-1", status: "starting", urls: { get: `${baseUrl}/v1/predictions/pred-1` } }));
          return;
        }
        if (req.url === "/v1/predictions/pred-1") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "pred-1", status: "succeeded", output: outputOverride ?? `${baseUrl}/output/generated.bin` }));
          return;
        }
        if (req.url === "/output/generated.bin") {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(Buffer.from("real generated media bytes"));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-generate-media-"));
  });

  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("generate_video runs a real prediction, downloads the real output, and saves it", async () => {
    const tool = createGenerateVideoTool({ apiToken: "t" }, baseUrl);
    const result = await tool.handler({ model: "minimax/video-01", input: { prompt: "a cat" }, output_path: "clips/out.mp4" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("clips/out.mp4");

    expect(JSON.parse(createRequestBody!)).toEqual({ input: { prompt: "a cat" } });
    const written = await readFile(path.join(dir, "clips", "out.mp4"));
    expect(written.toString()).toBe("real generated media bytes");
  });

  it("generate_music runs a real prediction, downloads the real output, and saves it", async () => {
    const tool = createGenerateMusicTool({ apiToken: "t" }, baseUrl);
    const result = await tool.handler({ model: "meta/musicgen", input: { prompt: "lofi beat" }, output_path: "out.mp3" }, ctx());
    expect(result.isError).toBe(false);
    const written = await readFile(path.join(dir, "out.mp3"));
    expect(written.toString()).toBe("real generated media bytes");
  });

  it("reports when there are multiple output files, naming the rest", async () => {
    outputOverride = [`${baseUrl}/output/generated.bin`, `${baseUrl}/output/second.bin`];
    const tool = createGenerateVideoTool({ apiToken: "t" }, baseUrl);
    const result = await tool.handler({ model: "x/y", input: {}, output_path: "out.mp4" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain(`${baseUrl}/output/second.bin`);
    outputOverride = undefined;
  });

  it("reports a real Replicate error instead of throwing", async () => {
    const tool = createGenerateVideoTool({ apiToken: "t" }, "http://127.0.0.1:1"); // nothing listening there
    const result = await tool.handler({ model: "x/y", input: {}, output_path: "out.mp4" }, ctx());
    expect(result.isError).toBe(true);
  });

  it("rejects a path escaping the project root", async () => {
    const tool = createGenerateVideoTool({ apiToken: "t" }, baseUrl);
    await expect(tool.handler({ model: "x/y", input: {}, output_path: "../outside.mp4" }, ctx())).rejects.toThrow(/outside the project root/);
  });

  it("has 'ask' risk level for both tools", () => {
    expect(createGenerateVideoTool({ apiToken: "t" }).riskLevel).toBe("ask");
    expect(createGenerateMusicTool({ apiToken: "t" }).riskLevel).toBe("ask");
  });
});
