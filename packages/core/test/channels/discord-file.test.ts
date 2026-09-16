import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchDiscordFile } from "../../src/channels/discord-file.js";

describe("fetchDiscordFile (real local HTTP server standing in for Discord's CDN)", () => {
  let server: http.Server;
  let baseUrl: string;
  let statusToReturn = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(statusToReturn, { "content-type": "image/png" });
      res.end(Buffer.from("fake png bytes"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("downloads the real bytes as base64, with no auth needed", async () => {
    const result = await fetchDiscordFile(`${baseUrl}/pic.png`);
    expect(result).toEqual({ ok: true, base64: Buffer.from("fake png bytes").toString("base64") });
  });

  it("reports a clear error on a non-2xx response", async () => {
    statusToReturn = 404;
    const result = await fetchDiscordFile(`${baseUrl}/gone.png`);
    expect(result).toEqual({ ok: false, error: "Discord CDN download returned HTTP 404." });
    statusToReturn = 200;
  });
});
