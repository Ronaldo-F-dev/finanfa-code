import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadManagedSettings, resetManagedSettingsCacheForTests } from "../../src/core/managed-settings.js";
import { loadHooksConfig } from "../../src/hooks/config.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import { addMarketplace } from "../../src/plugins/manager.js";
import type { ToolDefinition } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(answer = "n"): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(answer),
    close: vi.fn(),
  };
}

const dangerous: ToolDefinition = { name: "wipe", description: "", riskLevel: "dangerous", inputSchema: { type: "object" }, handler: async () => ({ content: "", isError: false }) };
const hook = (command: string) => [{ hooks: [{ type: "command", command }] }];

const originalHome = process.env.HOME;
let dir: string;
let policyFile: string;

async function setPolicy(policy: unknown): Promise<void> {
  await writeFile(policyFile, typeof policy === "string" ? policy : JSON.stringify(policy));
  resetManagedSettingsCacheForTests();
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "finanfa-managed-"));
  process.env.HOME = dir;
  policyFile = path.join(dir, "managed-settings.json");
  process.env.FINANFA_MANAGED_SETTINGS = policyFile;
  resetManagedSettingsCacheForTests();
  await mkdir(path.join(dir, ".finanfa-code"), { recursive: true });
  await writeFile(path.join(dir, ".finanfa-code", "config.json"), JSON.stringify({ hooks: { PreToolUse: hook("user-hook") } }));
});

afterEach(() => {
  process.env.HOME = originalHome;
  delete process.env.FINANFA_MANAGED_SETTINGS;
  resetManagedSettingsCacheForTests();
});

describe("managed settings", () => {
  it("is empty when there is no managed file", () => {
    expect(loadManagedSettings()).toEqual({});
  });

  it("fails closed when the file exists but is not valid JSON", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await setPolicy("{ not json");
    expect(loadManagedSettings()).toEqual({ allowManagedHooksOnly: true, disableYolo: true, strictKnownMarketplaces: [] });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("strictest policy"));
    errorSpy.mockRestore();
  });

  it("ignores unknown events and wrong-typed fields", async () => {
    await setPolicy({ hooks: { PreToolUse: hook("a"), Bogus: hook("b") }, disableYolo: "yes", strictKnownMarketplaces: ["x", 3] });
    const settings = loadManagedSettings();
    expect(Object.keys(settings.hooks ?? {})).toEqual(["PreToolUse"]);
    expect(settings.disableYolo).toBeUndefined();
    expect(settings.strictKnownMarketplaces).toEqual(["x"]);
  });
});

describe("managed hooks", () => {
  it("run before the user's own hooks", async () => {
    await setPolicy({ hooks: { PreToolUse: hook("managed-hook") } });
    const config = await loadHooksConfig(dir);
    expect(config.PreToolUse?.map((m) => m.hooks[0].command)).toEqual(["managed-hook", "user-hook"]);
  });

  it("allowManagedHooksOnly drops the user's hooks entirely", async () => {
    await setPolicy({ hooks: { PreToolUse: hook("managed-hook") }, allowManagedHooksOnly: true });
    const config = await loadHooksConfig(dir);
    expect(config.PreToolUse?.map((m) => m.hooks[0].command)).toEqual(["managed-hook"]);
  });

  it("allowManagedHooksOnly without managed hooks means no hooks at all", async () => {
    await setPolicy({ allowManagedHooksOnly: true });
    expect(await loadHooksConfig(dir)).toEqual({});
  });
});

describe("disableYolo", () => {
  it("makes --yolo ask like normal, and says so", async () => {
    await setPolicy({ disableYolo: true });
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("--yolo is disabled"));
    const decision = await manager.check(dangerous, {}, { cwd: dir, sessionId: "s" } as never);
    expect(decision).toBe("deny");
    expect(ui.askUser).toHaveBeenCalled();
  });

  it("leaves --yolo alone without the policy", async () => {
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    expect(await manager.check(dangerous, {}, { cwd: dir, sessionId: "s" } as never)).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
  });
});

describe("strictKnownMarketplaces", () => {
  it("refuses a marketplace that is not on the list, and any when the list is empty", async () => {
    await setPolicy({ strictKnownMarketplaces: ["https://example.com/approved.git"] });
    await expect(addMarketplace("/some/dir")).rejects.toThrow(/only allow these marketplaces/);
    await setPolicy({ strictKnownMarketplaces: [] });
    await expect(addMarketplace("/some/dir")).rejects.toThrow(/forbid adding marketplaces/);
  });
});
