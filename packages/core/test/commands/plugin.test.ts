import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { CustomCommand } from "../../src/commands/custom-commands.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

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

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf-8");
}

const originalHome = process.env.HOME;
let cwd: string;
let market: string;
beforeEach(async () => {
  process.env.HOME = await mkdtemp(path.join(tmpdir(), "finanfa-home-"));
  cwd = await mkdtemp(path.join(tmpdir(), "finanfa-cwd-"));
  market = await mkdtemp(path.join(tmpdir(), "finanfa-market-"));
  await write(path.join(market, "marketplace.json"), JSON.stringify({ name: "acme", plugins: [{ name: "greeter", source: "./greeter" }] }));
  await write(path.join(market, "greeter/commands/hello.md"), "---\ndescription: Greets\n---\nSay hello");
  await write(
    path.join(market, "greeter/hooks/hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
  );
});
afterEach(() => {
  process.env.HOME = originalHome;
});

describe("/plugin: reloading hooks and commands in place", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  function setup() {
    const ui = makeUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const customCommands = new Map<string, CustomCommand>();
    const run = async (args: string) => {
      const ctx = {
        session: new AgentSession({ cwd, model: "m", systemPrompt: "s" }),
        ui,
        tools: new ToolRegistry(),
        permissions,
        mcp: {},
        provider: {},
        cwd,
        args,
        setSession: vi.fn(),
        customCommands,
        commands,
      } as never;
      await commands.get("plugin")!(ctx);
    };
    return { ui, permissions, customCommands, run };
  }

  it("makes an installed plugin's command and hook live immediately, and removes them on disable/enable", async () => {
    const s = setup();
    await s.run(`marketplace add ${market}`);
    expect(s.customCommands.has("hello")).toBe(false);
    expect(s.permissions.getHooksConfig().Stop).toBeUndefined();

    await s.run("install greeter@acme");
    expect(s.customCommands.get("hello")?.content).toBe("Say hello");
    expect(s.permissions.getHooksConfig().Stop).toHaveLength(1);
    expect(s.ui.setCommands).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ name: "hello" })]));

    await s.run("disable greeter");
    expect(s.customCommands.has("hello")).toBe(false);
    expect(s.permissions.getHooksConfig().Stop).toBeUndefined();

    await s.run("enable greeter");
    expect(s.customCommands.has("hello")).toBe(true);

    await s.run("remove greeter");
    expect(s.customCommands.has("hello")).toBe(false);
  });

  it("/plugin reload re-reads a command file added by hand", async () => {
    const s = setup();
    await write(path.join(cwd, ".finanfa-code/commands/ship.md"), "ship it");
    await s.run("reload");
    expect(s.customCommands.get("ship")?.content).toBe("ship it");
    expect(s.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("Reloaded:"));
  });
});
