import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import {
  oidcConfigFromEnv,
  discoverOidcEndpoints,
  generatePkcePair,
  generateOidcState,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  fetchOidcUserInfo,
  OidcStateStore,
  type OidcConfig,
  type OidcEndpoints,
} from "../src/oidc.js";

describe("oidcConfigFromEnv", () => {
  it("returns undefined unless issuer/clientId/redirectUri are all set", () => {
    expect(oidcConfigFromEnv({})).toBeUndefined();
    expect(oidcConfigFromEnv({ FINANFA_WEB_OIDC_ISSUER: "https://x" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a config from real env-var-shaped input, stripping a trailing slash from the issuer", () => {
    expect(
      oidcConfigFromEnv({
        FINANFA_WEB_OIDC_ISSUER: "https://accounts.example.com/",
        FINANFA_WEB_OIDC_CLIENT_ID: "client-1",
        FINANFA_WEB_OIDC_CLIENT_SECRET: "secret-1",
        FINANFA_WEB_OIDC_REDIRECT_URI: "https://app.example.com/api/auth/oidc/callback",
      } as NodeJS.ProcessEnv),
    ).toEqual({ issuer: "https://accounts.example.com", clientId: "client-1", clientSecret: "secret-1", redirectUri: "https://app.example.com/api/auth/oidc/callback" });
  });
});

describe("generatePkcePair", () => {
  it("produces a real S256 challenge derived from the verifier", () => {
    const { verifier, challenge } = generatePkcePair();
    const expected = createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("produces a different pair on every call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("generateOidcState", () => {
  it("produces a different state on every call", () => {
    expect(generateOidcState()).not.toBe(generateOidcState());
  });
});

describe("buildAuthorizationUrl", () => {
  it("builds a real authorization URL with every required PKCE/OIDC parameter", () => {
    const endpoints: OidcEndpoints = { authorizationEndpoint: "https://accounts.example.com/authorize", tokenEndpoint: "x", userinfoEndpoint: "x" };
    const config: OidcConfig = { issuer: "https://accounts.example.com", clientId: "client-1", redirectUri: "https://app.example.com/callback" };
    const url = new URL(buildAuthorizationUrl(endpoints, config, "state-1", "challenge-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("openid");
  });
});

describe("OidcStateStore", () => {
  it("consumes a state exactly once, returning its verifier the first time and undefined after", () => {
    const store = new OidcStateStore();
    const { state, verifier } = store.create();
    expect(store.consume(state)).toBe(verifier);
    expect(store.consume(state)).toBeUndefined();
  });

  it("returns undefined for a state that was never created", () => {
    expect(new OidcStateStore().consume("not-a-real-state")).toBeUndefined();
  });
});

describe("discoverOidcEndpoints / exchangeCodeForToken / fetchOidcUserInfo (real local HTTP server speaking the OIDC discovery/token/userinfo shape)", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastTokenRequestBody: string | undefined;
  let tokenResponseOverride: { status: number; body: unknown } | undefined;
  let userinfoResponseOverride: { status: number; body: unknown } | undefined;
  let lastUserinfoAuthHeader: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/.well-known/openid-configuration") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
              userinfo_endpoint: `${baseUrl}/userinfo`,
            }),
          );
          return;
        }
        if (req.url === "/token") {
          lastTokenRequestBody = body;
          const r = tokenResponseOverride ?? { status: 200, body: { access_token: "real-looking-access-token", token_type: "Bearer" } };
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.body));
          return;
        }
        if (req.url === "/userinfo") {
          lastUserinfoAuthHeader = req.headers.authorization;
          const r = userinfoResponseOverride ?? { status: 200, body: { sub: "user-123", email: "alice@example.com" } };
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.body));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("discoverOidcEndpoints reads the real discovery document", async () => {
    const endpoints = await discoverOidcEndpoints(baseUrl);
    expect(endpoints).toEqual({ authorizationEndpoint: `${baseUrl}/authorize`, tokenEndpoint: `${baseUrl}/token`, userinfoEndpoint: `${baseUrl}/userinfo` });
  });

  it("exchangeCodeForToken posts the real PKCE verifier/code/client_id and returns the real access token", async () => {
    const endpoints = await discoverOidcEndpoints(baseUrl);
    const config: OidcConfig = { issuer: baseUrl, clientId: "client-1", clientSecret: "secret-1", redirectUri: "https://app.example.com/callback" };
    const result = await exchangeCodeForToken(endpoints, config, "auth-code-1", "verifier-1");
    expect(result).toEqual({ ok: true, accessToken: "real-looking-access-token" });

    const sentParams = new URLSearchParams(lastTokenRequestBody);
    expect(sentParams.get("grant_type")).toBe("authorization_code");
    expect(sentParams.get("code")).toBe("auth-code-1");
    expect(sentParams.get("code_verifier")).toBe("verifier-1");
    expect(sentParams.get("client_id")).toBe("client-1");
    expect(sentParams.get("client_secret")).toBe("secret-1");
    expect(sentParams.get("redirect_uri")).toBe("https://app.example.com/callback");
  });

  it("exchangeCodeForToken reports a real token-endpoint error instead of throwing", async () => {
    tokenResponseOverride = { status: 400, body: { error: "invalid_grant", error_description: "Code has expired" } };
    const endpoints = await discoverOidcEndpoints(baseUrl);
    const config: OidcConfig = { issuer: baseUrl, clientId: "client-1", redirectUri: "https://app.example.com/callback" };
    const result = await exchangeCodeForToken(endpoints, config, "expired-code", "verifier-1");
    expect(result).toEqual({ ok: false, error: "Code has expired" });
    tokenResponseOverride = undefined;
  });

  it("fetchOidcUserInfo sends the real Bearer access token and prefers email over sub", async () => {
    const endpoints = await discoverOidcEndpoints(baseUrl);
    const result = await fetchOidcUserInfo(endpoints, "real-looking-access-token");
    expect(result).toEqual({ ok: true, username: "alice@example.com" });
    expect(lastUserinfoAuthHeader).toBe("Bearer real-looking-access-token");
  });

  it("fetchOidcUserInfo falls back to sub when the provider gives no email", async () => {
    userinfoResponseOverride = { status: 200, body: { sub: "user-456" } };
    const endpoints = await discoverOidcEndpoints(baseUrl);
    const result = await fetchOidcUserInfo(endpoints, "token");
    expect(result).toEqual({ ok: true, username: "user-456" });
    userinfoResponseOverride = undefined;
  });

  it("fetchOidcUserInfo reports a real userinfo-endpoint error instead of throwing", async () => {
    userinfoResponseOverride = { status: 401, body: { error: "invalid_token" } };
    const endpoints = await discoverOidcEndpoints(baseUrl);
    const result = await fetchOidcUserInfo(endpoints, "expired-token");
    expect(result.ok).toBe(false);
    userinfoResponseOverride = undefined;
  });
});
