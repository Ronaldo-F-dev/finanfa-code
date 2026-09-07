import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSubagentTypes } from "../../src/agents/loader.js";

describe("agents/loader (custom subagent types)", () => {
  let dir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-agents-"));
    await mkdir(path.join(dir, ".finanfa-code", "agents"), { recursive: true });
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-agents-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns an empty list when there is no agents directory", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "finanfa-agents-empty-"));
    expect(await loadSubagentTypes(empty)).toEqual([]);
    await rm(empty, { recursive: true, force: true });
  });

  it("loads a subagent type's name, description, system prompt, and tool whitelist", async () => {
    await writeFile(
      path.join(dir, ".finanfa-code", "agents", "explorer.md"),
      "---\nname: explorer\ndescription: Read-only codebase exploration\ntools: read_file, grep, glob\n---\nYou only ever read; never write or run commands.",
    );

    const [agent] = await loadSubagentTypes(dir);
    expect(agent.name).toBe("explorer");
    expect(agent.description).toBe("Read-only codebase exploration");
    expect(agent.systemPrompt).toBe("You only ever read; never write or run commands.");
    expect(agent.tools).toEqual(["read_file", "grep", "glob"]);
  });

  it("leaves tools undefined when the frontmatter doesn't set one", async () => {
    await writeFile(path.join(dir, ".finanfa-code", "agents", "generalist.md"), "---\nname: generalist\ndescription: no restriction\n---\nDo anything needed.");
    const [agent] = await loadSubagentTypes(dir);
    expect(agent.tools).toBeUndefined();
  });

  it("merges global (~/.finanfa-code/agents) and project-local subagent types", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code", "agents"), { recursive: true });
    await writeFile(path.join(homeDir, ".finanfa-code", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: A systemwide reviewer\n---\nReview code for bugs.");
    await writeFile(path.join(dir, ".finanfa-code", "agents", "deployer.md"), "---\nname: deployer\ndescription: Deploys this project\n---\nRun the deploy steps.");

    const agents = await loadSubagentTypes(dir);
    expect(agents.map((a) => a.name).sort()).toEqual(["deployer", "reviewer"]);
  });

  it("project-local subagent type wins over a global one with the same name", async () => {
    await mkdir(path.join(homeDir, ".finanfa-code", "agents"), { recursive: true });
    await writeFile(path.join(homeDir, ".finanfa-code", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: global version\n---\nglobal prompt");
    await writeFile(path.join(dir, ".finanfa-code", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: project version\n---\nproject prompt");

    const agents = await loadSubagentTypes(dir);
    const reviewer = agents.find((a) => a.name === "reviewer")!;
    expect(reviewer.description).toBe("project version");
    expect(reviewer.systemPrompt).toBe("project prompt");
  });

  it("falls back to the filename (minus .md) when frontmatter has no name", async () => {
    await writeFile(path.join(dir, ".finanfa-code", "agents", "quick-checker.md"), "Just check things quickly.");
    const [agent] = await loadSubagentTypes(dir);
    expect(agent.name).toBe("quick-checker");
  });

  it("warns and skips a malformed agent file instead of throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(path.join(dir, ".finanfa-code", "agents", "bad.md"), "---\nname: [unterminated\n---\ncontent");
      const agents = await loadSubagentTypes(dir);
      expect(agents.some((a) => a.name === "bad")).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
