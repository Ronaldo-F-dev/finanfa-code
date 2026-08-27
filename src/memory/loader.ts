import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { ToolDefinition } from "../core/types.js";

export interface Memory {
  name: string;
  description: string;
  type: string;
  content: string;
}

const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

function memoryDir(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "memory");
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Project-local memory notes (`.finanfa-code/memory/*.md`) — durable context about the user/project that isn't derivable from the code itself. */
export async function loadMemories(cwd: string): Promise<Memory[]> {
  const dir = memoryDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const memories: Memory[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const raw = await readFile(path.join(dir, entry), "utf-8");
    const { data, content } = matter(raw);
    const metadata = data.metadata as Record<string, unknown> | undefined;
    memories.push({
      name: typeof data.name === "string" ? data.name : entry.replace(/\.md$/, ""),
      description: typeof data.description === "string" ? data.description : "",
      type: typeof metadata?.type === "string" ? metadata.type : "project",
      content: content.trim(),
    });
  }
  return memories;
}

/** Short index of saved memories, meant to be appended to the system prompt. */
export function formatMemoryIndex(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m.name} (${m.type}): ${m.description}`).join("\n");
  return `\n\nProject memory (call read_memory with a name below for the full note):\n${lines}`;
}

/** A `read_memory` tool that loads one memory's full content on demand (progressive disclosure, same pattern as skills). Re-reads from disk each call so a memory written earlier in this same session is visible immediately. */
export function createReadMemoryTool(cwd: string): ToolDefinition<{ name: string }> {
  return {
    name: "read_memory",
    description: "Load the full content of a named memory note from the project memory index.",
    riskLevel: "safe",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    describeCall: (input) => `read_memory ${input.name}`,
    async handler(input) {
      const memory = (await loadMemories(cwd)).find((m) => m.name === input.name);
      if (!memory) return { content: `Unknown memory "${input.name}"`, isError: true };
      return { content: memory.content, isError: false };
    },
  };
}

interface WriteMemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
}

export const writeMemoryTool: ToolDefinition<WriteMemoryInput> = {
  name: "write_memory",
  description:
    "Save a durable note about this project or user so a future session starts with that context instead " +
    "of relearning it: user preferences/role, feedback about how to approach work here, project decisions " +
    "not derivable from the code, or pointers to external systems (issue tracker, docs). Do not use for " +
    "code details, git history, or task-scoped state — those are already derivable by reading the repo.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: 'Short kebab-case slug, e.g. "prefers-atomic-commits"' },
      description: { type: "string", description: "One-line summary shown in the memory index" },
      type: { type: "string", enum: [...MEMORY_TYPES] },
      content: { type: "string", description: "The memory content — a sentence or two" },
    },
    required: ["name", "description", "type", "content"],
  },
  describeCall: (input) => `write_memory ${input.name} (${input.type})`,
  async handler(input, ctx) {
    const slug = slugify(input.name);
    if (slug.length === 0) {
      return { content: "Memory name must contain at least one letter or digit.", isError: true };
    }
    const dir = memoryDir(ctx.cwd);
    await mkdir(dir, { recursive: true });
    const frontmatter =
      `---\nname: ${slug}\ndescription: ${JSON.stringify(input.description)}\n` +
      `metadata:\n  type: ${input.type}\n---\n\n`;
    await writeFile(path.join(dir, `${slug}.md`), frontmatter + input.content.trim() + "\n", "utf-8");
    return { content: `Saved memory "${slug}".`, isError: false };
  },
};
