import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpClientManager } from "../../src/mcp/client-manager.js";

describe("McpClientManager.connect: retries a transient failure", () => {
  let manager: McpClientManager | undefined;
  let dir: string;

  afterEach(async () => {
    await manager?.disconnectAll();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("spawns the stdio command 3 times before giving up on a persistently failing server", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-mcp-retry-"));
    const counterFile = path.join(dir, "count.txt");
    await writeFile(counterFile, "");

    // A "server" that exits immediately without completing the MCP
    // handshake — client.connect() rejects every time, real and persistent
    // (not a one-off flake), so retryWithBackoff should exhaust all attempts.
    const script = `require('fs').appendFileSync(${JSON.stringify(counterFile)}, "x"); process.exit(1);`;

    manager = new McpClientManager();
    await expect(
      manager.connect({ name: "broken", transport: "stdio", command: process.execPath, args: ["-e", script] }),
    ).rejects.toThrow();

    const spawnCount = (await readFile(counterFile, "utf-8")).length;
    expect(spawnCount).toBe(3);
  }, 10_000);
});
