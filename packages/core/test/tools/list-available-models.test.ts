import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createListAvailableModelsTool } from "../../src/tools/builtin/list-available-models.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

describe("list_available_models tool", () => {
  it("reports a clear error for a provider with no live discovery API", async () => {
    const tool = createListAvailableModelsTool({ provider: "anthropic" });
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"anthropic"');
    expect(result.content).toContain("only amazon-bedrock");
  });

  it("has 'safe' risk level — a read-only listing call", () => {
    expect(createListAvailableModelsTool({ provider: "anthropic" }).riskLevel).toBe("safe");
  });

  describe("with a real @aws-sdk/client-bedrock call against a real local fake Bedrock server", () => {
    let server: http.Server;
    let endpoint: string;

    beforeAll(async () => {
      process.env.AWS_ACCESS_KEY_ID = "fake-access-key-id";
      process.env.AWS_SECRET_ACCESS_KEY = "fake-secret-access-key";
      process.env.AWS_REGION = "us-east-1";

      server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.startsWith("/foundation-models")) {
          res.end(JSON.stringify({ modelSummaries: [{ modelId: "anthropic.claude-sonnet-5-20250929-v1:0", modelName: "Claude Sonnet 5" }] }));
        } else {
          res.end(JSON.stringify({ inferenceProfileSummaries: [] }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.AWS_ENDPOINT_URL_BEDROCK = endpoint;
    });

    afterAll(() => {
      server.close();
      for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_ENDPOINT_URL_BEDROCK"]) delete process.env[k];
    });

    it("lists real models for amazon-bedrock, formatted with id/name/kind", async () => {
      const tool = createListAvailableModelsTool({ provider: "amazon-bedrock", awsRegion: "us-east-1" });
      const result = await tool.handler({}, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain("anthropic.claude-sonnet-5-20250929-v1:0 — Claude Sonnet 5 (foundation-model)");
    });
  });
});
