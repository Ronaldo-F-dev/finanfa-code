import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { FileOAuthClientProvider } from "../../src/mcp/oauth-provider.js";

describe("FileOAuthClientProvider", () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-oauth-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("exposes a redirect URL and public-client metadata matching it", () => {
    const provider = new FileOAuthClientProvider("github", 51799);
    expect(provider.redirectUrl).toBe("http://127.0.0.1:51799/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:51799/callback"]);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("round-trips client information and tokens to disk, scoped per server", async () => {
    const provider = new FileOAuthClientProvider("github");
    expect(await provider.clientInformation()).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();

    await provider.saveClientInformation({ client_id: "abc123" });
    await provider.saveTokens({ access_token: "tok_1", token_type: "bearer" });

    expect(await provider.clientInformation()).toEqual({ client_id: "abc123" });
    expect(await provider.tokens()).toEqual({ access_token: "tok_1", token_type: "bearer" });

    // A different server name must not see github's saved credentials.
    const other = new FileOAuthClientProvider("gmail");
    expect(await other.clientInformation()).toBeUndefined();
    expect(await other.tokens()).toBeUndefined();
  });

  it("stores and returns the PKCE code verifier for the current flow", () => {
    const provider = new FileOAuthClientProvider("github");
    expect(() => provider.codeVerifier()).toThrow(/No PKCE code verifier/);
    provider.saveCodeVerifier("verifier-xyz");
    expect(provider.codeVerifier()).toBe("verifier-xyz");
  });

  it("waitForCallback resolves with the authorization code from the redirect", async () => {
    const port = 51798;
    const provider = new FileOAuthClientProvider("github", port);
    const waiting = provider.waitForCallback();

    // Give the callback server a tick to start listening.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/callback?code=abc123&state=xyz`, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });

    await expect(waiting).resolves.toBe("abc123");
  });

  it("waitForCallback rejects when the redirect carries an error param", async () => {
    const port = 51797;
    const provider = new FileOAuthClientProvider("github", port);
    const waiting = provider.waitForCallback();
    // Attach the rejection assertion immediately so it's never briefly
    // "unhandled" between the reject() call below and this test awaiting it.
    const assertion = expect(waiting).rejects.toThrow(/access_denied/);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/callback?error=access_denied`, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });

    await assertion;
  });

  it("redirectToAuthorization prints the URL for headless environments", () => {
    const provider = new FileOAuthClientProvider("github");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    provider.redirectToAuthorization(new URL("https://example.com/authorize?foo=bar"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("https://example.com/authorize?foo=bar"));
    errSpy.mockRestore();
  });
});
