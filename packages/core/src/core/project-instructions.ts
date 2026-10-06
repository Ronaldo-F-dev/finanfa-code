import { readFile } from "node:fs/promises";
import path from "node:path";

// Project instruction files, in priority order: finanfa.md (this tool's own,
// the role CLAUDE.md plays for Claude Code) wins; AGENTS.md (the cross-tool
// convention many repos already ship) is used only when finanfa.md is absent
// or empty, so a repo that has both doesn't feed the model duplicated rules.
const INSTRUCTION_FILES = ["finanfa.md", "AGENTS.md"] as const;

/** A missing file is normal and silent; any other read error is worth a warning rather than silently dropping the user's instructions with no explanation. */
async function readInstructionFile(file: string): Promise<string | undefined> {
  try {
    const content = (await readFile(file, "utf-8")).trim();
    return content.length > 0 ? content : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`Warning: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  }
}

/**
 * Reads <cwd>/finanfa.md — project-specific instructions the user maintains
 * by hand (conventions, architecture notes, "always do X here") — falling
 * back to <cwd>/AGENTS.md. Content from the fallback is prefixed with a note
 * saying where it came from; finanfa.md's content is returned as written.
 */
export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  for (const name of INSTRUCTION_FILES) {
    const content = await readInstructionFile(path.join(cwd, name));
    if (content === undefined) continue;
    return name === "finanfa.md" ? content : `(Loaded from ${name}.)\n\n${content}`;
  }
  return undefined;
}

export function formatProjectInstructions(instructions: string | undefined): string {
  if (!instructions) return "";
  return `\n\n# Project instructions\n\n${instructions}`;
}
