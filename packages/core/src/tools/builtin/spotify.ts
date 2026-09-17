import type { ToolDefinition } from "../../core/types.js";
import { fetchWithRetry } from "../../channels/retry-fetch.js";

// A real connector tool for Spotify (the last of the productivity
// integrations explicitly named alongside Notion/Trello as a gap
// relative to a comparable project we audited against). Spotify's Web
// API uses OAuth access tokens that expire in ~1 hour, unlike Notion's/
// Trello's long-lived static credentials — so this needs a one-time
// refresh token (obtained once via Spotify's standard Authorization Code
// flow, outside this project's scope to automate) and exchanges it for a
// fresh access token on every call, rather than caching one across calls
// (simpler, and the token endpoint is cheap/not rate-limit-sensitive for
// this usage pattern).
const SPOTIFY_ACCOUNTS_BASE = "https://accounts.spotify.com";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function spotifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SpotifyConfig | undefined {
  const clientId = env.SPOTIFY_CLIENT_ID;
  const clientSecret = env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = env.SPOTIFY_REFRESH_TOKEN;
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : undefined;
}

export type SpotifyResult<T> = ({ ok: true } & T) | { ok: false; error: string };

interface SpotifyErrorBody {
  error?: string | { message?: string };
  error_description?: string;
}

/** Exchanges the configured long-lived refresh token for a fresh, short-lived access token via Spotify's standard OAuth token endpoint (client credentials sent as HTTP Basic auth, per Spotify's own docs). */
export async function getSpotifyAccessToken(config: SpotifyConfig, accountsBaseUrl = SPOTIFY_ACCOUNTS_BASE): Promise<SpotifyResult<{ accessToken: string }>> {
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${accountsBaseUrl}/api/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: config.refreshToken }).toString(),
    }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Spotify: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: (SpotifyErrorBody & { access_token?: string }) | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `Spotify returned an unparseable token response (HTTP ${response.status}).` };
  }
  if (!response.ok || !data?.access_token) {
    return { ok: false, error: data?.error_description ?? (typeof data?.error === "string" ? data.error : undefined) ?? `Spotify auth error (HTTP ${response.status})` };
  }
  return { ok: true, accessToken: data.access_token };
}

interface SpotifyTrackItem {
  name: string;
  artists?: { name: string }[];
}

/** Reads the currently playing track (or reports nothing is playing — Spotify's own API returns a real, bodyless 204 for that, not an error). */
export async function getSpotifyNowPlaying(
  config: SpotifyConfig,
  apiBaseUrl = SPOTIFY_API_BASE,
  accountsBaseUrl = SPOTIFY_ACCOUNTS_BASE,
): Promise<SpotifyResult<{ text: string }>> {
  const token = await getSpotifyAccessToken(config, accountsBaseUrl);
  if (!token.ok) return token;

  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${apiBaseUrl}/me/player/currently-playing`, { headers: { Authorization: `Bearer ${token.accessToken}` } }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Spotify: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (response.status === 204) return { ok: true, text: "Nothing is currently playing." };

  let data: (SpotifyErrorBody & { item?: SpotifyTrackItem; is_playing?: boolean }) | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `Spotify returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok) {
    const message = typeof data?.error === "object" ? data.error?.message : undefined;
    return { ok: false, error: message ?? `Spotify API error (HTTP ${response.status})` };
  }
  if (!data?.item) return { ok: true, text: "Nothing is currently playing." };
  const artists = data.item.artists?.map((a) => a.name).join(", ") ?? "unknown artist";
  return { ok: true, text: `${data.is_playing ? "Playing" : "Paused"}: "${data.item.name}" by ${artists}` };
}

export type SpotifyPlaybackAction = "play" | "pause" | "next" | "previous";

const PLAYBACK_ENDPOINTS: Record<SpotifyPlaybackAction, { path: string; method: string }> = {
  play: { path: "play", method: "PUT" },
  pause: { path: "pause", method: "PUT" },
  next: { path: "next", method: "POST" },
  previous: { path: "previous", method: "POST" },
};

/** Controls playback on the user's currently active device — Spotify reports a clear error (no active device, no active Premium subscription, ...) rather than this needing its own validation. */
export async function controlSpotifyPlayback(
  config: SpotifyConfig,
  action: SpotifyPlaybackAction,
  apiBaseUrl = SPOTIFY_API_BASE,
  accountsBaseUrl = SPOTIFY_ACCOUNTS_BASE,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = await getSpotifyAccessToken(config, accountsBaseUrl);
  if (!token.ok) return token;

  const { path, method } = PLAYBACK_ENDPOINTS[action];
  let response: Response;
  let bodyText: string;
  try {
    ({ response, bodyText } = await fetchWithRetry(`${apiBaseUrl}/me/player/${path}`, { method, headers: { Authorization: `Bearer ${token.accessToken}` } }));
  } catch (err) {
    return { ok: false, error: `Failed to reach Spotify: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (response.ok) return { ok: true };

  let data: SpotifyErrorBody | undefined;
  try {
    data = JSON.parse(bodyText) as SpotifyErrorBody;
  } catch {
    data = undefined;
  }
  const message = typeof data?.error === "object" ? data.error?.message : undefined;
  return { ok: false, error: message ?? `Spotify API error (HTTP ${response.status})` };
}

export function createGetSpotifyNowPlayingTool(config: SpotifyConfig | undefined, apiBaseUrl = SPOTIFY_API_BASE, accountsBaseUrl = SPOTIFY_ACCOUNTS_BASE): ToolDefinition<Record<string, never>> {
  return {
    name: "get_spotify_now_playing",
    description:
      "Report the track currently playing (or paused) on the user's Spotify account, via the real Spotify Web " +
      "API. Requires SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN (from a one-time " +
      "Spotify OAuth authorization) to be configured as environment variables.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      if (!config) {
        return { content: "Spotify is not configured — set SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/SPOTIFY_REFRESH_TOKEN as environment variables to enable get_spotify_now_playing.", isError: true };
      }
      const result = await getSpotifyNowPlaying(config, apiBaseUrl, accountsBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: result.text, isError: false };
    },
  };
}

interface ControlSpotifyPlaybackInput {
  action: SpotifyPlaybackAction;
}

export function createControlSpotifyPlaybackTool(
  config: SpotifyConfig | undefined,
  apiBaseUrl = SPOTIFY_API_BASE,
  accountsBaseUrl = SPOTIFY_ACCOUNTS_BASE,
): ToolDefinition<ControlSpotifyPlaybackInput> {
  return {
    name: "control_spotify_playback",
    description:
      "Control real Spotify playback (play/pause/skip to the next or previous track) on the user's currently " +
      "active device, via the real Spotify Web API. Requires SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/" +
      "SPOTIFY_REFRESH_TOKEN to be configured as environment variables. " +
      "IMPORTANT: this changes real, audible playback on a real device — confirm with the user before calling " +
      "this unless they've explicitly asked for this exact action.",
    riskLevel: "ask",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["play", "pause", "next", "previous"] } },
      required: ["action"],
    },
    describeCall: (input) => `${input.action} Spotify playback`,
    async handler(input) {
      if (!config) {
        return { content: "Spotify is not configured — set SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET/SPOTIFY_REFRESH_TOKEN as environment variables to enable control_spotify_playback.", isError: true };
      }
      const result = await controlSpotifyPlayback(config, input.action, apiBaseUrl, accountsBaseUrl);
      if (!result.ok) return { content: result.error, isError: true };
      return { content: `Spotify playback: ${input.action}.`, isError: false };
    },
  };
}
