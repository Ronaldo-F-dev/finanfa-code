import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import { spawnWebServer, killWebServer, createTempProject } from "./support/spawn-server.js";

// Real end-to-end test of the login brute-force throttle (see
// login-rate-limiter.ts) wired into POST /api/auth/login — proves the
// real HTTP route actually returns 429 after repeated failures against
// a real running server, not just that the limiter class's own logic is
// correct (see login-rate-limiter.test.ts for that).

describe("Login rate limiting (real subprocess)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    ({ projectDir, homeDir } = await createTempProject("rate-limit"));

    process.env.FINANFA_WEB_ACCOUNTS = "1";
    ({ child, port } = await spawnWebServer(projectDir, homeDir));

    const createAccount = await fetch(`http://127.0.0.1:${port}/api/auth/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "alice-password-123" }),
    });
    expect(createAccount.status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    killWebServer(child);
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    delete process.env.FINANFA_WEB_ACCOUNTS;
  });

  it("401s wrong-password attempts, then 429s once the threshold is hit, while a different username stays unaffected", async () => {
    const login = (password: string, username = "alice") =>
      fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

    for (let i = 0; i < 5; i++) {
      const res = await login("wrong-password");
      expect(res.status).toBe(401);
    }

    const locked = await login("wrong-password");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();

    // Even the CORRECT password is refused while locked out — otherwise
    // the lockout would be trivially bypassable by just retrying the
    // real password once more.
    const correctButLocked = await login("alice-password-123");
    expect(correctButLocked.status).toBe(429);

    // A different username from the same test client isn't swept up in alice's lockout.
    const otherUser = await login("whatever", "someone-else");
    expect(otherUser.status).toBe(401);
  });
});
