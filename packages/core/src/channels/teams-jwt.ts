import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";

// Microsoft Teams (via Azure Bot Service/Bot Framework) authenticates
// its own inbound webhook calls with a real JWT
// (https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication),
// signed with a key that ROTATES — unlike every other channel here
// (a static shared secret or HMAC key), verifying this properly means a
// real JWKS fetch + RS256 signature check, not a shared-secret compare.
// This is genuinely more machinery than this project's own OIDC login
// flow uses (oidc.ts deliberately trusts the provider's userinfo
// endpoint instead of verifying an ID token's JWT signature locally) —
// here there's no equivalent "ask the platform itself" shortcut available
// for a webhook push, so the real verification is done in full: fetch the
// public keys Microsoft publishes, find the one that signed this token,
// verify the RS256 signature, and check issuer/audience/expiry.
//
// Deliberately scoped to what Bot Framework's own SDK validates at its
// core (issuer, audience = this bot's own app id, signature, exp/nbf) —
// not every edge case its full connector auth covers (the Bot Framework
// Emulator's own dev-time flow, government-cloud endpoints, the
// serviceUrl-embedded-in-token check some channels add). A real,
// disclosed scope boundary, not a silent gap.
const DEFAULT_OPENID_CONFIG_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const EXPECTED_ISSUER = "https://api.botframework.com";
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // keys rotate rarely; a legitimate rotation is handled by the force-refresh-on-unknown-kid path below, not by a short TTL
const CLOCK_SKEW_SECONDS = 5 * 60;

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface JwksCache {
  keysByKid: Map<string, Jwk>;
  fetchedAtMs: number;
}

let cache: JwksCache | undefined;

/** Test-only: drops the cached JWKS so a test doesn't see a previous test's cached keys. */
export function resetTeamsJwksCacheForTests(): void {
  cache = undefined;
}

async function fetchJwks(openIdConfigUrl: string): Promise<{ ok: true; keysByKid: Map<string, Jwk> } | { ok: false; error: string }> {
  try {
    const configResponse = await fetch(openIdConfigUrl);
    if (!configResponse.ok) return { ok: false, error: `Failed to fetch Bot Framework OpenID config (HTTP ${configResponse.status}).` };
    const config = (await configResponse.json()) as { jwks_uri?: string };
    if (!config.jwks_uri) return { ok: false, error: "Bot Framework OpenID config had no jwks_uri." };

    const jwksResponse = await fetch(config.jwks_uri);
    if (!jwksResponse.ok) return { ok: false, error: `Failed to fetch Bot Framework JWKS (HTTP ${jwksResponse.status}).` };
    const jwks = (await jwksResponse.json()) as { keys?: Jwk[] };
    const keysByKid = new Map((jwks.keys ?? []).filter((k): k is Jwk & { kid: string } => typeof k.kid === "string").map((k) => [k.kid, k]));
    return { ok: true, keysByKid };
  } catch (err) {
    return { ok: false, error: `Failed to reach Microsoft's Bot Framework auth endpoints: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Returns the cached JWKS, refetching if it's past its TTL or (forceRefresh) a kid wasn't found in it — handles a real key rotation without waiting out the full TTL. */
async function getJwks(openIdConfigUrl: string, forceRefresh: boolean): Promise<{ ok: true; keysByKid: Map<string, Jwk> } | { ok: false; error: string }> {
  if (cache && !forceRefresh && Date.now() - cache.fetchedAtMs < JWKS_CACHE_TTL_MS) return { ok: true, keysByKid: cache.keysByKid };
  const result = await fetchJwks(openIdConfigUrl);
  if (!result.ok) return result;
  cache = { keysByKid: result.keysByKid, fetchedAtMs: Date.now() };
  return result;
}

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface DecodedJwt {
  header: { kid?: string; alg?: string };
  payload: { iss?: string; aud?: string; exp?: number; nbf?: number };
  signingInput: string;
  signature: Buffer;
}

function decodeJwt(token: string): DecodedJwt | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const header = JSON.parse(base64UrlDecode(headerB64!).toString("utf-8")) as DecodedJwt["header"];
    const payload = JSON.parse(base64UrlDecode(payloadB64!).toString("utf-8")) as DecodedJwt["payload"];
    return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature: base64UrlDecode(signatureB64!) };
  } catch {
    return undefined;
  }
}

export type VerifyTeamsTokenResult = { ok: true } | { ok: false; error: string };

/**
 * Verifies a real inbound Bot Framework JWT: RS256 signature against
 * Microsoft's own published keys (fetched via the real OpenID config +
 * JWKS endpoints, cached), issuer, audience (must be this bot's own
 * Microsoft App ID), and expiry/not-before (with a small clock-skew
 * allowance).
 */
export async function verifyTeamsToken(token: string, expectedAppId: string, openIdConfigUrl = DEFAULT_OPENID_CONFIG_URL): Promise<VerifyTeamsTokenResult> {
  const decoded = decodeJwt(token);
  if (!decoded) return { ok: false, error: "Malformed Bot Framework token." };
  if (decoded.header.alg !== "RS256") return { ok: false, error: `Unsupported token algorithm "${decoded.header.alg}".` };
  if (!decoded.header.kid) return { ok: false, error: "Bot Framework token has no kid." };

  let jwks = await getJwks(openIdConfigUrl, false);
  if (!jwks.ok) return jwks;
  let jwk = jwks.keysByKid.get(decoded.header.kid);
  if (!jwk) {
    // A kid we don't recognize could mean a real, legitimate key
    // rotation — force one fresh fetch before giving up, rather than
    // waiting out the full cache TTL.
    jwks = await getJwks(openIdConfigUrl, true);
    if (!jwks.ok) return jwks;
    jwk = jwks.keysByKid.get(decoded.header.kid);
  }
  if (!jwk) return { ok: false, error: `No matching Bot Framework signing key found for kid "${decoded.header.kid}".` };

  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch (err) {
    return { ok: false, error: `Bot Framework signing key is malformed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const validSignature = cryptoVerify("RSA-SHA256", Buffer.from(decoded.signingInput), publicKey, decoded.signature);
  if (!validSignature) return { ok: false, error: "Bot Framework token signature is invalid." };

  if (decoded.payload.iss !== EXPECTED_ISSUER) return { ok: false, error: `Unexpected token issuer "${decoded.payload.iss}".` };
  if (decoded.payload.aud !== expectedAppId) return { ok: false, error: "Token audience doesn't match this bot's own Microsoft App ID." };

  const nowSeconds = Date.now() / 1000;
  if (typeof decoded.payload.exp === "number" && nowSeconds > decoded.payload.exp + CLOCK_SKEW_SECONDS) return { ok: false, error: "Bot Framework token has expired." };
  if (typeof decoded.payload.nbf === "number" && nowSeconds < decoded.payload.nbf - CLOCK_SKEW_SECONDS) return { ok: false, error: "Bot Framework token is not yet valid." };

  return { ok: true };
}
