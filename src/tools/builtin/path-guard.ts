import path from "node:path";

/**
 * Resolves `target` against `cwd` and rejects any path that escapes `cwd`,
 * so the model cannot read/write outside the project root via `../..`.
 */
export function resolveWithinCwd(cwd: string, target: string): string {
  const resolved = path.resolve(cwd, target);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path "${target}" is outside the project root (${cwd})`);
  }
  return resolved;
}
