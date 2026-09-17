import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createGenerate2dTool, generate2dConfigFromEnv, generateImageOpenAi } from "../../src/tools/builtin/generate-2d.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="; // a real 1x1 PNG

describe("generate_2d tool — not configured (honest unavailable message)", () => {
  it("has 'ask' risk level and reports unavailable, mentioning the prompt", async () => {
    const tool = createGenerate2dTool(undefined);
    expect(tool.riskLevel).toBe("ask");
    const result = await tool.handler({ prompt: "a mountain landscape" }, { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable");
    expect(result.content).toContain("a mountain landscape");
    expect(result.content).toContain("OPENAI_API_KEY");
  });

  it("describeCall summarizes the request", () => {
    expect(createGenerate2dTool(undefined).describeCall?.({ prompt: "a logo" })).toBe("generate 2D image: a logo");
  });
});

describe("generate_2d tool (real local HTTP server speaking OpenAI's Images API shape)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequestBody: string | undefined;
  let lastAuthHeader: string | undefined;
  let responseOverride: { status: number; body: unknown } | undefined;
  let dir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequestBody = body;
        lastAuthHeader = req.headers.authorization;
        const r = responseOverride ?? { status: 200, body: { data: [{ b64_json: TINY_PNG_BASE64 }] } };
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-generate-2d-"));
  });

  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, sessionId: "s", signal: new AbortController().signal });

  it("generateImageOpenAi posts a real authenticated request and returns the real image data", async () => {
    const result = await generateImageOpenAi({ apiKey: "sk-real-looking-key" }, "a red circle", undefined, baseUrl);
    expect(result).toEqual({ ok: true, base64: TINY_PNG_BASE64 });
    expect(lastAuthHeader).toBe("Bearer sk-real-looking-key");
    const sentBody = JSON.parse(lastRequestBody!);
    expect(sentBody).toEqual({ model: "gpt-image-1", prompt: "a red circle", size: "1024x1024", n: 1 });
  });

  it("generate_2d tool shows the generated image and reports success", async () => {
    const tool = createGenerate2dTool({ apiKey: "k" }, baseUrl);
    const result = await tool.handler({ prompt: "a red circle" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.images).toEqual([{ mimeType: "image/png", base64: TINY_PNG_BASE64 }]);
    expect(result.content).toContain("a red circle");
  });

  it("generate_2d tool saves the image to output_path when given", async () => {
    const tool = createGenerate2dTool({ apiKey: "k" }, baseUrl);
    const result = await tool.handler({ prompt: "a red circle", output_path: "out/image.png" }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("out/image.png");
    const written = await readFile(path.join(dir, "out", "image.png"));
    expect(written.toString("base64")).toBe(TINY_PNG_BASE64);
  });

  it("passes a custom size through to the real request", async () => {
    const tool = createGenerate2dTool({ apiKey: "k" }, baseUrl);
    await tool.handler({ prompt: "a tall poster", size: "1024x1536" }, ctx());
    expect(JSON.parse(lastRequestBody!).size).toBe("1024x1536");
  });

  it("reports a real OpenAI API error instead of throwing", async () => {
    responseOverride = { status: 400, body: { error: { message: "Invalid size parameter" } } };
    const tool = createGenerate2dTool({ apiKey: "k" }, baseUrl);
    const result = await tool.handler({ prompt: "x" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid size parameter");
    responseOverride = undefined;
  });
});

describe("generate2dConfigFromEnv", () => {
  it("returns undefined when OPENAI_API_KEY is not set", () => {
    expect(generate2dConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(generate2dConfigFromEnv({ OPENAI_API_KEY: "sk-abc" } as NodeJS.ProcessEnv)).toEqual({ apiKey: "sk-abc" });
  });
});
