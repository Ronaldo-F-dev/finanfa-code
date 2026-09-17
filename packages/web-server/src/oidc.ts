import { randomBytes, createHash } from "node:crypto";

// Real OIDC-based SSO for Gateway — "log in with Google/Okta/any OIDC
// provider" instead of (or alongside) a password. Standard Authorization
// Code + PKCE flow: OIDC discovery (the provider's own `/.well-known/
// openid-configuration`), a real PKCE challenge (no client secret needed
// for the code exchange itself, though most providers still issue one
// for a confidential/server-side client like this one, so it's supported
// too), and the real code-for-token exchange.
//
// Deliberately trusts the provider's userinfo endpoint for the user's
// identity rather than verifying the ID token's JWT signature locally
// (which would need fetching the provider's JWKS and importing an RSA/EC
// public key — doable with node:crypto's own JWK import, but a real step
// up in complexity over this project's existing hand-rolled crypto
// (Ed25519 signing, HMAC webhook signatures) for a check that fetching
// userinfo over TLS with the just-obtained access token already
// substitutes for in practice: an attacker without a valid access token
// can't get a userinfo response back regardless of whether the ID token
// itself was separately checked. A real, honest scope choice, not a
// silent gap — most minimal OIDC clients make this exact trade.
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | undefined {
  const issuer = env.FINANFA_WEB_OIDC_ISSUER;
  const clientId = env.FINANFA_WEB_OIDC_CLIENT_ID;
  const redirectUri = env.FINANFA_WEB_OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !redirectUri) return undefined;
  return { issuer: issuer.replace(/\/+$/, ""), clientId, clientSecret: env.FINANFA_WEB_OIDC_CLIENT_SECRET, redirectUri };
}

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
}

export async function discoverOidcEndpoints(issuer: string): Promise<OidcEndpoints> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery failed (HTTP ${response.status}) for issuer ${issuer}`);
  const data = (await response.json()) as { authorization_endpoint?: string; token_endpoint?: string; userinfo_endpoint?: string };
  if (!data.authorization_endpoint || !data.token_endpoint || !data.userinfo_endpoint) {
    throw new Error(`OIDC discovery document for ${issuer} is missing a required endpoint.`);
  }
  return { authorizationEndpoint: data.authorization_endpoint, tokenEndpoint: data.token_endpoint, userinfoEndpoint: data.userinfo_endpoint };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A real PKCE (RFC 7636) verifier/challenge pair — S256 only (plain is a weaker fallback most providers don't even accept anymore). */
export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateOidcState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizationUrl(endpoints: OidcEndpoints, config: OidcConfig, state: string, codeChallenge: string): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type ExchangeCodeResult = { ok: true; accessToken: string } | { ok: false; error: string };

export async function exchangeCodeForToken(endpoints: OidcEndpoints, config: OidcConfig, code: string, codeVerifier: string): Promise<ExchangeCodeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);

  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(endpoints.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    bodyText = await response.text();
  } catch (err) {
    return { ok: false, error: `Failed to reach the OIDC token endpoint: ${err instanceof Error ? err.message : String(err)}` };
  }
  let data: { access_token?: string; error_description?: string; error?: string } | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `OIDC token endpoint returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok || !data?.access_token) return { ok: false, error: data?.error_description ?? data?.error ?? `OIDC token exchange failed (HTTP ${response.status})` };
  return { ok: true, accessToken: data.access_token };
}

export type FetchUserInfoResult = { ok: true; username: string } | { ok: false; error: string };

/** Derives a stable username from the provider's userinfo response — prefers email (human-readable, what a login page would show), falls back to `sub` (always present per the OIDC spec) when the provider doesn't return one. */
export async function fetchOidcUserInfo(endpoints: OidcEndpoints, accessToken: string): Promise<FetchUserInfoResult> {
  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(endpoints.userinfoEndpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
    bodyText = await response.text();
  } catch (err) {
    return { ok: false, error: `Failed to reach the OIDC userinfo endpoint: ${err instanceof Error ? err.message : String(err)}` };
  }
  let data: { sub?: string; email?: string } | undefined;
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    return { ok: false, error: `OIDC userinfo endpoint returned an unparseable response (HTTP ${response.status}).` };
  }
  if (!response.ok) return { ok: false, error: `OIDC userinfo request failed (HTTP ${response.status})` };
  const username = data?.email ?? data?.sub;
  if (!username) return { ok: false, error: "OIDC userinfo response had neither an email nor a sub claim." };
  return { ok: true, username };
}

// Pending authorization attempts (state -> PKCE verifier), single-use and
// short-lived — protects against CSRF (an attacker can't complete a
// callback without the exact state THIS server generated) and lets the
// callback recover the verifier it needs for the token exchange without
// a cookie/session existing yet (there's no user identity at all until
// the callback succeeds).
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;

export class OidcStateStore {
  private readonly pending = new Map<string, { verifier: string; expiresAt: number }>();

  create(): { state: string; verifier: string; challenge: string } {
    const state = generateOidcState();
    const { verifier, challenge } = generatePkcePair();
    this.pending.set(state, { verifier, expiresAt: Date.now() + PENDING_STATE_TTL_MS });
    return { state, verifier, challenge };
  }

  /** Consumes (single-use) and returns the verifier for `state`, or undefined for an unknown/expired/already-used state. */
  consume(state: string): string | undefined {
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry || Date.now() > entry.expiresAt) return undefined;
    return entry.verifier;
  }
}
