import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { ToolDefinition } from "../core/types.js";

export type MemoryScope = "project" | "global";

export interface Memory {
  name: string;
  description: string;
  type: string;
  content: string;
  /** Which file this actually came from — needed to edit/delete the right one, since a project-scoped entry can shadow a global one of the same name. */
  scope: MemoryScope;
}

const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** ~/.finanfa-code/memory — computed fresh per call, not memoized (a test overriding $HOME must see it). */
export function globalMemoryDir(): string {
  return path.join(os.homedir(), ".finanfa-code", "memory");
}

export function projectMemoryDir(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "memory");
}

function memoryDir(cwd: string, scope: MemoryScope): string {
  return scope === "global" ? globalMemoryDir() : projectMemoryDir(cwd);
}

export function slugifyMemoryName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function readMemoriesFromDir(dir: string, scope: MemoryScope): Promise<Memory[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const memories: Memory[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = path.join(dir, entry);
    try {
      const raw = await readFile(file, "utf-8");
      const { data, content } = matter(raw);
      const metadata = data.metadata as Record<string, unknown> | undefined;
      memories.push({
        name: typeof data.name === "string" ? data.name : entry.replace(/\.md$/, ""),
        description: typeof data.description === "string" ? data.description : "",
        type: typeof metadata?.type === "string" ? metadata.type : "project",
        content: content.trim(),
        scope,
      });
    } catch (err) {
      // A single unreadable file (permission error) or one with malformed
      // YAML frontmatter used to throw out of loadMemories and crash the
      // whole CLI at startup. Warn about that one file and keep loading
      // the rest, same as config.ts's readJsonIfExists.
      console.error(`Warning: failed to read memory ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return memories;
}

/**
 * Global memory (~/.finanfa-code/memory, applies in every project — e.g. a
 * durable user preference or a systemwide tool the agent should know about)
 * plus project-local notes (.finanfa-code/memory, this repo only).
 * Project-local wins on a name collision, since it's the more specific of
 * the two.
 */
export async function loadMemories(cwd: string): Promise<Memory[]> {
  const [global, project] = await Promise.all([
    readMemoriesFromDir(globalMemoryDir(), "global"),
    readMemoriesFromDir(projectMemoryDir(cwd), "project"),
  ]);
  const byName = new Map(global.map((m) => [m.name, m]));
  for (const memory of project) byName.set(memory.name, memory);
  return [...byName.values()];
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

export interface WriteMemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  scope?: MemoryScope;
}

/**
 * Shared by write_memory (the agent, mid-conversation) and the web UI's
 * Memory panel (a human, directly) — one real write path so both stay in
 * exactly the same file format instead of two implementations quietly
 * drifting apart.
 */
export async function writeMemory(cwd: string, input: WriteMemoryInput): Promise<{ slug: string; scope: MemoryScope }> {
  const slug = slugifyMemoryName(input.name);
  if (slug.length === 0) throw new Error("Memory name must contain at least one letter or digit.");
  const scope: MemoryScope = input.scope === "global" ? "global" : "project";
  const dir = memoryDir(cwd, scope);
  await mkdir(dir, { recursive: true });
  const frontmatter = `---\nname: ${slug}\ndescription: ${JSON.stringify(input.description)}\n` + `metadata:\n  type: ${input.type}\n---\n\n`;
  await writeFile(path.join(dir, `${slug}.md`), frontmatter + input.content.trim() + "\n", "utf-8");
  return { slug, scope };
}

export async function deleteMemory(cwd: string, name: string, scope: MemoryScope): Promise<void> {
  const slug = slugifyMemoryName(name);
  await rm(path.join(memoryDir(cwd, scope), `${slug}.md`), { force: true });
}

export const writeMemoryTool: ToolDefinition<WriteMemoryInput> = {
  name: "write_memory",
  description:
    "Save a durable note about this project or user so a future session starts with that context instead " +
    "of relearning it: user preferences/role, feedback about how to approach work here, project decisions " +
    "not derivable from the code, or pointers to external systems (issue tracker, docs). Do not use for " +
    "code details, git history, or task-scoped state — those are already derivable by reading the repo. " +
    'scope: "global" (default "project") applies the note in every project instead of just this one — use ' +
    "it for something true regardless of which repo you're in (e.g. a systemwide tool the user always wants " +
    "used for a certain kind of task), not for anything specific to this project.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: 'Short kebab-case slug, e.g. "prefers-atomic-commits"' },
      description: { type: "string", description: "One-line summary shown in the memory index" },
      type: { type: "string", enum: [...MEMORY_TYPES] },
      content: { type: "string", description: "The memory content — a sentence or two" },
      scope: { type: "string", enum: ["project", "global"], description: 'Default "project"' },
    },
    required: ["name", "description", "type", "content"],
  },
  describeCall: (input) => `write_memory ${input.name} (${input.type}${input.scope === "global" ? ", global" : ""})`,
  async handler(input, ctx) {
    try {
      const { slug, scope } = await writeMemory(ctx.cwd, input);
      return { content: `Saved ${scope === "global" ? "global " : ""}memory "${slug}".`, isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
