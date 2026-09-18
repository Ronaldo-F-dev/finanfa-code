import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import express from "express";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";
import { registerChannelsConfigRoutes, setPublicTunnelUrl } from "../src/channels-config-api.js";

// Real end-to-end test of the web UI's Channels settings API — same real
// subprocess/real-HOME-dir shape as the other web-server e2e suites, since
// this saves to the real global config file (~/.finanfa-code/config.json)
// and applies to the real process.env of the running server.

interface ChannelField {
  key: string;
  configured: boolean;
  envOverride: boolean;
}
interface ChannelStatus {
  id: string;
  configured: boolean;
  fields: ChannelField[];
  webhookPaths?: { label: string; url: string }[];
}

describe("web-server Channels config API (real subprocess, real global config file)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-channels-config-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-channels-config-home-"));
    // A real environment variable set before the server ever starts —
    // exercises the "env always wins" precedence for one specific field
    // (LINE_CHANNEL_SECRET), while every other field on every other
    // channel stays genuinely unconfigured for the rest of this suite.
    process.env.LINE_CHANNEL_SECRET = "real-env-secret";
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    delete process.env.LINE_CHANNEL_SECRET;
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("lists every channel as unconfigured, except a field with a real environment variable already set", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels-config`);
    const data = (await res.json()) as { channels: ChannelStatus[] };
    expect(data.channels.length).toBeGreaterThan(5);

    const telegram = data.channels.find((c) => c.id === "telegram");
    expect(telegram?.configured).toBe(false);
    expect(telegram?.fields.every((f) => !f.envOverride)).toBe(true);

    const line = data.channels.find((c) => c.id === "line");
    const secretField = line?.fields.find((f) => f.key === "LINE_CHANNEL_SECRET");
    expect(secretField?.configured).toBe(true);
    expect(secretField?.envOverride).toBe(true);

    expect(telegram?.webhookPaths?.[0]?.url).toBe(`http://127.0.0.1:${port}/api/channels/telegram/webhook`);
  });

  it("saves a channel's credentials, applies them immediately, and persists them to the global config file", async () => {
    const saveRes = await fetch(`http://127.0.0.1:${port}/api/channels-config/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ TELEGRAM_BOT_TOKEN: "123:real-token", TELEGRAM_WEBHOOK_SECRET: "real-secret" }),
    });
    expect(saveRes.ok).toBe(true);

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/channels-config`);
    const data = (await statusRes.json()) as { channels: ChannelStatus[] };
    const telegram = data.channels.find((c) => c.id === "telegram");
    expect(telegram?.configured).toBe(true);

    // Applied immediately (no restart) — the channel's own webhook route
    // now recognizes the secret instead of 404ing as "not configured".
    const webhookRes = await fetch(`http://127.0.0.1:${port}/api/channels/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "real-secret" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(webhookRes.status).toBe(200);

    const saved = JSON.parse(await readFile(path.join(homeDir, ".finanfa-code", "config.json"), "utf-8"));
    expect(saved.channels.telegram).toEqual({ TELEGRAM_BOT_TOKEN: "123:real-token", TELEGRAM_WEBHOOK_SECRET: "real-secret" });
  });

  it("clears a field when saved as an empty string", async () => {
    await fetch(`http://127.0.0.1:${port}/api/channels-config/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "" }),
    });

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/channels-config`);
    const data = (await statusRes.json()) as { channels: ChannelStatus[] };
    expect(data.channels.find((c) => c.id === "telegram")?.configured).toBe(false);
  });

  it("404s for an unknown channel id", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels-config/not-a-real-channel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("refuses to register Discord's slash command without a saved application id/bot token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/channels-config/discord/register-command`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});

// Real, reported feature: FINANFA_TUNNEL lets the server expose itself
// through a real cloudflared quick tunnel instead of requiring one to be
// started by hand in a separate terminal — see cloudflare-tunnel.ts. Once
// it resolves a public URL, every webhook URL this API reports should use
// it instead of whatever host the request itself happened to arrive on
// (almost always just localhost, which is useless to paste into Telegram/
// Discord's own webhook config). Exercised in-process (a bare express app,
// not the full server subprocess) since setPublicTunnelUrl is a plain
// exported function, not something reachable over the wire.
describe("channels-config-api — public tunnel URL takes priority over the request's own host", () => {
  it("uses the tunnel URL for webhookPaths once one is set, instead of the request's host", async () => {
    const app = express();
    registerChannelsConfigRoutes(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const before = await fetch(`http://127.0.0.1:${port}/api/channels-config`);
      const beforeData = (await before.json()) as { channels: { id: string; webhookPaths?: { url: string }[] }[] };
      expect(beforeData.channels.find((c) => c.id === "telegram")?.webhookPaths?.[0]?.url).toBe(`http://127.0.0.1:${port}/api/channels/telegram/webhook`);

      setPublicTunnelUrl("https://real-tunnel.trycloudflare.com");

      const tunnelStatus = await fetch(`http://127.0.0.1:${port}/api/tunnel-url`);
      const tunnelData = (await tunnelStatus.json()) as { url?: string };
      expect(tunnelData.url).toBe("https://real-tunnel.trycloudflare.com");

      const after = await fetch(`http://127.0.0.1:${port}/api/channels-config`);
      const afterData = (await after.json()) as { channels: { id: string; webhookPaths?: { url: string }[] }[] };
      expect(afterData.channels.find((c) => c.id === "telegram")?.webhookPaths?.[0]?.url).toBe("https://real-tunnel.trycloudflare.com/api/channels/telegram/webhook");
    } finally {
      server.close();
    }
  });
});
