import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  LocalTransformersEmbeddingProvider,
  ApiEmbeddingProvider,
  createEmbeddingProvider,
} from "../../../src/core/rag/embedding-provider.js";
import type { FinanfaConfig } from "../../../src/core/config.js";

describe("LocalTransformersEmbeddingProvider (real in-process embeddings, no mocks — downloads the model on first run)", () => {
  const provider = new LocalTransformersEmbeddingProvider();

  it("reports the model's real dimensionality", () => {
    expect(provider.dimensions).toBe(384);
  });

  it("produces a real, consistent embedding — the same input twice gives the same vector", async () => {
    const [first] = await provider.embed(["The cat sat on the mat."]);
    const [second] = await provider.embed(["The cat sat on the mat."]);
    expect(first).toHaveLength(384);
    expect(first).toEqual(second);
  }, 120_000);

  it("ranks a semantically similar sentence above an unrelated one by real cosine similarity", async () => {
    const [query, similar, unrelated] = await provider.embed([
      "How do I bake a chocolate cake?",
      "What's a good recipe for baking a cake?",
      "The quarterly earnings report exceeded analyst expectations.",
    ]);

    function cosine(a: number[], b: number[]): number {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    const simToSimilar = cosine(query!, similar!);
    const simToUnrelated = cosine(query!, unrelated!);
    expect(simToSimilar).toBeGreaterThan(simToUnrelated);
    expect(simToSimilar).toBeGreaterThan(0.5);
  }, 120_000);

  it("returns unit-length (normalized) vectors", async () => {
    const [vector] = await provider.embed(["some arbitrary sentence"]);
    const norm = Math.sqrt(vector!.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  }, 120_000);

  it("returns an empty array for an empty input with no model load required", async () => {
    expect(await new LocalTransformersEmbeddingProvider().embed([])).toEqual([]);
  });
}, 180_000);

describe("ApiEmbeddingProvider (delegates to embedTexts against a real fake HTTP server)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let lastBody: { model: string; input: string[] } | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastBody = JSON.parse(raw);
        const data = lastBody!.input.map((_, index) => ({ index, embedding: [index, index + 1] }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  it("delegates to embedTexts, passing through apiBaseUrl and model", async () => {
    const provider = new ApiEmbeddingProvider("sk-test", apiBaseUrl, "nomic-embed-text", 2);
    const vectors = await provider.embed(["hello", "world"]);
    expect(vectors).toEqual([[0, 1], [1, 2]]);
    expect(lastBody?.model).toBe("nomic-embed-text");
    expect(lastBody?.input).toEqual(["hello", "world"]);
    expect(provider.dimensions).toBe(2);
  });
});

describe("createEmbeddingProvider (config-driven factory)", () => {
  it("falls back to the zero-config local provider when no embeddingApiBaseUrl is set", () => {
    const provider = createEmbeddingProvider({});
    expect(provider).toBeInstanceOf(LocalTransformersEmbeddingProvider);
  });

  it("picks the API override provider when embeddingApiBaseUrl is set", () => {
    const config: FinanfaConfig = { embeddingApiBaseUrl: "http://localhost:11434/v1", embeddingModel: "nomic-embed-text", embeddingApiKey: "k" };
    const provider = createEmbeddingProvider(config);
    expect(provider).toBeInstanceOf(ApiEmbeddingProvider);
  });

  it("an override provider falls back to the primary apiKey when embeddingApiKey is unset", async () => {
    let sawAuthHeader: string | undefined;
    const server = http.createServer((req, res) => {
      sawAuthHeader = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const provider = createEmbeddingProvider({ apiKey: "sk-primary", embeddingApiBaseUrl: apiBaseUrl });
    await provider.embed(["x"]);
    expect(sawAuthHeader).toBe("Bearer sk-primary");
    server.close();
  });
});
