import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Built-in default design system, used only when the user hasn't provided
 * their own finanfa-design.md — never written to disk, never printed to the
 * terminal, invisible in normal use (same "structural constraint, not a
 * smarter model" idea OpenDesign uses via its own DESIGN.md contract file,
 * just baked in as a fallback instead of a project file the user has to
 * create themselves before getting any benefit).
 */
const DEFAULT_DESIGN_CONTRACT = `Design system (apply unless the request clearly calls for something else):
- Palette: a neutral base (slate-50 background, slate-900 text) plus exactly one accent color fit to the request's context (default indigo-600 if nothing else fits) — never leave default Tailwind black/white/gray with no deliberate accent choice.
- Spacing: Tailwind's default scale, used consistently — p-4/p-6 for card padding, gap-4/gap-6 between related elements, never an eyeballed one-off pixel value.
- Typography: one weight step per hierarchy level (font-bold for headings, font-medium for emphasis, regular for body) — text-sm for secondary/meta text, text-base for body, text-lg or larger for headings.
- Components: rounded-lg or rounded-xl consistently for cards/buttons (not mismatched radii in one view), shadow-sm for resting elevation, shadow-lg reserved for one explicitly featured/elevated element, slate-200 borders when borders are used at all.
- Interactivity: every clickable element gets a visible hover state (hover:bg-*, hover:shadow, or similar) — a button/card with no hover response reads as broken, not calm.`;

function designContractPath(cwd: string): string {
  return path.join(cwd, "finanfa-design.md");
}

export interface DesignContract {
  content: string;
  isUserProvided: boolean;
}

/**
 * A user-provided finanfa-design.md completely replaces the built-in
 * default — it is never merged with or appended to it. Missing file is
 * normal and silent (falls back to the default); a real read error still
 * falls back to the default, but warns instead of silently dropping what
 * might have been a real (if broken) attempt at a custom contract.
 */
export async function loadDesignContract(cwd: string): Promise<DesignContract> {
  const file = designContractPath(cwd);
  try {
    const content = (await readFile(file, "utf-8")).trim();
    if (content.length > 0) return { content, isUserProvided: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`Warning: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { content: DEFAULT_DESIGN_CONTRACT, isUserProvided: false };
}
