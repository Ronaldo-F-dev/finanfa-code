import type { Express } from "express";
import { CHANNEL_CATALOG } from "@finanfa/core/src/channels/channel-catalog.js";
import { loadConfig, saveGlobalConfig, type FinanfaConfig } from "@finanfa/core/src/core/config.js";
import { fetchWithRetry } from "@finanfa/core/src/channels/retry-fetch.js";

// Captured once, at module load — before applyPersistedChannelSecrets ever
// runs — so this reflects exactly what the shell that started the server
// actually exported, never a value this module later writes into
// process.env itself. Read-only from here on; used to answer "would saving
// a value here actually take effect", since a real environment variable
// always wins over anything persisted through this API (same precedence
// core/config.ts already documents for provider/model/apiKey).
const REAL_ENV_KEYS = new Set<string>();
for (const channel of CHANNEL_CATALOG) {
  for (const field of channel.fields) {
    if (process.env[field.key] !== undefined) REAL_ENV_KEYS.add(field.key);
  }
}

/** Applies every persisted channel field into process.env, filling gaps only — never overwrites a real environment variable. Called once at server startup. */
export function applyPersistedChannelSecrets(config: FinanfaConfig): void {
  for (const [, fields] of Object.entries(config.channels ?? {})) {
    for (const [key, value] of Object.entries(fields)) {
      if (!REAL_ENV_KEYS.has(key) && value) process.env[key] = value;
    }
  }
}

interface ChannelStatusField {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  configured: boolean;
  /** true when a real environment variable (not this config) is what's actually in effect — editing this field here won't change anything until that env var is unset. */
  envOverride: boolean;
}

// Set once startCloudflareTunnel (see cloudflare-tunnel.ts) actually
// resolves a public URL — undefined until then, and always undefined
// unless FINANFA_TUNNEL was set at startup. Every webhook-based channel
// needs a real public HTTPS URL, which req.get("host") only happens to be
// when someone's *browsing the UI itself* through that same tunnel — most
// of the time (the UI opened via plain localhost) it isn't, so this takes
// priority whenever it's known.
let publicTunnelUrl: string | undefined;

export function setPublicTunnelUrl(url: string): void {
  publicTunnelUrl = url;
}

function baseUrlFor(req: { protocol: string; get: (name: string) => string | undefined }): string {
  if (publicTunnelUrl) return publicTunnelUrl;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

export function registerChannelsConfigRoutes(app: Express): void {
  app.get("/api/tunnel-url", (_req, res) => {
    res.json({ url: publicTunnelUrl });
  });

  app.get("/api/channels-config", (req, res) => {
    const base = baseUrlFor(req);
    const channels = CHANNEL_CATALOG.map((channel) => {
      const fields: ChannelStatusField[] = channel.fields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: Boolean(f.secret),
        placeholder: f.placeholder,
        configured: Boolean(process.env[f.key]),
        envOverride: REAL_ENV_KEYS.has(f.key),
      }));
      return {
        id: channel.id,
        name: channel.name,
        setupNote: channel.setupNote,
        webhookPaths: channel.webhookPaths?.map((w) => ({ label: w.label, url: `${base}${w.path}` })),
        fields,
        configured: fields.every((f) => f.configured),
      };
    });
    res.json({ channels });
  });

  app.post("/api/channels-config/:id", async (req, res) => {
    const channel = CHANNEL_CATALOG.find((c) => c.id === req.params.id);
    if (!channel) {
      res.status(404).json({ error: `Unknown channel: ${req.params.id}` });
      return;
    }
    const body = req.body as Record<string, string>;
    const config = await loadConfig(process.cwd());
    const channels = { ...config.channels };
    const fields = { ...channels[channel.id] };

    for (const field of channel.fields) {
      if (!(field.key in body)) continue;
      const value = body[field.key]?.trim() ?? "";
      if (value) fields[field.key] = value;
      else delete fields[field.key];
      // Only reflects into process.env when no real environment variable
      // already governs this field — see REAL_ENV_KEYS above.
      if (!REAL_ENV_KEYS.has(field.key)) {
        if (value) process.env[field.key] = value;
        else delete process.env[field.key];
      }
    }
    channels[channel.id] = fields;
    await saveGlobalConfig({ ...config, channels });
    res.json({ ok: true });
  });

  // Real, reported friction: registering Discord's /ask slash command
  // requires a separate authenticated PUT to Discord's own REST API (see
  // docs/channels.md) — done here server-side with the just-saved bot
  // token/application id instead of asking the user to run a curl command
  // by hand.
  app.post("/api/channels-config/discord/register-command", async (req, res) => {
    const applicationId = process.env.DISCORD_APPLICATION_ID;
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!applicationId || !botToken) {
      res.status(400).json({ error: "Set Application ID and Bot Token first." });
      return;
    }
    try {
      const { response, bodyText } = await fetchWithRetry(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
        method: "PUT",
        headers: { Authorization: `Bot ${botToken}`, "content-type": "application/json" },
        body: JSON.stringify([
          {
            name: "ask",
            description: "Ask the agent something",
            options: [
              { name: "message", description: "Your message", type: 3, required: true },
              { name: "image", description: "An image to include", type: 11, required: false },
            ],
          },
        ]),
      });
      if (!response.ok) {
        res.status(502).json({ error: `Discord returned HTTP ${response.status}: ${bodyText.slice(0, 300)}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: `Failed to reach Discord: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
