import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpClientManager, NeedsAuthorizationError } from "../../src/mcp/client-manager.js";

describe("McpClientManager.connect: allowOAuthPrompt: false", () => {
  let manager: McpClientManager;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-mcp-oauth-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    manager = new McpClientManager();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await manager.disconnectAll();
    await rm(homeDir, { recursive: true, force: true });
  });

  it("throws NeedsAuthorizationError immediately, without attempting a real connection, when no token is saved", async () => {
    // A bogus, unreachable URL — if the pre-check didn't short-circuit
    // before any network attempt, this would hang/timeout instead of
    // failing fast with the specific error type.
    const start = Date.now();
    await expect(
      manager.connect(
        { name: "unauthorized-remote", transport: "http", url: "http://127.0.0.1:1/mcp" },
        { allowOAuthPrompt: false },
      ),
    ).rejects.toThrow(NeedsAuthorizationError);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("names the server in the error, so callers can report exactly which ones need auth", async () => {
    try {
      await manager.connect(
        { name: "notion", transport: "http", url: "http://127.0.0.1:1/mcp" },
        { allowOAuthPrompt: false },
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NeedsAuthorizationError);
      expect((err as NeedsAuthorizationError).serverName).toBe("notion");
    }
  });

  it("does not throw NeedsAuthorizationError for a plain stdio server (no OAuth involved at all)", async () => {
    // A stdio server that fails for an unrelated reason (bad command) should
    // surface as a normal error, never NeedsAuthorizationError — that class
    // only applies to remote/OAuth-capable transports.
    await expect(
      manager.connect(
        { name: "broken-stdio", transport: "stdio", command: "definitely-not-a-real-command-xyz" },
        { allowOAuthPrompt: false },
      ),
    ).rejects.not.toThrow(NeedsAuthorizationError);
  });

  it("connects normally (no error) when a token is already saved on disk", async () => {
    const authDir = path.join(homeDir, ".finanfa-code", "mcp-auth", "already-authed");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      path.join(authDir, "tokens.json"),
      JSON.stringify({ access_token: "fake-token", token_type: "Bearer" }),
    );

    // Still points at an unreachable URL — the point of this test is only
    // that the pre-check does NOT throw NeedsAuthorizationError once a
    // token file exists, letting the real connection attempt proceed (and
    // fail for its own, different, non-auth reason against a bogus URL).
    await expect(
      manager.connect(
        { name: "already-authed", transport: "http", url: "http://127.0.0.1:1/mcp" },
        { allowOAuthPrompt: false },
      ),
    ).rejects.not.toThrow(NeedsAuthorizationError);
  });
});
