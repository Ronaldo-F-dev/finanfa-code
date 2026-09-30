import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectMcpServers } from "../src/cli.js";
import { McpClientManager } from "@finanfa/core/src/mcp/client-manager.js";
import type { UIAdapter } from "@finanfa/core/src/ui/adapter.js";

function makeUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

describe("connectMcpServers", () => {
  let projectDir: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let manager: McpClientManager;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), "finanfa-connect-mcp-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-connect-mcp-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    manager = new McpClientManager();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await manager.disconnectAll();
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("reports one aggregated message for several unauthorized servers, instead of a writeError per server", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "mcp.json"),
      JSON.stringify({
        servers: [
          { name: "notion", transport: "http", url: "http://127.0.0.1:1/mcp" },
          { name: "canva", transport: "http", url: "http://127.0.0.1:1/mcp" },
        ],
      }),
    );

    const ui = makeUi();
    await connectMcpServers(projectDir, manager, ui);

    expect(ui.writeError).not.toHaveBeenCalled();
    expect(ui.writeSystem).toHaveBeenCalledWith(
      expect.stringContaining("2 MCP server(s) need authorization: notion, canva"),
    );
  });

  it("says nothing when there are no MCP servers configured", async () => {
    const ui = makeUi();
    await connectMcpServers(projectDir, manager, ui);
    expect(ui.writeSystem).not.toHaveBeenCalled();
    expect(ui.writeError).not.toHaveBeenCalled();
  });

  it("connects every configured server concurrently, not one at a time — a slow/hung server must not delay the others", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "mcp.json"),
      JSON.stringify({
        servers: [
          { name: "slow", transport: "http", url: "http://127.0.0.1:1/mcp" },
          { name: "fast", transport: "http", url: "http://127.0.0.1:1/mcp" },
        ],
      }),
    );

    const started: string[] = [];
    const resolvers = new Map<string, () => void>();
    // Real reported gap: a plain sequential for-loop meant one slow/hung
    // server (the MCP SDK's own initialize request defaults to a 60s
    // timeout, x3 retries) blocked every other configured server from even
    // starting to connect. This stubs connect() itself to prove the real
    // fix — every server's connect() attempt starts before any of them
    // resolves — without needing a real 60s timeout in the test.
    vi.spyOn(manager, "connect").mockImplementation(async (cfg) => {
      started.push(cfg.name);
      await new Promise<void>((resolve) => resolvers.set(cfg.name, resolve));
    });

    const ui = makeUi();
    const promise = connectMcpServers(projectDir, manager, ui);

    await vi.waitFor(() => expect(started.sort()).toEqual(["fast", "slow"]));
    resolvers.get("slow")!();
    resolvers.get("fast")!();
    await promise;
  });

  it("still reports a real (non-auth) connection failure individually via writeError", async () => {
    await mkdir(path.join(projectDir, ".finanfa-code"), { recursive: true });
    await writeFile(
      path.join(projectDir, ".finanfa-code", "mcp.json"),
      JSON.stringify({
        servers: [{ name: "broken", transport: "stdio", command: "definitely-not-a-real-command-xyz" }],
      }),
    );

    const ui = makeUi();
    await connectMcpServers(projectDir, manager, ui);

    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("broken"));
    expect(ui.writeSystem).not.toHaveBeenCalled();
  });
});
