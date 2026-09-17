import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runReplicateModel, downloadReplicateOutput, replicateConfigFromEnv } from "../../src/core/replicate.js";

describe("replicateConfigFromEnv", () => {
  it("returns undefined when REPLICATE_API_TOKEN is not set", () => {
    expect(replicateConfigFromEnv({})).toBeUndefined();
  });

  it("builds a config from a real env-var-shaped input", () => {
    expect(replicateConfigFromEnv({ REPLICATE_API_TOKEN: "r8_abc" } as NodeJS.ProcessEnv)).toEqual({ apiToken: "r8_abc" });
  });
});

describe("runReplicateModel (real local HTTP server speaking Replicate's create-prediction/poll shape)", () => {
  let server: http.Server;
  let baseUrl: string;
  let createRequest: { url: string | undefined; authHeader: string | undefined; body: string } | undefined;
  let pollCount: number;
  let statusSequence: string[];
  let output: unknown;
  let createResponseOverride: { status: number; body: unknown } | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.startsWith("/v1/models/")) {
          createRequest = { url: req.url, authHeader: req.headers.authorization, body };
          const r = createResponseOverride ?? { status: 201, body: { id: "pred-1", status: "starting", urls: { get: `${baseUrl}/v1/predictions/pred-1` } } };
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.body));
          return;
        }
        if (req.url === "/v1/predictions/pred-1") {
          pollCount++;
          const status = statusSequence[Math.min(pollCount - 1, statusSequence.length - 1)];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "pred-1", status, output: status === "succeeded" ? output : undefined, error: status === "failed" ? "the model itself failed" : undefined }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("creates a real authenticated prediction, polls until succeeded, and returns the real output URL", async () => {
    pollCount = 0;
    statusSequence = ["processing", "succeeded"];
    output = "https://replicate.delivery/output/video123.mp4";

    const result = await runReplicateModel({ apiToken: "r8_real-looking-token" }, "minimax/video-01", { prompt: "a cat" }, 10_000, baseUrl);
    expect(result).toEqual({ ok: true, outputUrls: ["https://replicate.delivery/output/video123.mp4"] });

    expect(createRequest?.url).toBe("/v1/models/minimax/video-01/predictions");
    expect(createRequest?.authHeader).toBe("Bearer r8_real-looking-token");
    expect(JSON.parse(createRequest!.body)).toEqual({ input: { prompt: "a cat" } });
    expect(pollCount).toBeGreaterThanOrEqual(2); // saw "processing" at least once before "succeeded"
  });

  it("handles an array output (multiple generated files), returning every URL", async () => {
    pollCount = 0;
    statusSequence = ["succeeded"];
    output = ["https://replicate.delivery/a.mp4", "https://replicate.delivery/b.mp4"];

    const result = await runReplicateModel({ apiToken: "t" }, "some/model", {}, 10_000, baseUrl);
    expect(result).toEqual({ ok: true, outputUrls: ["https://replicate.delivery/a.mp4", "https://replicate.delivery/b.mp4"] });
  });

  it("reports a real failed prediction as an error, with the model's own error message", async () => {
    pollCount = 0;
    statusSequence = ["failed"];
    const result = await runReplicateModel({ apiToken: "t" }, "some/model", {}, 10_000, baseUrl);
    expect(result).toEqual({ ok: false, error: "the model itself failed" });
  });

  it("reports a real error from the create-prediction step instead of throwing", async () => {
    createResponseOverride = { status: 401, body: { detail: "Invalid token." } };
    const result = await runReplicateModel({ apiToken: "bad" }, "some/model", {}, 10_000, baseUrl);
    expect(result).toEqual({ ok: false, error: "Invalid token." });
    createResponseOverride = undefined;
  });

  it("times out cleanly if the prediction never reaches a terminal state in time", async () => {
    pollCount = 0;
    statusSequence = ["processing"]; // never succeeds/fails
    const result = await runReplicateModel({ apiToken: "t" }, "some/model", {}, 2_500, baseUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Timed out");
  }, 10_000);
});

describe("downloadReplicateOutput (real local HTTP server)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/missing") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.from("real fake media bytes"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("downloads the real bytes from a real URL", async () => {
    const result = await downloadReplicateOutput(`${baseUrl}/output.mp4`);
    expect(result).toEqual({ ok: true, bytes: Buffer.from("real fake media bytes") });
  });

  it("reports a real download error instead of throwing", async () => {
    const result = await downloadReplicateOutput(`${baseUrl}/missing`);
    expect(result.ok).toBe(false);
  });
});
