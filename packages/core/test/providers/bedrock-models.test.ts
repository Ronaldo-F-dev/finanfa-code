import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { listBedrockModels } from "../../src/providers/bedrock-models.js";

// Real @aws-sdk/client-bedrock client, pointed (via its own `endpoint`
// config option) at a real local HTTP server standing in for the Bedrock
// control-plane API — the fake server doesn't verify the real SigV4
// signature the SDK still computes and sends (fake static credentials are
// enough for that), it just returns the exact shape ListFoundationModels/
// ListInferenceProfiles are documented to (see bedrock-models.ts's own
// comment on the real GET /foundation-models, /inference-profiles paths).
describe("listBedrockModels (real @aws-sdk/client-bedrock, real local HTTP server)", () => {
  let server: http.Server;
  let endpoint: string;
  let requestedPaths: string[];

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = "fake-access-key-id";
    process.env.AWS_SECRET_ACCESS_KEY = "fake-secret-access-key";

    server = http.createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/foundation-models")) {
        res.end(
          JSON.stringify({
            modelSummaries: [
              { modelId: "anthropic.claude-sonnet-5-20250929-v1:0", modelName: "Claude Sonnet 5" },
              { modelId: "amazon.titan-text-express-v1", modelName: "Titan Text Express" },
            ],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/inference-profiles")) {
        res.end(
          JSON.stringify({
            inferenceProfileSummaries: [{ inferenceProfileId: "us.anthropic.claude-sonnet-5-20250929-v1:0", inferenceProfileName: "US cross-region Claude Sonnet 5" }],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  it("lists both foundation models and inference profiles, tagged by kind", async () => {
    requestedPaths = [];
    const models = await listBedrockModels({ region: "us-east-1", endpoint });

    expect(models).toEqual([
      { id: "anthropic.claude-sonnet-5-20250929-v1:0", name: "Claude Sonnet 5", kind: "foundation-model" },
      { id: "amazon.titan-text-express-v1", name: "Titan Text Express", kind: "foundation-model" },
      { id: "us.anthropic.claude-sonnet-5-20250929-v1:0", name: "US cross-region Claude Sonnet 5", kind: "inference-profile" },
    ]);
    expect(requestedPaths.some((p) => p.startsWith("/foundation-models"))).toBe(true);
    expect(requestedPaths.some((p) => p.startsWith("/inference-profiles"))).toBe(true);
  });

  it("skips a malformed summary missing its own id, instead of crashing", async () => {
    server.close();
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.startsWith("/foundation-models")) {
          res.end(JSON.stringify({ modelSummaries: [{ modelName: "no id here" }] }));
        } else {
          res.end(JSON.stringify({ inferenceProfileSummaries: [] }));
        }
      });
      server.listen(0, "127.0.0.1", resolve);
    });
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect(await listBedrockModels({ region: "us-east-1", endpoint })).toEqual([]);
  });
});
