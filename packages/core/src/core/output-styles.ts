// Output styles: a persistent instruction about HOW the agent communicates,
// layered onto the system prompt every turn (see systemPromptWithDate in
// loop.ts) without changing what it is allowed to do. Chosen per session via
// /output-style and persisted with it.
export interface OutputStyle {
  name: string;
  description: string;
  /** Appended to the system prompt; undefined for the default style. */
  prompt?: string;
}

export const OUTPUT_STYLES: OutputStyle[] = [
  { name: "default", description: "Concise and task-focused" },
  {
    name: "explanatory",
    description: "Adds short notes on why the code is written the way it is",
    prompt:
      "Output style — explanatory: while you work, add brief notes explaining the reasoning behind your implementation choices " +
      "and any codebase conventions you rely on, so the user learns from the changes. Keep each note to a few sentences, put it " +
      "next to the change it explains, and never let the notes delay or replace the actual work.",
  },
  {
    name: "learning",
    description: "Teaches by handing small, well-defined pieces of the work to the user",
    prompt:
      "Output style — learning: act as a collaborative teacher. Do the routine work yourself, but when a change contains a small, " +
      "meaningful decision (a core function body, a design trade-off), stop before writing it, explain the context, and ask the " +
      "user to write that piece of 5–10 lines themselves — say exactly where it goes and what it must do. Review what they write " +
      "constructively. Never withhold anything that blocks progress for longer than one exchange.",
  },
];

export function findOutputStyle(name: string): OutputStyle | undefined {
  return OUTPUT_STYLES.find((s) => s.name === name.trim().toLowerCase());
}
