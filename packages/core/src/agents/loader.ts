import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";

// Real Claude Code's custom subagent types (.claude/agents/*.md): a
// markdown file defines a named persona the `task` tool can delegate to —
// its own system prompt and, optionally, a restricted tool whitelist —
// instead of every delegated task getting the same one-size-fits-all
// SUBAGENT_SYSTEM_PROMPT (see tools/builtin/task.ts). Same file convention
// as skills (frontmatter + gray-matter, global+project merge, project
// wins), so a user already familiar with skills/commands needs to learn
// nothing new here.
export type SubagentScope = "project" | "global";

export interface SubagentType {
  name: string;
  description: string;
  /** The markdown body, used as this subagent type's system prompt. */
  systemPrompt: string;
  /** Tool names this type is restricted to, if the frontmatter set one — undefined means "same tools as the parent" (task's existing default). */
  tools?: string[];
  scope: SubagentScope;
}

export function globalAgentsDir(): string {
  return path.join(os.homedir(), ".finanfa-code", "agents");
}

export function projectAgentsDir(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "agents");
}

function parseToolsField(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    const names = value.split(",").map((s) => s.trim()).filter(Boolean);
    return names.length > 0 ? names : undefined;
  }
  return undefined;
}

async function readAgentsFromDir(dir: string, scope: SubagentScope): Promise<SubagentType[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const result: SubagentType[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await readFile(filePath, "utf-8");
      const { data, content } = matter(raw);
      result.push({
        name: typeof data.name === "string" ? data.name : entry.replace(/\.md$/, ""),
        description: typeof data.description === "string" ? data.description : "",
        systemPrompt: content.trim(),
        tools: parseToolsField(data.tools),
        scope,
      });
    } catch (err) {
      // Same convention as skills/loader.ts and commands/custom-commands.ts:
      // one bad file shouldn't take down the whole CLI at startup.
      console.error(`Warning: failed to read subagent type ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** Project-local (.finanfa-code/agents) wins over global (~/.finanfa-code/agents) on a name collision — same precedence as skills/custom commands. */
export async function loadSubagentTypes(cwd: string): Promise<SubagentType[]> {
  const [global, project] = await Promise.all([
    readAgentsFromDir(globalAgentsDir(), "global"),
    readAgentsFromDir(projectAgentsDir(cwd), "project"),
  ]);
  const byName = new Map(global.map((a) => [a.name, a]));
  for (const a of project) byName.set(a.name, a);
  return [...byName.values()];
}
