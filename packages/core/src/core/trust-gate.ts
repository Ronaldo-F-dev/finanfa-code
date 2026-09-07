import { access } from "node:fs/promises";
import path from "node:path";
import type { UIAdapter } from "../ui/adapter.js";
import { isFolderTrusted, trustFolder } from "./trust.js";

async function projectSettingsFileExists(cwd: string): Promise<boolean> {
  try {
    await access(path.join(cwd, ".finanfa-code", "settings.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves whether this project's .finanfa-code/settings.json should be
 * trusted this run, prompting the user the first time only when there's
 * actually something to trust or distrust — a project with no such file
 * has nothing project-level to gate, so it's never worth an extra prompt.
 * A "no" here doesn't fail the run: the project's own rules/hooks are
 * simply ignored (global config still applies) for this session, and the
 * folder stays untrusted for next time too — never remembers a decline.
 *
 * `nonInteractive` (e.g. --non-interactive, a CI/scripted run with no TTY
 * to prompt) fails closed without ever calling ui.askUser — same
 * fail-safe philosophy as PermissionManager's own nonInteractive mode,
 * and avoids hanging on a prompt nothing will ever answer.
 */
export async function resolveTrust(cwd: string, ui: UIAdapter, nonInteractive = false): Promise<boolean> {
  if (await isFolderTrusted(cwd)) return true;
  if (!(await projectSettingsFileExists(cwd))) return true;
  if (nonInteractive) {
    ui.writeError("Non-interactive mode: this project's .finanfa-code/settings.json (permission rules and hooks) will be ignored until the folder is explicitly trusted interactively.");
    return false;
  }

  const answer = (
    await ui.askUser(
      `\nThis project has a .finanfa-code/settings.json file, which can define permission rules and hooks that ` +
        `run automatically. Do you trust the files in this folder? [y/n] > `,
      "confirm",
    )
  )
    .trim()
    .toLowerCase();

  const trusted = answer === "y" || answer === "yes";
  if (trusted) {
    await trustFolder(cwd);
  } else {
    ui.writeError("Folder not trusted — this project's .finanfa-code/settings.json (permission rules and hooks) will be ignored. Your global config still applies.");
  }
  return trusted;
}
