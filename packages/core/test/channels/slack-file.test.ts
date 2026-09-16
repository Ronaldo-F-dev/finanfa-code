import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchSlackFile } from "../../src/channels/slack-file.js";

describe("fetchSlackFile (real local HTTP server speaking Slack's url_private shape)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastAuthHeader: string | undefined;
  let statusToReturn = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastAuthHeader = req.headers.authorization;
      res.writeHead(statusToReturn, { "content-type": "image/png" });
      res.end(Buffer.from("fake png bytes"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("downloads the real bytes as base64, authenticated with the bot token", async () => {
    const result = await fetchSlackFile({ botToken: "xoxb-real-looking-token" }, `${baseUrl}/f1.png`);
    expect(result).toEqual({ ok: true, base64: Buffer.from("fake png bytes").toString("base64") });
    expect(lastAuthHeader).toBe("Bearer xoxb-real-looking-token");
  });

  it("reports a clear error on a non-2xx response", async () => {
    statusToReturn = 403;
    const result = await fetchSlackFile({ botToken: "bad" }, `${baseUrl}/f1.png`);
    expect(result).toEqual({ ok: false, error: "Slack file download returned HTTP 403." });
    statusToReturn = 200;
  });
});
