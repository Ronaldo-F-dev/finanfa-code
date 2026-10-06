import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSettings, saveSettings } from "../src/settings.js";

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
