// Feishu/Lark bots authenticate outbound API calls with a real, short-
// lived tenant_access_token (https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)
// — obtained via a real API call (app_id + app_secret, NOT sent as a
// static bot token the way Telegram/LINE's own outbound auth works),
// and expiring after ~2 hours. Cached in memory, keyed by app_id (no
// persistence needed — the same "ephemeral, doesn't need to survive a
// restart" reasoning as update-dedup.ts; a restart just fetches a fresh
// one), refreshed a safety margin before its real expiry rather than
// waiting for a request to fail against an already-expired token.
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export interface FeishuAppConfig {
  appId: string;
  appSecret: string;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedToken>();

/** Test-only: drops every cached token so a test doesn't see a previous test's cached value. */
export function resetFeishuTokenCacheForTests(): void {
  cache.clear();
}

interface TenantAccessTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

export type FeishuTokenResult = { ok: true; token: string } | { ok: false; error: string };

/** Returns a real, currently-valid tenant_access_token — from cache if one hasn't expired yet, otherwise fetching a fresh one first. */
export async function getFeishuTenantAccessToken(config: FeishuAppConfig, apiBaseUrl = "https://open.feishu.cn"): Promise<FeishuTokenResult> {
  const cached = cache.get(config.appId);
  if (cached && cached.expiresAtMs > Date.now()) return { ok: true, token: cached.token };

  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(`${apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    bodyText = await response.text();
  } catch (err) {
    return { ok: false, error: `Failed to reach Feishu: ${err instanceof Error ? err.message : String(err)}` };
  }

  let data: TenantAccessTokenResponse;
  try {
    data = JSON.parse(bodyText) as TenantAccessTokenResponse;
  } catch {
    return { ok: false, error: `Feishu returned an unparseable response (HTTP ${response.status}).` };
  }

  if (!response.ok || data.code !== 0 || !data.tenant_access_token || !data.expire) {
    return { ok: false, error: data.msg ?? `Feishu auth error (HTTP ${response.status}, code ${data.code})` };
  }

  cache.set(config.appId, { token: data.tenant_access_token, expiresAtMs: Date.now() + data.expire * 1000 - EXPIRY_SAFETY_MARGIN_MS });
  return { ok: true, token: data.tenant_access_token };
}
