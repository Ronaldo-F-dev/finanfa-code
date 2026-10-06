import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addMarketplace,
  discoverPlugins,
  installPlugin,
  listMarketplaces,
  removePlugin,
  searchMarketplaces,
  setPluginEnabled,
  validatePlugin,
} from "../../src/plugins/manager.js";
import { loadHooksConfig, type HookCommand } from "../../src/hooks/config.js";
import { loadCustomCommands } from "../../src/commands/custom-commands.js";
import { loadSubagentTypes } from "../../src/agents/loader.js";

let home: string;
let cwd: string;
let market: string;
const originalHome = process.env.HOME;

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf-8");
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "finanfa-home-"));
  cwd = await mkdtemp(path.join(tmpdir(), "finanfa-cwd-"));
  market = await mkdtemp(path.join(tmpdir(), "finanfa-market-"));
  process.env.HOME = home;

  await write(
    path.join(market, "marketplace.json"),
    JSON.stringify({
      name: "acme",
      plugins: [
        { name: "greeter", description: "says hello", source: "./plugins/greeter" },
        { name: "escape", source: "../outside" },
      ],
    }),
  );
  await write(path.join(market, "plugins/greeter/plugin.json"), JSON.stringify({ name: "greeter", version: "1.2.0", description: "says hello" }));
  await write(path.join(market, "plugins/greeter/commands/hello.md"), "---\ndescription: Greets\n---\nSay hello to $ARGUMENTS");
  await write(path.join(market, "plugins/greeter/agents/helper.md"), "---\ndescription: A helper\n---\nYou help.");
  await write(
    path.join(market, "plugins/greeter/hooks/hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo ${FINANFA_PLUGIN_ROOT}" }] }] } }),
  );
});

afterEach(() => {
  process.env.HOME = originalHome;
});

describe("plugins/manager", () => {
  it("registers a local marketplace, searches it and installs a plugin", async () => {
    const m = await addMarketplace(market);
    expect(m.name).toBe("acme");
    expect(await listMarketplaces()).toEqual([{ name: "acme", source: market, pluginCount: 2 }]);
    expect((await searchMarketplaces("hello")).map((p) => p.name)).toEqual(["greeter"]);

    const plugin = await installPlugin("greeter@acme");
    expect(plugin.dir).toBe(path.join(home, ".finanfa-code", "plugins", "greeter"));
    expect((await discoverPlugins(cwd)).map((p) => [p.name, p.manifest.version, p.enabled])).toEqual([["greeter", "1.2.0", true]]);
  });

  it("feeds an installed plugin's commands, agents and hooks into the existing loaders", async () => {
    await addMarketplace(market);
    await installPlugin("greeter");

    expect((await loadCustomCommands(cwd)).get("hello")?.content).toContain("Say hello");
    expect((await loadSubagentTypes(cwd)).map((a) => a.name)).toContain("helper");
    const hooks = await loadHooksConfig(cwd);
    expect((hooks.SessionStart?.[0].hooks[0] as HookCommand).command).toBe(`echo ${path.join(home, ".finanfa-code", "plugins", "greeter")}`);
  });

  it("lets the user's own command win over a plugin's of the same name", async () => {
    await addMarketplace(market);
    await installPlugin("greeter");
    await write(path.join(cwd, ".finanfa-code/commands/hello.md"), "mine");
    expect((await loadCustomCommands(cwd)).get("hello")?.content).toBe("mine");
  });

  it("stops contributing once disabled, and uninstalls cleanly", async () => {
    await addMarketplace(market);
    await installPlugin("greeter");
    expect(await setPluginEnabled("greeter", false, cwd)).toBe(true);
    expect((await loadCustomCommands(cwd)).has("hello")).toBe(false);
    expect(await loadHooksConfig(cwd)).toEqual({});

    expect(await removePlugin("greeter")).toBe(true);
    expect(await discoverPlugins(cwd)).toEqual([]);
    expect(await removePlugin("greeter")).toBe(false);
  });

  it("refuses a catalog entry that points outside its marketplace, and a double install", async () => {
    await addMarketplace(market);
    await expect(installPlugin("escape")).rejects.toThrow(/outside its marketplace/);
    await installPlugin("greeter");
    await expect(installPlugin("greeter")).rejects.toThrow(/already installed/);
    await expect(installPlugin("nope")).rejects.toThrow(/no plugin "nope"/);
  });

  it("only honors a project-carried plugin's hooks when the project is trusted", async () => {
    const dir = path.join(cwd, ".finanfa-code/plugins/local");
    await write(path.join(dir, "hooks/hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }));
    expect((await loadHooksConfig(cwd, true)).Stop).toHaveLength(1);
    expect(await loadHooksConfig(cwd, false)).toEqual({});
  });

  it("validatePlugin reports structural problems", async () => {
    const bad = path.join(market, "plugins/bad");
    await write(path.join(bad, "plugin.json"), JSON.stringify({ name: "bad name!" }));
    await write(path.join(bad, "hooks/hooks.json"), JSON.stringify({ hooks: { Nope: [] } }));
    await write(path.join(bad, "agents/a.md"), "---\nname: a\n---\nbody");
    const issues = await validatePlugin(bad);
    expect(issues.join("\n")).toMatch(/"name" must be/);
    expect(issues.join("\n")).toMatch(/unknown event "Nope"/);
    expect(issues.join("\n")).toMatch(/missing "description"/);
    expect(await validatePlugin(path.join(market, "plugins/greeter"))).toEqual([]);
    expect(await readFile(path.join(market, "marketplace.json"), "utf-8")).toContain("acme");
  });
});
