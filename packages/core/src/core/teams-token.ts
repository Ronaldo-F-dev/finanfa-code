// Bot Framework's own outbound auth: a real OAuth2 client_credentials
// token from Microsoft Entra ID (https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication#bot-to-connector),
// not a static bot token — same "fetch and cache a real, short-lived
// token" shape as feishu-token.ts's tenant_access_token, just via
// Microsoft's own OAuth2 endpoint instead of Feishu's bespoke one.
const TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const SCOPE = "https://api.botframework.com/.default";
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export interface TeamsAppConfig {
  appId: string;
  appPassword: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedToken>();

/** Test-only: drops every cached token so a test doesn't see a previous test's cached value. */
export function resetTeamsTokenCacheForTests(): void {
  cache.clear();
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export type TeamsTokenResult = { ok: true; token: string } | { ok: false; error: string };

/** Returns a real, currently-valid Bot Framework access token — from cache if one hasn't expired yet, otherwise fetching a fresh one first. */
export async function getTeamsAccessToken(config: TeamsAppConfig, tokenUrl = TOKEN_URL): Promise<TeamsTokenResult> {
  const cached = cache.get(config.appId);
  if (cached && cached.expiresAtMs > Date.now()) return { ok: true, token: cached.token };

  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.appId, client_secret: config.appPassword, scope: SCOPE }).toString(),
    });
    bodyText = await response.text();
  } catch (err) {
    return { ok: false, error: `Failed to reach Microsoft's token endpoint: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: TokenResponse;
  try {
    data = JSON.parse(bodyText) as TokenResponse;
  } catch {
    return { ok: false, error: `Microsoft's token endpoint returned an unparseable response (HTTP ${response.status}).` };
  }

  if (!response.ok || !data.access_token || !data.expires_in) {
    return { ok: false, error: data.error_description ?? data.error ?? `Microsoft token error (HTTP ${response.status})` };
  }

  cache.set(config.appId, { token: data.access_token, expiresAtMs: Date.now() + data.expires_in * 1000 - EXPIRY_SAFETY_MARGIN_MS });
  return { ok: true, token: data.access_token };
}
