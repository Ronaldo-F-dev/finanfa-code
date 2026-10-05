import { describe, expect, it, afterEach } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWebServer, killWebServer, type ServerOutput } from "./support/spawn-server.js";

// Real end-to-end test of the startup warning added to index.ts's
// httpServer.listen callback: it should fire when the server comes up
// with no gateway auth configured at all (the real production risk —
// every request treated as one shared, unauthenticated user with full
// agent access), and must NOT fire when FINANFA_WEB_USERS is set.

const WARNING_SNIPPET = "No gateway auth configured";

/** The warning is written right after the "listening on" line inside the same listen() callback, but may land in a later stdout chunk than the one waitForServerReady's regex matched on — poll instead of asserting immediately. */
async function waitForText(output: ServerOutput, snippet: string, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (output.text.includes(snippet)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Gateway auth startup warning (real subprocess)", () => {
  let projectDir: string;
  let homeDir: string;
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(async () => {
    killWebServer(child);
    child = undefined;
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
  });

  it("warns on stdout/stderr when no gateway auth is configured", async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-auth-warn-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-auth-warn-home-"));
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify({ provider: "anthropic", apiKey: "unused-in-this-test" }));

    const { child: c, output } = await spawnWebServer(projectDir, homeDir);
    child = c;

    expect(await waitForText(output, WARNING_SNIPPET)).toBe(true);
  }, 30_000);

  it("does not warn when FINANFA_WEB_USERS is configured", async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-auth-warn-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-web-auth-warn-home-"));
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(path.join(projectDir, ".finanfa-code", "config.json"), JSON.stringify({ provider: "anthropic", apiKey: "unused-in-this-test" }));

    const { child: c, output } = await spawnWebServer(projectDir, homeDir, { FINANFA_WEB_USERS: "alice:tok-alice" });
    child = c;

    // Give the warning the same window it'd have to appear, then confirm it didn't.
    await waitForText(output, WARNING_SNIPPET, 1_000);
    expect(output.text).not.toContain(WARNING_SNIPPET);
  }, 30_000);
});
