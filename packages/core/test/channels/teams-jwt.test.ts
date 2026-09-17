import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { verifyTeamsToken, resetTeamsJwksCacheForTests } from "../../src/channels/teams-jwt.js";

const APP_ID = "00000000-0000-0000-0000-000000000001";
const ISSUER = "https://api.botframework.com";
const KID = "real-key-1";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt(privateKey: KeyObject, payload: Record<string, unknown>, opts: { kid?: string; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? KID };
  const headerB64 = base64Url(JSON.stringify(header));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

describe("verifyTeamsToken (real RSA keypair, real signed JWTs, real local HTTP server for the OpenID config/JWKS endpoints)", () => {
  let server: http.Server;
  let openIdConfigUrl: string;
  let publicKey: KeyObject;
  let privateKey: KeyObject;
  let otherPrivateKey: KeyObject;
  let jwksRequestCount: number;
  let currentKid: string;

  beforeAll(async () => {
    ({ publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }));
    ({ privateKey: otherPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }));
    currentKid = KID;

    server = http.createServer((req, res) => {
      if (req.url === "/openid-config") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jwks_uri: `${openIdConfigUrl.replace("/openid-config", "")}/jwks` }));
        return;
      }
      if (req.url === "/jwks") {
        jwksRequestCount++;
        const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: currentKid, use: "sig" }] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    openIdConfigUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openid-config`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    resetTeamsJwksCacheForTests();
    jwksRequestCount = 0;
    currentKid = KID;
  });

  function validPayload(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: ISSUER, aud: APP_ID, exp: now + 3600, nbf: now - 60, ...overrides };
  }

  it("accepts a real, correctly-signed, currently-valid token", async () => {
    const token = signJwt(privateKey, validPayload());
    const result = await verifyTeamsToken(token, APP_ID, openIdConfigUrl);
    expect(result).toEqual({ ok: true });
  });

  it("caches the JWKS — a second verification doesn't refetch it", async () => {
    await verifyTeamsToken(signJwt(privateKey, validPayload()), APP_ID, openIdConfigUrl);
    expect(jwksRequestCount).toBe(1);
    await verifyTeamsToken(signJwt(privateKey, validPayload()), APP_ID, openIdConfigUrl);
    expect(jwksRequestCount).toBe(1);
  });

  it("rejects a token signed with the WRONG private key (not the one published in the JWKS)", async () => {
    const token = signJwt(otherPrivateKey, validPayload());
    const result = await verifyTeamsToken(token, APP_ID, openIdConfigUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("signature");
  });

  it("rejects a token whose audience doesn't match this bot's own app id", async () => {
    const token = signJwt(privateKey, validPayload({ aud: "some-other-app-id" }));
    const result = await verifyTeamsToken(token, APP_ID, openIdConfigUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("audience");
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = signJwt(privateKey, validPayload({ iss: "https://not-really-bot-framework.example.com" }));
    const result = await verifyTeamsToken(token, APP_ID, openIdConfigUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("issuer");
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, validPayload({ exp: now - 3600 }));
    const result = await verifyTeamsToken(token, APP_ID, openIdConfigUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expired");
  });

  it("rejects a not-yet-valid token (nbf in the future)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, validPayload({ nbf: now + 3600 }));
    const result = await verifyTeamsToken(token, APP_ID, openIdConfigUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not yet valid");
  });

  it("rejects an unsupported algorithm instead of trying to verify it", async () => {
    const token = signJwt(privateKey, validPayload(), { alg: "none" });
    const result = await verifyTeamsToken(token, APP_ID, openIdConfigUrl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported token algorithm");
  });

  it("rejects a malformed token instead of throwing", async () => {
    const result = await verifyTeamsToken("not.a.jwt.at.all", APP_ID, openIdConfigUrl);
    expect(result.ok).toBe(false);
  });

  it("force-refetches the JWKS once when a token's kid isn't in the cached set (real key rotation), then succeeds", async () => {
    // First call caches the JWKS under the ORIGINAL kid.
    await verifyTeamsToken(signJwt(privateKey, validPayload()), APP_ID, openIdConfigUrl);
    expect(jwksRequestCount).toBe(1);

    // The "server" rotates its key id — a token signed with the SAME
    // real key but a new kid the cached JWKS doesn't know about yet.
    currentKid = "rotated-key-2";
    const rotatedToken = signJwt(privateKey, validPayload(), { kid: "rotated-key-2" });
    const result = await verifyTeamsToken(rotatedToken, APP_ID, openIdConfigUrl);
    expect(result).toEqual({ ok: true });
    expect(jwksRequestCount).toBe(2); // forced exactly one refetch, not a full cache bypass on every call
  });

  it("reports a real error when the OpenID config endpoint is unreachable, instead of throwing", async () => {
    const result = await verifyTeamsToken(signJwt(privateKey, validPayload()), APP_ID, "http://127.0.0.1:1/openid-config");
    expect(result.ok).toBe(false);
  });
});
