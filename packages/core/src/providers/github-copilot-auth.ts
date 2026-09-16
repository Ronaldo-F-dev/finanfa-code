// GitHub's OAuth Device Authorization Flow (RFC 8628) — the same mechanism
// GitHub's own CLI (`gh auth login`) and third-party Copilot clients use,
// since there's no way to type a client secret into a CLI safely. Two
// steps: request a device code (the user visits a URL and enters it), then
// poll until they've actually done that. The resulting GitHub OAuth token
// is what github-copilot-provider.ts exchanges (repeatedly — it expires
// fast) for a short-lived Copilot API token; it is NOT itself a Copilot
// token and is never sent straight to api.githubcopilot.com.
//
// This client_id is GitHub Copilot's own public OAuth App id (the same one
// copilot.vim and other open, non-Microsoft-IDE Copilot clients use to
// register a device) — a client_id is not a secret; nothing here embeds
// GitHub's actual client secret, which the device flow never needs.
export const GITHUB_COPILOT_CLIENT_ID = "01ab8ac9400c4e429b23";

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds to wait between poll attempts — GitHub's own suggested pace, not a fixed constant here. */
  intervalSeconds: number;
  expiresInSeconds: number;
}

interface RawDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function requestDeviceCode(clientId = GITHUB_COPILOT_CLIENT_ID, baseUrl = "https://github.com"): Promise<DeviceCodeResponse> {
  const response = await fetch(`${baseUrl}/login/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "read:user" }),
  });
  if (!response.ok) {
    throw new Error(`GitHub device authorization request failed (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as RawDeviceCodeResponse;
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    intervalSeconds: data.interval,
    expiresInSeconds: data.expires_in,
  };
}

export type DeviceAuthorizationCheck =
  | { status: "authorized"; accessToken: string }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" | "expired" };

interface RawTokenResponse {
  access_token?: string;
  error?: string;
}

/** One poll attempt (see pollForAccessToken for the actual wait loop) — never throws on the ordinary "not yet" outcomes, only on a genuine HTTP-level failure. */
export async function checkDeviceAuthorization(deviceCode: string, clientId = GITHUB_COPILOT_CLIENT_ID, baseUrl = "https://github.com"): Promise<DeviceAuthorizationCheck> {
  const response = await fetch(`${baseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  if (!response.ok) {
    throw new Error(`GitHub device-token poll failed (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as RawTokenResponse;
  if (data.access_token) return { status: "authorized", accessToken: data.access_token };
  if (data.error === "authorization_pending") return { status: "pending" };
  if (data.error === "slow_down") return { status: "slow_down" };
  if (data.error === "expired_token") return { status: "expired" };
  return { status: "denied" };
}

/**
 * Polls until the user has actually authorized the device (or it's clear
 * they won't) — `sleep` is injectable so a test can drive this without a
 * real wall-clock wait.
 */
export async function pollForAccessToken(
  deviceCode: string,
  intervalSeconds: number,
  clientId = GITHUB_COPILOT_CLIENT_ID,
  baseUrl = "https://github.com",
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  let waitMs = intervalSeconds * 1000;
  for (;;) {
    await sleep(waitMs);
    const check = await checkDeviceAuthorization(deviceCode, clientId, baseUrl);
    if (check.status === "authorized") return check.accessToken;
    if (check.status === "denied") throw new Error("GitHub Copilot device authorization was denied.");
    if (check.status === "expired") throw new Error("GitHub Copilot device code expired before it was authorized — run the setup step again.");
    if (check.status === "slow_down") waitMs += 5000;
  }
}
