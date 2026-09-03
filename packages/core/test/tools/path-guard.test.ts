import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAllowedPath } from "../../src/tools/builtin/path-guard.js";

describe("resolveAllowedPath", () => {
  let homeDir: string;
  let projectDir: string;
  let outsideDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "finanfa-path-guard-"));
    homeDir = path.join(root, "home");
    projectDir = path.join(homeDir, "Bureau", "finanfa-code");
    outsideDir = path.join(root, "outside-home");
    await mkdir(projectDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(path.dirname(homeDir), { recursive: true, force: true });
  });

  it("allows a relative path within the project root (cwd)", () => {
    const resolved = resolveAllowedPath(projectDir, "src/index.ts");
    expect(resolved).toBe(path.join(projectDir, "src/index.ts"));
  });

  it("allows an absolute path elsewhere under the user's home directory (e.g. the Desktop)", () => {
    const desktopPath = path.join(homeDir, "Bureau", "gestionnaire_taches", "main.py");
    expect(() => resolveAllowedPath(projectDir, desktopPath)).not.toThrow();
    expect(resolveAllowedPath(projectDir, desktopPath)).toBe(desktopPath);
  });

  it("rejects a path outside both the project root and the home directory", () => {
    const target = path.join(outsideDir, "secret.txt");
    expect(() => resolveAllowedPath(projectDir, target)).toThrow(/outside the project root/);
  });

  it("rejects a relative '../..' escape that lands outside the home directory", () => {
    expect(() => resolveAllowedPath(projectDir, "../../../../../../../etc/passwd")).toThrow(
      /outside the project root/,
    );
  });

  it("allows the home directory root itself", () => {
    expect(() => resolveAllowedPath(projectDir, homeDir)).not.toThrow();
  });
});
