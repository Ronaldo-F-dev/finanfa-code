import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isUsableWorkspace, loadSettings, saveSettings } from "../src/settings.js";

async function tmpFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "finanfa-desktop-settings-")), "nested", "settings.json");
}

describe("desktop settings", () => {
  it("round-trips, creating missing directories", async () => {
    const file = await tmpFile();
    await saveSettings(file, { workspace: "/work", bounds: { width: 1000, height: 700, x: 10, y: 20, maximized: true } });
    expect(await loadSettings(file)).toEqual({ workspace: "/work", bounds: { width: 1000, height: 700, x: 10, y: 20, maximized: true } });
    expect(await readFile(file, "utf-8")).toContain('"workspace": "/work"');
  });

  it("returns empty settings for a missing, corrupt or wrongly-typed file instead of throwing", async () => {
    const file = await tmpFile();
    expect(await loadSettings(file)).toEqual({});
    await saveSettings(file, {});
    await writeFile(file, "{ not json");
    expect(await loadSettings(file)).toEqual({});
    await writeFile(file, JSON.stringify({ workspace: 42, bounds: "big" }));
    expect(await loadSettings(file)).toEqual({});
  });

  it("drops absurd window bounds (a window saved off-screen or tiny must not come back unusable)", async () => {
    const file = await tmpFile();
    await saveSettings(file, {}); // creates the directory
    await writeFile(file, JSON.stringify({ workspace: "/w", bounds: { width: 10, height: 10 } }));
    expect(await loadSettings(file)).toEqual({ workspace: "/w" });
  });
});

describe("isUsableWorkspace", () => {
  it("accepts a real project folder", () => {
    expect(isUsableWorkspace("/Users/me/Documents/project", "/var/folders/ab/xyz/T")).toBe(true);
    expect(isUsableWorkspace("/Users/me/Desktop/finanfa-code", "/tmp")).toBe(true);
  });

  it("refuses the OS temp directory itself and anything inside it, with or without macOS's /private prefix", () => {
    expect(isUsableWorkspace("/var/folders/ab/xyz/T/", "/var/folders/ab/xyz/T")).toBe(false);
    expect(isUsableWorkspace("/var/folders/ab/xyz/T/scratch", "/var/folders/ab/xyz/T")).toBe(false);
    expect(isUsableWorkspace("/private/var/folders/ab/xyz/T/scratch", "/var/folders/ab/xyz/T")).toBe(false);
    expect(isUsableWorkspace("/var/folders/ab/xyz/T/scratch", "/private/var/folders/ab/xyz/T")).toBe(false);
  });

  it("does not mistake a sibling whose name merely starts the same for the temp dir", () => {
    expect(isUsableWorkspace("/var/folders/ab/xyz/Tools", "/var/folders/ab/xyz/T")).toBe(true);
  });
});
