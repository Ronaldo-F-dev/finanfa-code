import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkills, formatSkillIndex, createReadSkillTool } from "../../src/skills/loader.js";

describe("skills loader", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-skills-"));
    await mkdir(path.join(dir, ".finanfa-code", "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty list when there is no skills directory", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "finanfa-empty-"));
    expect(await loadSkills(empty)).toEqual([]);
    await rm(empty, { recursive: true, force: true });
  });

  it("parses frontmatter and body from skill files", async () => {
    await writeFile(
      path.join(dir, ".finanfa-code", "skills", "deploy.md"),
      "---\nname: deploy\ndescription: How to deploy the app\n---\nRun `npm run deploy`.",
    );

    const skills = await loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "deploy",
      description: "How to deploy the app",
      content: "Run `npm run deploy`.",
    });
  });

  it("builds a short index string for the system prompt", () => {
    const index = formatSkillIndex([{ name: "deploy", description: "How to deploy", content: "..." }]);
    expect(index).toContain("deploy: How to deploy");
    expect(formatSkillIndex([])).toBe("");
  });

  it("read_skill tool returns full content on demand, and errors for unknown names", async () => {
    const tool = createReadSkillTool([{ name: "deploy", description: "d", content: "full instructions" }]);
    const ctx = { cwd: dir, sessionId: "s", signal: new AbortController().signal };

    const ok = await tool.handler({ name: "deploy" }, ctx);
    expect(ok.content).toBe("full instructions");
    expect(ok.isError).toBe(false);

    const missing = await tool.handler({ name: "nope" }, ctx);
    expect(missing.isError).toBe(true);
  });
});
