import { readFile, readdir, mkdir, writeFile, rm, stat } from "node:fs/promises";
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

async function memoryFileExists(cwd: string, name: string, scope: MemoryScope): Promise<boolean> {
  try {
    await stat(path.join(memoryDir(cwd, scope), `${slugifyMemoryName(name)}.md`));
    return true;
  } catch {
    return false;
  }
}

/** Jaccard similarity over lowercase word sets — cheap, dependency-free, good enough for a one-line memory description (not meant to catch every paraphrase, just the common case of writing near-identical notes under two different names). */
export function descriptionSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wordsB = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const NEAR_DUPLICATE_DESCRIPTION_SIMILARITY = 0.6;

/**
 * Finds an existing memory in the same scope that's likely the same fact
 * saved under a different name — the write_memory tool's own instructions
 * already tell the caller to check for one first, but that's a prompt-level
 * nudge with nothing to actually catch it slipping through. Only compares
 * within the same scope (a project note and a same-topic global one aren't
 * really duplicates — they apply to different things) and skips an exact
 * slug match (that's an intentional overwrite of the same memory, not a
 * duplicate).
 */
export function findNearDuplicateMemory(existing: Memory[], input: WriteMemoryInput): Memory | undefined {
  const scope: MemoryScope = input.scope === "global" ? "global" : "project";
  const slug = slugifyMemoryName(input.name);
  return existing.find(
    (m) => m.scope === scope && m.name !== slug && descriptionSimilarity(m.description, input.description) >= NEAR_DUPLICATE_DESCRIPTION_SIMILARITY,
  );
}

export interface DuplicateMemoryPair {
  a: Memory;
  b: Memory;
  similarity: number;
}

/**
 * Same near-duplicate check write_memory already runs against a single new
 * note, but over every pair in the whole store — a manual, tool-driven
 * stand-in for a "dreaming"/background-consolidation process (periodically
 * reviewing and merging accumulated memory): this project has no
 * persistent background service to run one in, so consolidation here is
 * something the agent (or user) triggers and acts on via write_memory/
 * delete_memory, not something that happens on its own.
 */
export function findDuplicateMemoryPairs(memories: Memory[]): DuplicateMemoryPair[] {
  const pairs: DuplicateMemoryPair[] = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]!;
      const b = memories[j]!;
      if (a.scope !== b.scope || a.name === b.name) continue;
      const similarity = descriptionSimilarity(a.description, b.description);
      if (similarity >= NEAR_DUPLICATE_DESCRIPTION_SIMILARITY) pairs.push({ a, b, similarity });
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

export const findDuplicateMemoriesTool: ToolDefinition<Record<string, never>> = {
  name: "find_duplicate_memories",
  description:
    "Scan every saved memory note (project + global) for likely near-duplicates — the same fact saved under " +
    "two different names/descriptions — so they can be reviewed and merged (rewrite one with write_memory, " +
    "then delete_memory the other) instead of both lingering indefinitely. Read-only: reports candidates, " +
    "doesn't change anything itself.",
  riskLevel: "safe",
  inputSchema: { type: "object", properties: {} },
  async handler(_input, ctx) {
    const pairs = findDuplicateMemoryPairs(await loadMemories(ctx.cwd));
    if (pairs.length === 0) return { content: "No likely duplicate memories found.", isError: false };
    const lines = pairs.map((p) => `- "${p.a.name}" ~ "${p.b.name}" (${p.a.scope}, ${Math.round(p.similarity * 100)}% similar descriptions)`);
    return { content: `${pairs.length} likely duplicate pair(s):\n${lines.join("\n")}`, isError: false };
  },
};

interface DeleteMemoryInput {
  name: string;
  scope?: MemoryScope;
}

export const deleteMemoryTool: ToolDefinition<DeleteMemoryInput> = {
  name: "delete_memory",
  description:
    "Delete a saved memory note by name — use to remove a stale note or, after reviewing find_duplicate_memories " +
    "and merging its content elsewhere, one half of a duplicate pair.",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      scope: { type: "string", enum: ["project", "global"], description: 'Default "project"' },
    },
    required: ["name"],
  },
  describeCall: (input) => `delete_memory ${input.name}${input.scope === "global" ? " (global)" : ""}`,
  async handler(input, ctx) {
    const scope: MemoryScope = input.scope === "global" ? "global" : "project";
    if (!(await memoryFileExists(ctx.cwd, input.name, scope))) {
      return { content: `No ${scope} memory named "${input.name}".`, isError: true };
    }
    await deleteMemory(ctx.cwd, input.name, scope);
    return { content: `Deleted ${scope} memory "${input.name}".`, isError: false };
  },
};

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
      const duplicate = findNearDuplicateMemory(await loadMemories(ctx.cwd), input);
      const { slug, scope } = await writeMemory(ctx.cwd, input);
      const duplicateNote = duplicate
        ? ` Note: this looks similar to the existing memory "${duplicate.name}" (${duplicate.description}) — consider updating/deleting one of them instead of keeping both.`
        : "";
      return { content: `Saved ${scope === "global" ? "global " : ""}memory "${slug}".${duplicateNote}`, isError: false };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
