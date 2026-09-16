import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { embedTexts, cosineSimilarity, embeddingsConfigFromEnv } from "../../src/core/embeddings.js";

describe("embedTexts (real local HTTP server speaking OpenAI's embeddings shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastRequestBody: { model: string; input: string[] } | undefined;
  let shouldError = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastRequestBody = JSON.parse(raw);
        res.writeHead(shouldError ? 401 : 200, { "content-type": "application/json" });
        if (shouldError) {
          res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
          return;
        }
        const data = lastRequestBody!.input.map((_, index) => ({ index, embedding: [index, index + 1, index + 2] }));
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("embeds a batch of texts in one request, preserving input order in the result", async () => {
    const vectors = await embedTexts({ apiKey: "sk-test" }, ["first", "second", "third"], apiBaseUrl);
    expect(vectors).toEqual([
      [0, 1, 2],
      [1, 2, 3],
      [2, 3, 4],
    ]);
    expect(lastRequestBody?.input).toEqual(["first", "second", "third"]);
  });

  it("splits more than the batch size into multiple real requests", async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
    const vectors = await embedTexts({ apiKey: "sk-test" }, texts, apiBaseUrl);
    expect(vectors).toHaveLength(150);
    expect(vectors[0]).toEqual([0, 1, 2]);
  });

  it("throws with the real API error message on failure", async () => {
    shouldError = true;
    await expect(embedTexts({ apiKey: "bad-key" }, ["x"], apiBaseUrl)).rejects.toThrow(/Incorrect API key provided/);
    shouldError = false;
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it("returns 0 (not NaN) for a zero vector, instead of dividing by zero", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe("embeddingsConfigFromEnv", () => {
  it("returns undefined when OPENAI_API_KEY is not set", () => {
    expect(embeddingsConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(embeddingsConfigFromEnv({ OPENAI_API_KEY: "sk-abc" } as NodeJS.ProcessEnv)).toEqual({ apiKey: "sk-abc" });
  });
});
