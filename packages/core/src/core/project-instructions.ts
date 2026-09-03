import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Reads <cwd>/finanfa.md — project-specific instructions the user maintains
 * by hand (conventions, architecture notes, "always do X here"), the same
 * role CLAUDE.md plays for Claude Code. A missing file is normal and silent;
 * any other read error is worth a warning rather than silently dropping the
 * user's instructions with no explanation.
 */
export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  const file = path.join(cwd, "finanfa.md");
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

export function formatProjectInstructions(instructions: string | undefined): string {
  if (!instructions) return "";
  return `\n\n# Project instructions (finanfa.md)\n\n${instructions}`;
}
