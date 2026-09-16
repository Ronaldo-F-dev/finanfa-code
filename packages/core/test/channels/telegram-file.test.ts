import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchTelegramFile } from "../../src/channels/telegram-file.js";

describe("fetchTelegramFile (real local HTTP server speaking Telegram's getFile + file-download shape)", () => {
  let server: http.Server;
  let apiBaseUrl: string;
  let requestedUrls: string[];
  let getFileShouldFail = false;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requestedUrls.push(req.url ?? "");
      if (req.url?.startsWith("/bot123:test/getFile")) {
        if (getFileShouldFail) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, description: "Bad Request: file not found" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { file_path: "voice/file_1.oga" } }));
        return;
      }
      if (req.url === "/file/bot123:test/voice/file_1.oga") {
        res.writeHead(200, { "content-type": "audio/ogg" });
        res.end(Buffer.from("fake ogg opus bytes"));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("resolves a file_id to real bytes via the real two-step getFile + download flow", async () => {
    requestedUrls = [];
    const result = await fetchTelegramFile({ botToken: "123:test" }, "AABBCC", apiBaseUrl);
    expect(result).toEqual({ ok: true, bytes: Buffer.from("fake ogg opus bytes"), mimeType: "audio/ogg" });
    expect(requestedUrls[0]).toBe("/bot123:test/getFile?file_id=AABBCC");
    expect(requestedUrls[1]).toBe("/file/bot123:test/voice/file_1.oga");
  });

  it("reports a clear error when getFile itself rejects the file_id", async () => {
    getFileShouldFail = true;
    const result = await fetchTelegramFile({ botToken: "123:test" }, "bad-id", apiBaseUrl);
    expect(result).toEqual({ ok: false, error: "Bad Request: file not found" });
    getFileShouldFail = false;
  });
});
