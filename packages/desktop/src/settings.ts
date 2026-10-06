import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface DesktopSettings {
  workspace?: string;
  bounds?: WindowBounds;
}

/**
 * Whether a remembered workspace may be reused as is. A folder inside the OS temp directory never is: nobody
 * picks it as the place their agent should work, it only gets there by accident (a test run, a script) — and
 * the agent would then read and write in a directory the system cleans up. The app asks again instead.
 */
export function isUsableWorkspace(dir: string, tmpDir: string): boolean {
  const strip = (p: string) => path.resolve(p).replace(/^\/private(?=\/)/, "");
  const target = strip(dir);
  const tmp = strip(tmpDir);
  return !(target === tmp || target.startsWith(tmp + path.sep));
}

/**
 * Where the agent works when nobody chose a folder: a visible, ordinary folder in the home directory (not a hidden
 * one, so its files can be found; not Documents or Desktop, where macOS interrupts the first run with a permission
 * prompt). Created on first launch, so the app opens straight into a working state.
 */
export function defaultWorkspace(home: string): string {
  return path.join(home, "Finanfa");
}

/** "/Users/me/Finanfa" -> "~/Finanfa" for display. */
export function displayPath(p: string, home: string): string {
  const resolved = path.resolve(p);
  const base = path.resolve(home);
  if (resolved === base) return "~";
  return resolved.startsWith(base + path.sep) ? `~${resolved.slice(base.length)}` : resolved;
}

export const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 860 };

/** Reads settings, tolerating a missing, corrupt or wrongly-typed file (a bad settings file must never stop the app from opening). */
export async function loadSettings(file: string): Promise<DesktopSettings> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
    const settings: DesktopSettings = {};
    if (typeof parsed.workspace === "string" && parsed.workspace) settings.workspace = parsed.workspace;
    const b = parsed.bounds as Partial<WindowBounds> | undefined;
    if (b && Number.isFinite(b.width) && Number.isFinite(b.height) && (b.width as number) >= 400 && (b.height as number) >= 300) {
      settings.bounds = {
        width: b.width as number,
        height: b.height as number,
        x: Number.isFinite(b.x) ? b.x : undefined,
        y: Number.isFinite(b.y) ? b.y : undefined,
        maximized: b.maximized === true,
      };
    }
    return settings;
  } catch {
    return {};
  }
}

/** Written to a temp file and renamed, so a crash mid-write can't leave a half-written settings file. */
export async function saveSettings(file: string, settings: DesktopSettings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), "utf-8");
  await rename(tmp, file);
}
