import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";

// Each project is a real directory — the agent operates on it exactly the
// way it operates on any CLI project (same tools, same session-bucketing-
// by-cwd-hash in AgentSession, no new "virtual filesystem" abstraction).
// "default" is special-cased to the directory the web server was actually
// started against (FINANFA_WEB_CWD/process.cwd()) — the workspace that
// existed before Projects did, kept working unchanged.
export const DEFAULT_PROJECT_ID = "default";
export const PROJECTS_ROOT = path.join(os.homedir(), ".finanfa-code", "web-projects");

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
}

function indexPath(): string {
  return path.join(PROJECTS_ROOT, "index.json");
}

async function loadIndex(): Promise<ProjectMeta[]> {
  try {
    return JSON.parse(await readFile(indexPath(), "utf-8")) as ProjectMeta[];
  } catch {
    return [];
  }
}

async function saveIndex(list: ProjectMeta[]): Promise<void> {
  await mkdir(PROJECTS_ROOT, { recursive: true });
  await writeFile(indexPath(), JSON.stringify(list, null, 2), "utf-8");
}

export async function listProjects(defaultCwd: string): Promise<(ProjectMeta & { fileCount: number })[]> {
  const stored = await loadIndex();
  const withDefault: ProjectMeta[] = [{ id: DEFAULT_PROJECT_ID, name: path.basename(defaultCwd), createdAt: "" }, ...stored];
  return Promise.all(
    withDefault.map(async (p) => ({
      ...p,
      fileCount: await countFiles(resolveProjectDir(p.id, defaultCwd)).catch(() => 0),
    })),
  );
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".finanfa-code" || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else count++;
    }
  }
  await walk(dir);
  return count;
}

export async function createProject(name: string): Promise<ProjectMeta> {
  const id = randomUUID();
  const meta: ProjectMeta = { id, name: name.trim() || "Untitled project", createdAt: new Date().toISOString() };
  await mkdir(path.join(PROJECTS_ROOT, id), { recursive: true });
  const list = await loadIndex();
  list.unshift(meta);
  await saveIndex(list);
  return meta;
}

export async function deleteProject(id: string): Promise<void> {
  if (id === DEFAULT_PROJECT_ID) throw new Error("Cannot delete the default workspace.");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid project id.");
  const list = await loadIndex();
  const next = list.filter((p) => p.id !== id);
  await saveIndex(next);
  await rm(path.join(PROJECTS_ROOT, id), { recursive: true, force: true });
}

/** Real directory this project's agent operates on — always validated against a known project id first (see resolveCwd in index.ts), never built from raw untrusted input directly. */
export function resolveProjectDir(id: string, defaultCwd: string): string {
  if (id === DEFAULT_PROJECT_ID) return defaultCwd;
  return path.join(PROJECTS_ROOT, id);
}

export async function projectExists(id: string): Promise<boolean> {
  if (id === DEFAULT_PROJECT_ID) return true;
  try {
    const st = await stat(path.join(PROJECTS_ROOT, id));
    return st.isDirectory();
  } catch {
    return false;
  }
}
