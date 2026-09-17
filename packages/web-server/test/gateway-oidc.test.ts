import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of Gateway's OIDC SSO login (see oidc.ts): a real
// fake OIDC provider (discovery + token + userinfo endpoints — the
// browser-redirect authorize step itself isn't driven by a real browser
// here, but nothing server-side depends on what that step actually
// rendered, only on the code it hands back to the real callback route)
// against the real web-server subprocess.

describe("Gateway OIDC SSO login (real subprocess, real fake OIDC provider)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  let providerServer: http.Server;
  let providerBaseUrl: string;
  let lastTokenRequestBody: string | undefined;

  beforeAll(async () => {
    providerServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/.well-known/openid-configuration") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              authorization_endpoint: `${providerBaseUrl}/authorize`,
              token_endpoint: `${providerBaseUrl}/token`,
              userinfo_endpoint: `${providerBaseUrl}/userinfo`,
            }),
          );
          return;
        }
        if (req.url === "/token") {
          lastTokenRequestBody = body;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "real-looking-access-token" }));
          return;
        }
        if (req.url === "/userinfo") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ sub: "user-123", email: "alice@example.com" }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    providerBaseUrl = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-oidc-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-oidc-home-"));
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify({ provider: "anthropic", apiKey: "unused-in-this-test" }));

    process.env.FINANFA_WEB_OIDC_ISSUER = providerBaseUrl;
    process.env.FINANFA_WEB_OIDC_CLIENT_ID = "test-client-id";
    process.env.FINANFA_WEB_OIDC_CLIENT_SECRET = "test-client-secret";
    // A real deployment's redirect_uri points back at its own public URL,
    // which (like the port) isn't known until after spawnWebServer returns
    // — but nothing here actually depends on it matching anything real
    // (this fake provider doesn't validate it against a registered value
    // the way a real one would), so a fixed placeholder is fine for
    // exercising the server's own client-side OIDC logic.
    process.env.FINANFA_WEB_OIDC_REDIRECT_URI = "http://127.0.0.1/api/auth/oidc/callback";
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    providerServer.close();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    for (const k of ["FINANFA_WEB_OIDC_ISSUER", "FINANFA_WEB_OIDC_CLIENT_ID", "FINANFA_WEB_OIDC_CLIENT_SECRET", "FINANFA_WEB_OIDC_REDIRECT_URI"]) delete process.env[k];
  });

  it("still 401s an unauthenticated /api/sessions request (OIDC-only mode is still gated)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/oidc/login redirects to the real provider's authorization endpoint with a real PKCE challenge", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/oidc/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${providerBaseUrl}/authorize`);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it(
    "GET /api/auth/oidc/callback completes the real flow and issues a real, usable session token",
    async () => {
      const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/oidc/login`, { redirect: "manual" });
      const authorizeUrl = new URL(loginRes.headers.get("location")!);
      const state = authorizeUrl.searchParams.get("state")!;

      const callbackRes = await fetch(`http://127.0.0.1:${port}/api/auth/oidc/callback?code=real-looking-auth-code&state=${state}`, { redirect: "manual" });
      expect(callbackRes.status).toBe(302);
      const redirectLocation = callbackRes.headers.get("location")!;
      expect(redirectLocation).toMatch(/^\/#token=.+&user=alice%40example\.com$/);

      const token = new URLSearchParams(redirectLocation.split("#")[1]).get("token")!;
      expect(token).toBeTruthy();

      // The token exchange the server made really carried the auth code
      // and a PKCE verifier — not just any request.
      const sentParams = new URLSearchParams(lastTokenRequestBody);
      expect(sentParams.get("code")).toBe("real-looking-auth-code");
      expect(sentParams.get("code_verifier")).toBeTruthy();

      // The issued token really authenticates a real REST request.
      const sessionsRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
      expect(sessionsRes.status).toBe(200);
    },
    15_000,
  );

  it("rejects a callback with an unknown/already-used state", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/oidc/callback?code=x&state=not-a-real-state`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});
