import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMcpServers } from "../../src/mcp/config.js";

describe("mcp/config", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-mcpconfig-project-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns an empty list when no mcp.json exists", async () => {
    expect(await loadMcpServers(projectDir)).toEqual([]);
  });

  it("returns the configured servers from a valid mcp.json", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "mcp.json"),
      JSON.stringify({ servers: [{ name: "echo", transport: "stdio", command: "echo" }] }),
    );

    const servers = await loadMcpServers(projectDir);
    expect(servers).toEqual([{ name: "echo", transport: "stdio", command: "echo" }]);
  });

  it("falls back to an empty list on malformed JSON instead of throwing, and warns about it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
      await writeFile(path.join(projectDir, ".finanfa-code", "mcp.json"), "{ not valid json");

      const servers = await loadMcpServers(projectDir);
      expect(servers).toEqual([]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain("mcp.json");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
