import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createGetSpotifyNowPlayingTool,
  createControlSpotifyPlaybackTool,
  spotifyConfigFromEnv,
  getSpotifyAccessToken,
} from "../../src/tools/builtin/spotify.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const config = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" };

describe("Spotify tools (real local HTTP server standing in for accounts.spotify.com + api.spotify.com)", () => {
  let server: http.Server;
  let baseUrl: string;
  let apiUrl: string;
  let lastTokenRequest: { headers: http.IncomingHttpHeaders; body: string } | undefined;
  let lastPlayerRequest: { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders } | undefined;
  let nowPlayingResponse: { status: number; body: unknown } | undefined;
  let playbackResponse: { status: number; body?: unknown } | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/api/token") {
          lastTokenRequest = { headers: req.headers, body };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "real-looking-access-token", token_type: "Bearer", expires_in: 3600 }));
          return;
        }
        if (req.url === "/v1/me/player/currently-playing") {
          lastPlayerRequest = { method: req.method, url: req.url, headers: req.headers };
          const r = nowPlayingResponse ?? { status: 200, body: { is_playing: true, item: { name: "Song Title", artists: [{ name: "Artist One" }, { name: "Artist Two" }] } } };
          if (r.status === 204) {
            res.writeHead(204);
            res.end();
            return;
          }
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.body));
          return;
        }
        // playback control endpoints: /v1/me/player/play|pause|next|previous
        lastPlayerRequest = { method: req.method, url: req.url, headers: req.headers };
        const r = playbackResponse ?? { status: 204 };
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body ? JSON.stringify(r.body) : "");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    apiUrl = `${baseUrl}/v1`;
  });

  afterAll(() => {
    server.close();
  });

  it("getSpotifyAccessToken exchanges the refresh token via HTTP Basic auth on the real token endpoint", async () => {
    const result = await getSpotifyAccessToken(config, baseUrl);
    expect(result).toEqual({ ok: true, accessToken: "real-looking-access-token" });
    expect(lastTokenRequest?.headers.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(lastTokenRequest?.body).toBe("grant_type=refresh_token&refresh_token=refresh-token");
  });

  it("get_spotify_now_playing reports the real currently-playing track", async () => {
    const tool = createGetSpotifyNowPlayingTool(config, apiUrl, baseUrl);
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe('Playing: "Song Title" by Artist One, Artist Two');
    expect(lastPlayerRequest?.headers.authorization).toBe("Bearer real-looking-access-token");
  });

  it("get_spotify_now_playing reports nothing playing on a real 204", async () => {
    nowPlayingResponse = { status: 204, body: undefined };
    const tool = createGetSpotifyNowPlayingTool(config, apiUrl, baseUrl);
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Nothing is currently playing.");
    nowPlayingResponse = undefined;
  });

  it("get_spotify_now_playing reports a real Spotify API error", async () => {
    nowPlayingResponse = { status: 403, body: { error: { status: 403, message: "Insufficient client scope" } } };
    const tool = createGetSpotifyNowPlayingTool(config, apiUrl, baseUrl);
    const result = await tool.handler({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Insufficient client scope");
    nowPlayingResponse = undefined;
  });

  it("control_spotify_playback posts a real request to the right playback endpoint per action", async () => {
    const tool = createControlSpotifyPlaybackTool(config, apiUrl, baseUrl);
    const result = await tool.handler({ action: "pause" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Spotify playback: pause.");
    expect(lastPlayerRequest?.method).toBe("PUT");
    expect(lastPlayerRequest?.url).toBe("/v1/me/player/pause");

    await tool.handler({ action: "next" }, ctx);
    expect(lastPlayerRequest?.method).toBe("POST");
    expect(lastPlayerRequest?.url).toBe("/v1/me/player/next");
  });

  it("control_spotify_playback reports a real error (e.g. no active device)", async () => {
    playbackResponse = { status: 404, body: { error: { status: 404, message: "No active device found" } } };
    const tool = createControlSpotifyPlaybackTool(config, apiUrl, baseUrl);
    const result = await tool.handler({ action: "play" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No active device found");
    playbackResponse = undefined;
  });

  it("reports a clear error when Spotify is not configured, instead of throwing", async () => {
    const nowPlayingTool = createGetSpotifyNowPlayingTool(undefined, apiUrl, baseUrl);
    const nowPlayingResult = await nowPlayingTool.handler({}, ctx);
    expect(nowPlayingResult.isError).toBe(true);
    expect(nowPlayingResult.content).toContain("Spotify is not configured");

    const playbackTool = createControlSpotifyPlaybackTool(undefined, apiUrl, baseUrl);
    const playbackResult = await playbackTool.handler({ action: "play" }, ctx);
    expect(playbackResult.isError).toBe(true);
    expect(playbackResult.content).toContain("Spotify is not configured");
  });

  it("has the expected risk levels: safe to read now-playing, ask to control playback", () => {
    expect(createGetSpotifyNowPlayingTool(config, apiUrl, baseUrl).riskLevel).toBe("safe");
    expect(createControlSpotifyPlaybackTool(config, apiUrl, baseUrl).riskLevel).toBe("ask");
  });
});

describe("spotifyConfigFromEnv", () => {
  it("returns undefined unless all three env vars are set", () => {
    expect(spotifyConfigFromEnv({})).toBeUndefined();
    expect(spotifyConfigFromEnv({ SPOTIFY_CLIENT_ID: "a" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(spotifyConfigFromEnv({ SPOTIFY_CLIENT_ID: "a", SPOTIFY_CLIENT_SECRET: "b" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from real env-var-shaped input", () => {
    expect(spotifyConfigFromEnv({ SPOTIFY_CLIENT_ID: "a", SPOTIFY_CLIENT_SECRET: "b", SPOTIFY_REFRESH_TOKEN: "c" } as NodeJS.ProcessEnv)).toEqual({
      clientId: "a",
      clientSecret: "b",
      refreshToken: "c",
    });
  });
});
