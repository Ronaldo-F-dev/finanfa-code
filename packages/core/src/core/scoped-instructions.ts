import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

// Path-scoped project instructions — `.finanfa-code/instructions/*.md`,
// each with frontmatter `applyTo` (a glob, or list of globs) naming which
// files it's actually about, alongside `finanfa.md`'s single always-on
// project note (project-instructions.ts). The same real gap Copilot's own
// `*.instructions.md`/`applyTo` convention closes: a monorepo's frontend
// conventions and its backend conventions don't belong in one
// undifferentiated file, and a rule that only matters for tests
// shouldn't compete for attention on every unrelated turn. Unlike an
// IDE's Copilot integration (which knows which file is actually open and
// injects only the matching instructions), this project's system prompt
// is built once per session before any file is touched — so every scoped
// instruction is included up front, labeled with the globs it applies to,
// and the model itself is expected to apply a rule only when it's
// actually working on a matching path.
export interface ScopedInstruction {
  /** Derived from the filename (without .md) — used only for the label in the formatted output, not for any lookup. */
  name: string;
  description?: string;
  /** Glob(s) this instruction is about, e.g. "src/**\/*.ts" — undefined/empty means it's relevant regardless of path. */
  applyTo?: string[];
  content: string;
}

export function projectInstructionsDir(cwd: string): string {
  return path.join(cwd, ".finanfa-code", "instructions");
}

function normalizeApplyTo(raw: unknown): string[] | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) return [raw.trim()];
  if (Array.isArray(raw)) {
    const globs = raw.filter((g): g is string => typeof g === "string" && g.trim().length > 0);
    return globs.length > 0 ? globs : undefined;
  }
  return undefined;
}

/**
 * Loads every `.finanfa-code/instructions/*.md` file for this project. A
 * missing directory is normal and silent; a single unreadable/malformed
 * file is warned about and skipped, not fatal to the rest (same policy
 * as skills/memory loading).
 */
export async function loadScopedInstructions(cwd: string): Promise<ScopedInstruction[]> {
  const dir = projectInstructionsDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const instructions: ScopedInstruction[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await readFile(filePath, "utf-8");
      const { data, content } = matter(raw);
      const trimmed = content.trim();
      if (trimmed.length === 0) continue;
      instructions.push({
        name: typeof data.name === "string" ? data.name : entry.replace(/\.md$/, ""),
        description: typeof data.description === "string" ? data.description : undefined,
        applyTo: normalizeApplyTo(data.applyTo),
        content: trimmed,
      });
    } catch (err) {
      console.error(`Warning: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return instructions;
}

export function formatScopedInstructions(instructions: ScopedInstruction[]): string {
  if (instructions.length === 0) return "";
  const sections = instructions.map((instr) => {
    const scopeLabel = instr.applyTo?.length ? ` (applies to: ${instr.applyTo.join(", ")})` : "";
    const descriptionLine = instr.description ? `${instr.description}\n\n` : "";
    return `## ${instr.name}${scopeLabel}\n\n${descriptionLine}${instr.content}`;
  });
  return `\n\n# Path-scoped project instructions\n\nEach section below only applies to files matching its own "applies to" globs (or to everything, if none are given) — apply a rule only when you're actually working on a matching path.\n\n${sections.join("\n\n")}`;
}
