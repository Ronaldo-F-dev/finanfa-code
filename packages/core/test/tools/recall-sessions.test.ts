import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { recallSessionsTool } from "../../src/tools/builtin/recall-sessions.js";
import { resetSessionSearchIndexForTests } from "../../src/core/session-search-index.js";

const ctx = (cwd: string) => ({ cwd, sessionId: "current", signal: new AbortController().signal });

describe("recall_past_sessions tool (real session files on disk, real AgentSession.persist)", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  const projectA = "/projects/finanfa-code";
  const projectB = "/projects/some-other-repo";

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-recall-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    resetSessionSearchIndexForTests(); // the sqlite handle is cached at module level, keyed to sessionsRoot() — must reopen against this test's fresh HOME

    const s1 = new AgentSession({ cwd: projectA, model: "m", systemPrompt: "s" });
    s1.title = "Fixing the login bug";
    s1.messages = [
      { role: "user", content: "the login form throws a null pointer exception on submit" },
      { role: "assistant", content: "Found it — the session token was never initialized before the redirect." },
    ];
    await s1.persist();

    const s2 = new AgentSession({ cwd: projectA, model: "m", systemPrompt: "s" });
    s2.title = "Adding dark mode";
    s2.messages = [
      { role: "user", content: "can you add a dark mode toggle to the settings page" },
      { role: "assistant", content: "Added a theme context and a toggle switch in Settings.tsx." },
    ];
    await s2.persist();

    const s3 = new AgentSession({ cwd: projectB, model: "m", systemPrompt: "s" });
    s3.title = "Database migration";
    s3.messages = [{ role: "user", content: "we need to migrate the login table to add a session token column" }];
    await s3.persist();
  });

  afterEach(async () => {
    resetSessionSearchIndexForTests(); // close the handle before deleting the temp dir it lives in
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("finds a matching session in the current project by keyword", async () => {
    const result = await recallSessionsTool.handler({ query: "login" }, ctx(projectA));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Fixing the login bug");
    expect(result.content).toContain("null pointer exception");
    expect(result.content).not.toContain("dark mode");
  });

  it("does not find a session from a different project when scope is 'project' (the default)", async () => {
    const result = await recallSessionsTool.handler({ query: "session token column" }, ctx(projectA));
    expect(result.content).not.toContain("Database migration");
  });

  it("finds a session from a different project when scope is 'all'", async () => {
    const result = await recallSessionsTool.handler({ query: "session token column", scope: "all" }, ctx(projectA));
    expect(result.content).toContain("Database migration");
    expect(result.content).toContain(projectB);
  });

  it("ranks a session matching more query terms above one matching fewer", async () => {
    // s1's two messages together match 6 of these terms (login, null, pointer,
    // session, token, redirect); s3's one message matches only 3 (login,
    // session, token) — a query designed to score s1 clearly higher, not a
    // near-tie that would make the exact ranking order sensitive to
    // incidental tie-breaking.
    const result = await recallSessionsTool.handler({ query: "login null pointer session token redirect", scope: "all" }, ctx(projectA));
    const loginBugIndex = result.content.indexOf("Fixing the login bug");
    const migrationIndex = result.content.indexOf("Database migration");
    expect(loginBugIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeGreaterThanOrEqual(0);
    expect(loginBugIndex).toBeLessThan(migrationIndex);
  });

  it("reports no match for a query that appears in nothing", async () => {
    const result = await recallSessionsTool.handler({ query: "xyzzy-nonexistent-keyword" }, ctx(projectA));
    expect(result.content).toBe("No past session matched that query.");
  });

  it("has 'safe' risk level (read-only)", () => {
    expect(recallSessionsTool.riskLevel).toBe("safe");
  });
});
