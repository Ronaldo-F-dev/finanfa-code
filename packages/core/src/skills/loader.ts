import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { ToolDefinition } from "../core/types.js";

export type SkillScope = "project" | "global";

export interface Skill {
  name: string;
  description: string;
  content: string;
  /** Which file this actually came from — needed to edit/delete the right one, since a project-scoped skill can shadow a global one of the same name. */
  scope: SkillScope;
}

/** ~/.finanfa-code/skills — computed fresh per call, not memoized (a test overriding $HOME must see it). */
export function globalSkillsDir(): string {
  return path.join(os.homedir(), ".finanfa-code", "skills");
}

export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "skills");
}

function skillsDir(cwd: string, scope: SkillScope): string {
  return scope === "global" ? globalSkillsDir() : projectSkillsDir(cwd);
}

export function slugifySkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function readSkillsFromDir(dir: string, scope: SkillScope): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await readFile(filePath, "utf-8");
      const { data, content } = matter(raw);
      skills.push({
        name: typeof data.name === "string" ? data.name : entry.replace(/\.md$/, ""),
        description: typeof data.description === "string" ? data.description : "",
        content: content.trim(),
        scope,
      });
    } catch (err) {
      // A single unreadable or malformed (bad YAML frontmatter, a directory
      // named *.md, permission denied, ...) skill file shouldn't take down
      // the whole CLI at startup — warn and keep loading the rest.
      console.error(`Warning: failed to read skill ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return skills;
}

/**
 * Global skills (~/.finanfa-code/skills, apply in every project — a
 * systemwide personal tool/workflow) plus project-local ones
 * (.finanfa-code/skills, this repo only). Project-local wins on a name
 * collision, since it's the more specific of the two.
 */
export async function loadSkills(cwd: string): Promise<Skill[]> {
  const [global, project] = await Promise.all([
    readSkillsFromDir(globalSkillsDir(), "global"),
    readSkillsFromDir(projectSkillsDir(cwd), "project"),
  ]);
  const byName = new Map(global.map((s) => [s.name, s]));
  for (const skill of project) byName.set(skill.name, skill);
  return [...byName.values()];
}

/** Short index of available skills, meant to be appended to the system prompt. */
export function formatSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `\n\nAvailable skills (call read_skill with a name below to load its full instructions):\n${lines}`;
}

/** A `read_skill` tool that loads one skill's full content on demand (progressive disclosure). */
export function createReadSkillTool(skills: Skill[]): ToolDefinition<{ name: string }> {
  const byName = new Map(skills.map((s) => [s.name, s]));

  return {
    name: "read_skill",
    description: "Load the full instructions for a named skill from the available-skills index.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    describeCall: (input) => `read_skill ${input.name}`,
    async handler(input) {
      const skill = byName.get(input.name);
      if (!skill) {
        return { content: `Unknown skill "${input.name}"`, isError: true };
      }
      return { content: skill.content, isError: false };
    },
  };
}

export interface WriteSkillInput {
  name: string;
  description: string;
  content: string;
  scope?: SkillScope;
}

/**
 * Skills were previously only ever hand-authored (no tool wrote them, unlike
 * memory) — this is a real new capability, not a refactor, added so the web
 * UI can let a user create/edit one directly instead of hand-placing a file
 * under .finanfa-code/skills/ themselves.
 */
export async function writeSkill(cwd: string, input: WriteSkillInput): Promise<{ slug: string; scope: SkillScope }> {
  const slug = slugifySkillName(input.name);
  if (slug.length === 0) throw new Error("Skill name must contain at least one letter or digit.");
  const scope: SkillScope = input.scope === "global" ? "global" : "project";
  const dir = skillsDir(cwd, scope);
  await mkdir(dir, { recursive: true });
  const frontmatter = `---\nname: ${slug}\ndescription: ${JSON.stringify(input.description)}\n---\n\n`;
  await writeFile(path.join(dir, `${slug}.md`), frontmatter + input.content.trim() + "\n", "utf-8");
  return { slug, scope };
}

export async function deleteSkill(cwd: string, name: string, scope: SkillScope): Promise<void> {
  const slug = slugifySkillName(name);
  await rm(path.join(skillsDir(cwd, scope), `${slug}.md`), { force: true });
}
