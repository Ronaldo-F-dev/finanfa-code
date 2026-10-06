import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { globalConfigPath, updateGlobalConfig } from "../../src/core/config.js";

const originalHome = process.env.HOME;
beforeEach(async () => {
  process.env.HOME = await mkdtemp(path.join(tmpdir(), "finanfa-cfg-update-"));
});
afterEach(() => {
  process.env.HOME = originalHome;
});

describe("updateGlobalConfig", () => {
  it("creates the file (owner-only) when there is none", async () => {
    await updateGlobalConfig({ autoApprove: { edits: true } });
    expect(JSON.parse(await readFile(globalConfigPath(), "utf-8"))).toEqual({ autoApprove: { edits: true } });
    expect((await stat(globalConfigPath())).mode & 0o777).toBe(0o600);
  });

  it("changes only the given keys and keeps everything else — rules, hooks, keys it doesn't know", async () => {
    await mkdir(path.dirname(globalConfigPath()), { recursive: true });
    const existing = { model: "m", rules: [{ tool: "bash", decision: "ask" }], hooks: { Stop: [] }, someFutureKey: { nested: 1 }, autoApprove: { terminal: true } };
    await writeFile(globalConfigPath(), JSON.stringify(existing));
    await updateGlobalConfig({ autoApprove: { edits: true } });
    expect(JSON.parse(await readFile(globalConfigPath(), "utf-8"))).toEqual({ ...existing, autoApprove: { edits: true } });
  });

  it("refuses to overwrite a file it can't parse, and leaves it untouched", async () => {
    await mkdir(path.dirname(globalConfigPath()), { recursive: true });
    await writeFile(globalConfigPath(), "{ not json, but the user's own work");
    await expect(updateGlobalConfig({ autoApprove: {} })).rejects.toThrow(/could not be read as JSON/);
    expect(await readFile(globalConfigPath(), "utf-8")).toBe("{ not json, but the user's own work");
  });
});
