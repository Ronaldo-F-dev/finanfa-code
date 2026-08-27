import path from "node:path";
import os from "node:os";

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves `target` (relative to `cwd`, or an absolute path) and rejects it
 * unless it falls under the project root (`cwd`) or the user's home
 * directory — allows e.g. "create a project on my Desktop" through
 * write_file/edit_file/read_file (still subject to the normal "ask"
 * permission prompt/diff preview for anything outside `cwd`) without
 * allowing an arbitrary system path (`/etc`, another user's home, ...).
 * `bash` has no such guard at all, so this was never a hard security
 * boundary against a determined model — it protects against an accidental
 * `../..` typo landing somewhere unexpected, which the home-directory
 * expansion doesn't weaken.
 */
export function resolveAllowedPath(cwd: string, target: string): string {
  const resolved = path.resolve(cwd, target);
  const home = os.homedir();
  if (isWithin(cwd, resolved) || isWithin(home, resolved)) {
    return resolved;
  }
  throw new Error(`Path "${target}" is outside the project root (${cwd}) and your home directory (${home})`);
}
