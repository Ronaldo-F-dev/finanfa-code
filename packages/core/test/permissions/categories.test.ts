import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { APPROVAL_CATEGORIES, approvalCategoryOf, parseAutoApprove } from "../../src/permissions/categories.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG, loadPermissionConfig, type PermissionConfig } from "../../src/permissions/config.js";
import { resetManagedSettingsCacheForTests } from "../../src/core/managed-settings.js";
import type { ToolDefinition } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

const tool = (name: string, riskLevel: ToolDefinition["riskLevel"] = "ask"): ToolDefinition => ({
  name,
  description: "",
  riskLevel,
  inputSchema: { type: "object" },
  handler: async () => ({ content: "", isError: false }),
});

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

const ctx = { cwd: "/tmp", sessionId: "s" } as never;
const config = (overrides: Partial<PermissionConfig> = {}): PermissionConfig => ({ ...DEFAULT_PERMISSION_CONFIG, ...overrides });

describe("approvalCategoryOf", () => {
  it("puts file-editing tools in edits, local command runners in terminal, MCP tools in mcp", () => {
    expect(approvalCategoryOf("write_file")).toBe("edits");
    expect(approvalCategoryOf("edit_file")).toBe("edits");
    expect(approvalCategoryOf("multi_edit_file")).toBe("edits");
    expect(approvalCategoryOf("bash")).toBe("terminal");
    expect(approvalCategoryOf("python_repl")).toBe("terminal");
    expect(approvalCategoryOf("mcp__github__create_issue")).toBe("mcp");
  });

  it("leaves every other tool uncategorised — remote, network, git and deployment tools stay on their own", () => {
    for (const name of ["git_push", "run_remote_command", "send_email", "terraform_apply", "remote_deploy_release", "read_file", "http_request", "docker_compose"]) {
      expect(approvalCategoryOf(name), name).toBeUndefined();
    }
  });
});

describe("parseAutoApprove", () => {
  it("keeps known categories with real booleans and drops everything else", () => {
    expect(parseAutoApprove({ edits: true, terminal: false, mcp: "yes", bogus: true, nested: { edits: true } })).toEqual({ edits: true, terminal: false });
    expect(parseAutoApprove(undefined)).toEqual({});
    expect(parseAutoApprove("edits")).toEqual({});
    expect(parseAutoApprove(null)).toEqual({});
  });
});

describe("PermissionManager: category auto-approval", () => {
  it("approves only the switched-on category, and still asks for the rest", async () => {
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: config({ autoApprove: { edits: true } }), ui });
    expect(await manager.check(tool("edit_file"), {}, ctx)).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
    expect(await manager.check(tool("bash", "dangerous"), {}, ctx)).toBe("deny"); // asked, answered "n"
    expect(ui.askUser).toHaveBeenCalledTimes(1);
    expect(await manager.check(tool("git_push"), {}, ctx)).toBe("deny"); // uncategorised
  });

  it("covers MCP tools and the terminal when switched on", async () => {
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: config({ autoApprove: { mcp: true, terminal: true } }), ui });
    expect(await manager.check(tool("mcp__srv__do_thing"), {}, ctx)).toBe("allow");
    expect(await manager.check(tool("bash", "dangerous"), {}, ctx)).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
  });

  it("is switched on and off at runtime", async () => {
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: config(), ui });
    expect(await manager.check(tool("write_file"), {}, ctx)).toBe("deny");
    expect(manager.setAutoApprove("edits", true)).toBe(true);
    expect(manager.getAutoApprove()).toEqual({ edits: true });
    expect(await manager.check(tool("write_file"), {}, ctx)).toBe("allow");
    manager.setAutoApprove("edits", false);
    expect(await manager.check(tool("write_file"), {}, ctx)).toBe("deny");
  });

  it("never lets an explicit rule for the tool be overridden — deny, ask and allow all win over the category", async () => {
    const rules = (decision: "allow" | "ask" | "deny") => config({ autoApprove: { edits: true }, rules: [{ tool: "write_file", decision }] });
    expect(await new PermissionManager({ config: rules("deny"), ui: makeUi("y") }).check(tool("write_file"), {}, ctx)).toBe("deny");
    const askUi = makeUi("n");
    expect(await new PermissionManager({ config: rules("ask"), ui: askUi }).check(tool("write_file"), {}, ctx)).toBe("deny");
    expect(askUi.askUser).toHaveBeenCalled(); // the explicit "ask" was honoured
    expect(await new PermissionManager({ config: rules("allow"), ui: makeUi("n") }).check(tool("write_file"), {}, ctx)).toBe("allow");
  });

  it("does not override a PreToolUse hook that blocks", async () => {
    const hooksConfig = { PreToolUse: [{ hooks: [{ type: "command" as const, command: "cat >/dev/null; echo blocked >&2; exit 2" }] }] };
    const manager = new PermissionManager({ config: config({ autoApprove: { edits: true } }), ui: makeUi("y"), hooksConfig });
    expect(await manager.check(tool("edit_file"), {}, ctx)).toBe("deny");
  });

  it("rejects an unknown category", () => {
    const manager = new PermissionManager({ config: config(), ui: makeUi() });
    expect(manager.setAutoApprove("everything" as never, true)).toBe(false);
    expect(manager.getAutoApprove()).toEqual({});
  });

  it("knows exactly the categories it advertises", () => {
    expect([...APPROVAL_CATEGORIES]).toEqual(["edits", "terminal", "mcp"]);
  });
});

describe("loading and policy", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let project: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "finanfa-cat-home-"));
    project = await mkdtemp(path.join(tmpdir(), "finanfa-cat-project-"));
    process.env.HOME = home;
    resetManagedSettingsCacheForTests();
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.FINANFA_MANAGED_SETTINGS;
    resetManagedSettingsCacheForTests();
  });

  async function writeJson(file: string, value: unknown) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }

  it("reads autoApprove from the user's global config only — a project's settings.json can't switch prompts off", async () => {
    await writeJson(path.join(home, ".finanfa-code", "config.json"), { autoApprove: { edits: true } });
    await writeJson(path.join(project, ".finanfa-code", "settings.json"), { autoApprove: { terminal: true, mcp: true } });
    expect((await loadPermissionConfig(project, true)).autoApprove).toEqual({ edits: true });
  });

  it("is empty when nothing is configured", async () => {
    expect((await loadPermissionConfig(project)).autoApprove).toEqual({});
  });

  it("is refused outright when managed settings set disableYolo", async () => {
    const policy = path.join(home, "managed.json");
    await writeFile(policy, JSON.stringify({ disableYolo: true }));
    process.env.FINANFA_MANAGED_SETTINGS = policy;
    resetManagedSettingsCacheForTests();
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: config({ autoApprove: { edits: true } }), ui });
    expect(manager.isAutoApproveForbidden()).toBe(true);
    expect(manager.getAutoApprove()).toEqual({});
    expect(manager.setAutoApprove("edits", true)).toBe(false);
    expect(await manager.check(tool("edit_file"), {}, ctx)).toBe("deny"); // asked, not auto-approved
    expect(ui.askUser).toHaveBeenCalled();
  });
});
