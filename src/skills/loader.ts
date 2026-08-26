import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { ToolDefinition } from "../core/types.js";

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const dir = path.join(cwd, ".finanfa-code", "skills");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const raw = await readFile(path.join(dir, entry), "utf-8");
    const { data, content } = matter(raw);
    skills.push({
      name: typeof data.name === "string" ? data.name : entry.replace(/\.md$/, ""),
      description: typeof data.description === "string" ? data.description : "",
      content: content.trim(),
    });
  }
  return skills;
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
