import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlugins } from "../../src/plugins/loader.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { CommandRegistry } from "../../src/commands/registry.js";

describe("plugin loader", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-plugins-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty list when there is no plugins directory", async () => {
    const tools = new ToolRegistry();
    const commands = new CommandRegistry();
    expect(await loadPlugins(dir, tools, commands)).toEqual([]);
  });

  it("loads a plugin that registers a new tool without touching core source", async () => {
    const pluginDir = path.join(dir, ".finanfa-code", "plugins", "greet");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "index.js"),
      `export function registerTools(registry) {
        registry.register({
          name: "greet",
          description: "Says hello",
          riskLevel: "safe",
          inputSchema: { type: "object" },
          async handler() { return { content: "hello from plugin", isError: false }; },
        });
      }`,
    );

    const tools = new ToolRegistry();
    const commands = new CommandRegistry();
    const loaded = await loadPlugins(dir, tools, commands);

    expect(loaded).toEqual(["greet"]);
    const tool = tools.get("greet");
    expect(tool).toBeDefined();
    const result = await tool!.handler({}, { cwd: dir, sessionId: "s", signal: new AbortController().signal });
    expect(result.content).toBe("hello from plugin");
  });
});
