import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { spawnWebServer, killWebServer } from "./support/spawn-server.js";

// Real end-to-end test of Gateway's real per-login accounts (hashed
// passwords persisted to ~/.finanfa-code/web-users.json — see
// user-store.ts — and session tokens issued by POST /api/auth/login —
// see session-token-store.ts), layered on top of the existing static
// FINANFA_WEB_USERS token map (see gateway-auth.test.ts). Run with
// FINANFA_WEB_ACCOUNTS=1 and NO static tokens at all, to prove accounts
// work fully on their own.

describe("Gateway real accounts: bootstrap, login, and session-token auth (real subprocess, real WebSocket)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-accounts-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-accounts-home-"));
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify({ provider: "anthropic", apiKey: "unused-in-this-test" }));

    process.env.FINANFA_WEB_ACCOUNTS = "1";
    delete process.env.FINANFA_WEB_USERS; // proves accounts work with NO static tokens configured at all
    ({ child, port } = await spawnWebServer(projectDir, homeDir));
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    delete process.env.FINANFA_WEB_ACCOUNTS;
  });

  it("still 401s an unauthenticated /api/sessions request (accounts-only mode is still gated)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it("creates the very first account with no auth needed (bootstrap), then requires auth for every account after", async () => {
    const first = await fetch(`http://127.0.0.1:${port}/api/auth/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "alice-password-123" }),
    });
    expect(first.status).toBe(200);

    // A second account, with no auth at all, is refused now that one exists.
    const secondUnauthenticated = await fetch(`http://127.0.0.1:${port}/api/auth/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "bob-password-123" }),
    });
    expect(secondUnauthenticated.status).toBe(401);
  });

  it("logs in with the created account and gets a real, usable session token", async () => {
    const wrongPassword = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "not-the-real-password" }),
    });
    expect(wrongPassword.status).toBe(401);

    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "alice-password-123" }),
    });
    expect(login.status).toBe(200);
    const { token, user } = (await login.json()) as { token: string; user: string };
    expect(user).toBe("alice");
    expect(token).toBeTruthy();

    // The session token authenticates a real REST request...
    const sessionsRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    expect(sessionsRes.status).toBe(200);

    // ...and a real WebSocket connection.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?model=claude-sonnet-5&token=${token}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.close();

    // Now that alice is logged in, she can create a second account herself.
    const secondAuthenticated = await fetch(`http://127.0.0.1:${port}/api/auth/users`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ username: "bob", password: "bob-password-123" }),
    });
    expect(secondAuthenticated.status).toBe(200);
  });

  it("rejects a bogus session token the same way a bogus static token would be", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: "Bearer not-a-real-session-token" } });
    expect(res.status).toBe(401);
  });
});
